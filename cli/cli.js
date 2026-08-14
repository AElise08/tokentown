#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// TOKENTOWN — `npx tokentown`
// Lightweight onboarding (no app to install): reads your REAL Claude Code token
// usage on this machine and reports the season's numbers to the leaderboard at
// https://tokentown-gamma.vercel.app. Only your username and the numbers are
// ever sent — never prompts, code, conversation content, or project names.
//
// Zero runtime dependencies. Node 18+ (global fetch, readline, crypto).
//
// The reading logic here is a standalone port of game/main.js (dedupe by
// message.id:requestId, per-season backfill by timestamp, tokens = input +
// output + cache_creation, honest cost via per-model pricing, subagents as
// residents, 7-day daily breakdown, "used-only" setup blob). The payload
// shaping mirrors client/placar.js (shapeCity / shapeSetup / shapeDailyTokens /
// shapeProfile) so the wire contract is identical to the desktop app's.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const childProcess = require("child_process");

const DEFAULT_URL = "https://tokentown-gamma.vercel.app/api/report";
const SITE_ORIGIN = "https://tokentown-gamma.vercel.app";

function usagePaths(home) {
  home = home || os.homedir();
  return {
    claude: path.join(home, ".claude", "projects"),
    codex: path.join(home, ".codex", "sessions"),
    opencode: path.join(home, ".local", "share", "opencode", "opencode.db"),
  };
}

// Config path — overridable via env for testability (never touches the real
// ~/.tokentown-placar.json when TOKENTOWN_CONFIG points elsewhere).
function configPath() {
  return process.env.TOKENTOWN_CONFIG || path.join(os.homedir(), ".tokentown-placar.json");
}

// ---------------------------------------------------------------------------
// SEASONS — fixed 28-day windows on a global calendar (same formula as the app
// and the server; keep in sync). Epoch: 01/07/2026 00:00 UTC.
// ---------------------------------------------------------------------------
const SEASON_EPOCH = Date.UTC(2026, 6, 1);
const SEASON_MS = 28 * 86400000;
const TOK_PER_BUILD_REAL = 6000; // one building per ~6k real tokens
const ERA_STEP = 2000000; // era changes every ~2M tokens

function currentSeasonId(now) {
  return Math.floor(((now || Date.now()) - SEASON_EPOCH) / SEASON_MS);
}
function daysLeftIn(now) {
  now = now || Date.now();
  const end = SEASON_EPOCH + (currentSeasonId(now) + 1) * SEASON_MS;
  return Math.max(0, Math.ceil((end - now) / 86400000));
}

// ---------------------------------------------------------------------------
// PRICING — USD per 1M tokens from the providers' official pricing pages.
// input = uncached
// input; output = generation. Cache multipliers over INPUT price: read = 0.10x,
// 5-min write = 1.25x, 1-hour write = 2.00x. Opus 4.8 keeps the standard table
// for its 1M window, so the "[1m]" suffix uses the same prices.
// ---------------------------------------------------------------------------
const PRICING = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const SONNET_PRICE = { in: 3, out: 15 }; // unknown model -> approximate as Sonnet
const SONNET_5_STANDARD_AT = Date.UTC(2026, 8, 1); // introductory $2/$10 ends 2026-08-31

// OpenAI API-equivalent prices per 1M tokens. Codex can be used through a
// subscription, so this is deliberately labeled as an estimate rather than an
// amount charged to the user's account. Source: official OpenAI pricing docs,
// checked 2026-08-14. `write` is the prompt-cache write rate when available.
const OPENAI_PRICING = {
  "gpt-5.6-sol": { in: 5, cached: 0.5, write: 6.25, out: 30 },
  "gpt-5.6-terra": { in: 2.5, cached: 0.25, write: 3.125, out: 15 },
  "gpt-5.6-luna": { in: 1, cached: 0.1, write: 1.25, out: 6 },
  "gpt-5.3-codex": { in: 1.75, cached: 0.175, write: 1.75, out: 14 },
  "gpt-5.2-codex": { in: 1.75, cached: 0.175, write: 1.75, out: 14 },
  "gpt-5.1-codex": { in: 1.25, cached: 0.125, write: 1.25, out: 10 },
  "gpt-5-codex": { in: 1.25, cached: 0.125, write: 1.25, out: 10 },
  "gpt-5.2": { in: 1.75, cached: 0.175, write: 1.75, out: 14 },
  "gpt-5.1": { in: 1.25, cached: 0.125, write: 1.25, out: 10 },
  "gpt-5": { in: 1.25, cached: 0.125, write: 1.25, out: 10 },
};
const OPENAI_FALLBACK_PRICE = { in: 1.25, cached: 0.125, write: 1.25, out: 10 };

function priceFor(model, at) {
  if (!model) return SONNET_PRICE;
  let m = String(model).toLowerCase();
  if (m === "<synthetic>") return { in: 0, out: 0 }; // local message, no API cost
  m = m.replace(/\[1m\]$/, ""); // drop long-context marker
  m = m.replace(/-\d{8}$/, ""); // drop date suffix (e.g. -20251001)
  if (m === "claude-sonnet-5" || m === "sonnet-5")
    return (at || Date.now()) < SONNET_5_STANDARD_AT ? { in: 2, out: 10 } : { in: 3, out: 15 };
  if (PRICING[m]) return PRICING[m];
  if (m === "opus" || m.startsWith("claude-opus")) return { in: 5, out: 25 };
  if (m === "fable" || m.startsWith("claude-fable") || m.startsWith("claude-mythos")) return { in: 10, out: 50 };
  if (m === "sonnet" || m.startsWith("claude-sonnet")) return { in: 3, out: 15 };
  if (m === "haiku" || m.startsWith("claude-haiku")) return { in: 1, out: 5 };
  return SONNET_PRICE;
}

function normalizeOpenAIModel(model) {
  let m = String(model || "").trim().toLowerCase();
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  return m;
}

function openAIPriceFor(model) {
  const m = normalizeOpenAIModel(model);
  if (OPENAI_PRICING[m]) return OPENAI_PRICING[m];
  if (/^gpt-5\.6-sol/.test(m)) return OPENAI_PRICING["gpt-5.6-sol"];
  if (/^gpt-5\.6-terra/.test(m)) return OPENAI_PRICING["gpt-5.6-terra"];
  if (/^gpt-5\.6-luna/.test(m)) return OPENAI_PRICING["gpt-5.6-luna"];
  if (/^gpt-5\.3-codex/.test(m)) return OPENAI_PRICING["gpt-5.3-codex"];
  if (/^gpt-5\.2-codex/.test(m)) return OPENAI_PRICING["gpt-5.2-codex"];
  if (/^gpt-5\.1-codex/.test(m)) return OPENAI_PRICING["gpt-5.1-codex"];
  if (/^gpt-5-codex/.test(m)) return OPENAI_PRICING["gpt-5-codex"];
  return OPENAI_FALLBACK_PRICE;
}

function openAICostFromUsage(usage, model) {
  usage = usage || {};
  const p = openAIPriceFor(model);
  const input = Math.max(0, Number(usage.input_tokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage.cached_input_tokens) || 0));
  const writes = Math.min(input - cached, Math.max(0, Number(usage.cache_write_input_tokens) || 0));
  const uncached = Math.max(0, input - cached - writes);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  return (uncached * p.in + cached * p.cached + writes * p.write + output * p.out) / 1e6;
}

// tokens that raise buildings: newly generated content (uncached input + output
// + newly written cache). Ignores cache_read (cheap, huge re-reads).
function tokensFromUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// honest USD cost of one usage line — every field (input, output, cache write,
// cache read) with real per-model pricing.
function costFromUsage(u, model, at) {
  if (!u) return 0;
  const p = priceFor(model, at);
  if (!p.in && !p.out) return 0; // <synthetic>
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const readTok = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation;
  let w5 = 0,
    w1 = 0; // cache write: 5-min vs 1-hour
  if (cc && ((cc.ephemeral_1h_input_tokens || 0) + (cc.ephemeral_5m_input_tokens || 0)) > 0) {
    w1 = cc.ephemeral_1h_input_tokens || 0;
    w5 = cc.ephemeral_5m_input_tokens || 0;
  } else {
    w5 = u.cache_creation_input_tokens || 0; // no breakdown -> treat as 5-min (1.25x)
  }
  return (
    (inTok * p.in + outTok * p.out + readTok * p.in * 0.1 + w5 * p.in * 1.25 + w1 * p.in * 2.0) / 1e6
  );
}

// ---------------------------------------------------------------------------
// DEDUPE — Claude Code writes the SAME assistant message across several lines
// (streaming/retry), each with identical usage. Counting every line doubles
// everything. Sets with a memory cap (FIFO eviction); duplicates are local
// (consecutive lines), so eviction never re-counts far-apart duplicates.
// ---------------------------------------------------------------------------
const USAGE_CAP = 5000;
const AGENT_CAP = 5000;
const TOOLS_CAP = 20000;

function remember(set, key, cap) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > cap) {
    const first = set.values().next().value;
    set.delete(first);
  }
  return true;
}

// subagents = tool_use blocks named "Agent" (or the older "Task"), deduped by
// the block id. Returns how many are NEW.
function countNewSubagents(o, seenAgents) {
  const c = o && o.message && o.message.content;
  let k = 0;
  if (Array.isArray(c))
    for (const b of c) {
      if (b && b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        if (b.id != null) {
          if (remember(seenAgents, b.id, AGENT_CAP)) k++;
        } else k++;
      }
    }
  return k;
}

function listJsonl(dir, acc) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// DAILY BREAKDOWN — bucketize city-tokens by UTC day over the last 7 UTC days.
// ---------------------------------------------------------------------------
const DAILY_WINDOW_DAYS = 7;
const DAY_MS = 86400000;

function utcDayKeyMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return "" + y + mo + da;
}
function utcMidnightMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function dailyWindowStartMs(now) {
  return utcMidnightMs(now) - (DAILY_WINDOW_DAYS - 1) * DAY_MS;
}
function dailyBucketize(entries, now) {
  const startMs = dailyWindowStartMs(now);
  const out = {};
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (!e || !Number.isFinite(e.ts)) continue;
    if (e.ts < startMs) continue;
    const k = utcDayKeyMs(e.ts);
    out[k] = (out[k] || 0) + (Number(e.tokens) || 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SETUP → CITY — collect the LOCAL setup (names & counts only) for the opt-in
// "how this city was built" panel. NEVER prompts/code/content/paths — only
// names of skills/MCP/hooks and tool/model counts. Skills & MCP reflect what
// you REALLY USED this season (invocations in the transcripts), not what's
// merely installed. Ported from game/main.js.
// ---------------------------------------------------------------------------
const SETUP_V = 1;

function normModelSlug(model) {
  if (!model) return null;
  let s = String(model).toLowerCase();
  if (s === "<synthetic>") return null;
  s = s.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "").replace(/^claude-/, "");
  return s || null;
}

// modelTally: model -> city-tokens. Needs the usage tokens + usage dedupe.
function tallyForSetup(o, u, modelTally) {
  const md = normModelSlug(o && o.message && o.message.model);
  if (md) modelTally.set(md, (modelTally.get(md) || 0) + tokensFromUsage(u));
}

// tallyTools: count tool_use invocations for the setup (toolTally + skillTally),
// deduped by the tool_use block id (independent of the usage dedupe).
function tallyTools(o, seenTools, toolTally, skillTally) {
  const c = o && o.message && o.message.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || b.type !== "tool_use" || !b.name) continue;
    if (b.id != null && !remember(seenTools, b.id, TOOLS_CAP)) continue;
    toolTally.set(b.name, (toolTally.get(b.name) || 0) + 1);
    if (b.name === "Skill" && b.input && b.input.skill) {
      const sk = String(b.input.skill);
      if (sk) skillTally.set(sk, (skillTally.get(sk) || 0) + 1);
    }
  }
}

function setupSlugStrict(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
function setupToolName(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]+/g, "").slice(0, 48);
}
function uniq(a) {
  const seen = new Set(),
    out = [];
  for (const x of a) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

// collectSetup — { v, skills, mcp, hooks, tools, models }. skills/mcp reflect
// what was really USED this season; hooks come from ~/.claude/settings.json.
function collectSetup(opts) {
  opts = opts || {};
  const home = opts.home || os.homedir();
  const settingsJson = "settingsJson" in opts ? opts.settingsJson : path.join(home, ".claude", "settings.json");
  const tools = opts.toolTally || new Map();
  const models = opts.modelTally || new Map();
  const skillsUsed = opts.skillTally || new Map();

  const skills = uniq(
    Array.from(skillsUsed.entries())
      .filter((e) => e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .map((e) => setupSlugStrict(e[0]))
      .filter(Boolean)
  ).slice(0, 40);

  const mcpCounts = new Map();
  for (const e of tools.entries()) {
    const mm = /^mcp__(.+?)__/.exec(String(e[0]));
    if (mm) mcpCounts.set(mm[1], (mcpCounts.get(mm[1]) || 0) + Math.max(0, Number(e[1]) || 0));
  }
  const mcp = uniq(
    Array.from(mcpCounts.entries())
      .filter((e) => e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .map((e) => setupSlugStrict(e[0]))
      .filter(Boolean)
  ).slice(0, 20);

  let hooks = [];
  const sj = settingsJson ? readJsonSafe(settingsJson) : null;
  if (sj && sj.hooks && typeof sj.hooks === "object") hooks = uniq(Object.keys(sj.hooks).map(setupSlugStrict)).slice(0, 12);

  const toolsArr = Array.from(tools.entries())
    .map((e) => [setupToolName(e[0]), Math.max(0, Math.floor(Number(e[1]) || 0))])
    .filter((p) => p[0] && p[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  let total = 0;
  for (const v of models.values()) if (v > 0) total += v;
  let modelsArr = [];
  if (total > 0) {
    modelsArr = Array.from(models.entries())
      .filter((e) => e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map((e) => [setupSlugStrict(e[0]), Math.round((e[1] / total) * 1e4) / 1e4])
      .filter((p) => p[0] && p[1] > 0);
  }

  return { v: SETUP_V, skills, mcp, hooks, tools: toolsArr, models: modelsArr };
}

// ---------------------------------------------------------------------------
// MULTI-PROVIDER SEASON READ
//
// Claude Code: ~/.claude/projects/**/*.jsonl
// Codex:       ~/.codex/sessions/**/*.jsonl
// OpenCode:    ~/.local/share/opencode/opencode.db
//
// Only timestamps, usage counters, model/provider ids and tool names are read.
// Prompt/message/code fields are never copied into the aggregate or payload.
// Every run performs a full season backfill, so one-shot scheduled execution is
// as correct as watch mode and never depends on offsets from a prior process.
// ---------------------------------------------------------------------------
function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function usageDelta(total, prev) {
  total = total || {};
  prev = prev || {};
  const out = {};
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    const cur = Math.max(0, Number(total[key]) || 0);
    const old = Math.max(0, Number(prev[key]) || 0);
    out[key] = cur >= old ? cur - old : cur; // cumulative counter reset -> new baseline
  }
  return out;
}

function createAggregate() {
  return {
    tokens: 0,
    cost: 0,
    residents: 0,
    dailyEntries: [],
    toolTally: new Map(),
    modelTally: new Map(),
    skillTally: new Map(),
    modelBreakdown: new Map(),
    sources: { claude: 0, codex: 0, opencode: 0 },
    filesScanned: 0,
  };
}

function addCount(map, key, amount) {
  if (!key || !(amount > 0)) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function recordUsage(agg, row) {
  const tokens = Math.max(0, Number(row.tokens) || 0);
  const cost = Math.max(0, Number(row.cost) || 0);
  const model = String(row.model || "unknown").trim().toLowerCase() || "unknown";
  const provider = String(row.provider || "unknown").trim().toLowerCase() || "unknown";
  agg.tokens += tokens;
  agg.cost += cost;
  addCount(agg.modelTally, model, tokens);
  if (row.ts >= row.dailyStart && tokens > 0) agg.dailyEntries.push({ ts: row.ts, tokens: tokens });

  const key = provider + "/" + model;
  const b = agg.modelBreakdown.get(key) || {
    provider,
    model,
    tokens: 0,
    cost: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };
  b.tokens += tokens;
  b.cost += cost;
  b.input += Math.max(0, Number(row.input) || 0);
  b.cached += Math.max(0, Number(row.cached) || 0);
  b.cacheWrite += Math.max(0, Number(row.cacheWrite) || 0);
  b.output += Math.max(0, Number(row.output) || 0);
  b.reasoning += Math.max(0, Number(row.reasoning) || 0);
  agg.modelBreakdown.set(key, b);
}

function scanClaude(agg, root, seasonStart, now, dailyStart) {
  const seenUsage = new Set();
  const seenAgents = new Set();
  const seenTools = new Set();
  const files = listJsonl(root, []);
  agg.filesScanned += files.length;
  let used = 0;

  for (const f of files) {
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch (e) {
      continue;
    }
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) continue;
    for (const line of buf.slice(0, nl).toString("utf8").split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const ts = parseTimestamp(o.timestamp);
      if (!(ts >= seasonStart && ts <= now)) continue;
      const u = o.message && o.message.usage;
      if (u) {
        const mid = o.message && o.message.id;
        const rid = o.requestId;
        let counted = true;
        if (mid != null && rid != null) counted = remember(seenUsage, mid + ":" + rid, USAGE_CAP);
        if (counted) {
          const lineTk = tokensFromUsage(u);
          recordUsage(agg, {
            provider: "claude",
            model: (o.message && o.message.model) || "claude-unknown",
            tokens: lineTk,
            cost: costFromUsage(u, o.message && o.message.model, ts),
            input: u.input_tokens,
            cached: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
            output: u.output_tokens,
            reasoning: 0,
            ts,
            dailyStart,
          });
          used++;
        }
      }
      tallyTools(o, seenTools, agg.toolTally, agg.skillTally);
      agg.residents += countNewSubagents(o, seenAgents);
    }
  }
  agg.sources.claude = used;
}

function isCodexSubagentSource(source) {
  return !!(source && typeof source === "object" && source.subagent);
}

function scanCodex(agg, root, seasonStart, now, dailyStart) {
  const files = listJsonl(root, []);
  agg.filesScanned += files.length;
  let usedSessions = 0;

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      continue;
    }
    let currentModel = "codex-unknown";
    let previousTotal = {};
    let subagent = false;
    let sessionUsed = false;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const p = o.payload || {};
      const ts = parseTimestamp(o.timestamp || p.timestamp);
      if (o.type === "session_meta") subagent = isCodexSubagentSource(p.source);
      if (o.type === "turn_context" && p.model) currentModel = String(p.model);

      if (o.type === "response_item" && ts >= seasonStart && ts <= now && p.type === "function_call") {
        addCount(agg.toolTally, setupToolName(p.name), 1);
        if (p.name === "Skill" && typeof p.arguments === "string") {
          try {
            const args = JSON.parse(p.arguments);
            if (args && args.skill) addCount(agg.skillTally, String(args.skill), 1);
          } catch (e) {}
        }
      }

      if (o.type !== "event_msg" || p.type !== "token_count" || !p.info || !p.info.total_token_usage) continue;
      const total = p.info.total_token_usage;
      const d = usageDelta(total, previousTotal);
      previousTotal = total;
      if (!(ts >= seasonStart && ts <= now)) continue;
      const input = Math.max(0, Number(d.input_tokens) || 0);
      const cached = Math.min(input, Math.max(0, Number(d.cached_input_tokens) || 0));
      const cacheWrite = Math.min(input - cached, Math.max(0, Number(d.cache_write_input_tokens) || 0));
      const output = Math.max(0, Number(d.output_tokens) || 0);
      const cityTokens = Math.max(0, input - cached) + output;
      if (cityTokens <= 0 && input <= 0 && output <= 0) continue;
      recordUsage(agg, {
        provider: "codex",
        model: currentModel,
        tokens: cityTokens,
        cost: openAICostFromUsage(d, currentModel),
        input,
        cached,
        cacheWrite,
        output,
        reasoning: d.reasoning_output_tokens,
        ts,
        dailyStart,
      });
      sessionUsed = true;
    }
    if (sessionUsed) {
      usedSessions++;
      if (subagent) agg.residents++;
    }
  }
  agg.sources.codex = usedSessions;
}

function sqliteRows(sqliteBin, db, sql) {
  if (!db || !fs.existsSync(db)) return null;
  const r = childProcess.spawnSync(sqliteBin || "sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || "[]");
  } catch (e) {
    return null;
  }
}

function scanOpenCode(agg, db, seasonStart, now, dailyStart, sqliteBin) {
  if (!db || !fs.existsSync(db)) return;
  const rows = sqliteRows(
    sqliteBin,
    db,
    "select time_created as ts," +
      " coalesce(json_extract(data,'$.providerID'),'opencode') as provider," +
      " coalesce(json_extract(data,'$.modelID'),'unknown') as model," +
      " coalesce(json_extract(data,'$.cost'),0) as cost," +
      " coalesce(json_extract(data,'$.tokens.input'),0) as input," +
      " coalesce(json_extract(data,'$.tokens.output'),0) as output," +
      " coalesce(json_extract(data,'$.tokens.reasoning'),0) as reasoning," +
      " coalesce(json_extract(data,'$.tokens.cache.read'),0) as cached," +
      " coalesce(json_extract(data,'$.tokens.cache.write'),0) as cache_write" +
      " from message where json_extract(data,'$.role')='assistant'" +
      " and time_created >= " + Math.floor(seasonStart) +
      " and time_created <= " + Math.floor(now)
  );
  if (!rows) return;
  agg.filesScanned += 1;
  for (const row of rows) {
    const input = Math.max(0, Number(row.input) || 0);
    const output = Math.max(0, Number(row.output) || 0);
    const reasoning = Math.max(0, Number(row.reasoning) || 0);
    const cached = Math.max(0, Number(row.cached) || 0);
    const cacheWrite = Math.max(0, Number(row.cache_write) || 0);
    const cityTokens = input + output + reasoning + cacheWrite;
    const provider = String(row.provider || "unknown").toLowerCase();
    const storedCost = Math.max(0, Number(row.cost) || 0);
    // OpenCode records provider-native cost when it has one. Some OpenAI
    // subscription/auth paths expose token counts but leave cost at zero; in
    // that case report an API-equivalent estimate from the official table.
    const rowCost =
      storedCost > 0 || provider !== "openai"
        ? storedCost
        : openAICostFromUsage(
            {
              input_tokens: input + cached + cacheWrite,
              cached_input_tokens: cached,
              cache_write_input_tokens: cacheWrite,
              output_tokens: output + reasoning,
            },
            row.model
          );
    recordUsage(agg, {
      provider: "opencode:" + provider,
      model: row.model,
      tokens: cityTokens,
      cost: rowCost,
      input,
      cached,
      cacheWrite,
      output,
      reasoning,
      ts: parseTimestamp(row.ts),
      dailyStart,
    });
  }

  const agents = sqliteRows(
    sqliteBin,
    db,
    "select count(*) as n from session where parent_id is not null" +
      " and time_updated >= " + Math.floor(seasonStart) +
      " and time_created <= " + Math.floor(now)
  );
  if (agents && agents[0]) agg.residents += Math.max(0, Number(agents[0].n) || 0);

  const tools = sqliteRows(
    sqliteBin,
    db,
    "select coalesce(json_extract(data,'$.tool'),'tool') as name, count(*) as n" +
      " from part where json_extract(data,'$.type')='tool'" +
      " and time_created >= " + Math.floor(seasonStart) +
      " and time_created <= " + Math.floor(now) +
      " group by name"
  );
  if (tools) for (const t of tools) addCount(agg.toolTally, setupToolName(t.name), Number(t.n) || 0);
  agg.sources.opencode = rows.length;
}

function readSeason(now, opts) {
  now = now || Date.now();
  opts = opts || {};
  const seasonId = currentSeasonId(now);
  const seasonStart = SEASON_EPOCH + seasonId * SEASON_MS;
  const dailyStart = dailyWindowStartMs(now);
  const paths = usagePaths(opts.home);
  const agg = createAggregate();

  if (opts.claude !== false) scanClaude(agg, opts.claudePath || paths.claude, seasonStart, now, dailyStart);
  if (opts.codex !== false) scanCodex(agg, opts.codexPath || paths.codex, seasonStart, now, dailyStart);
  if (opts.opencode !== false)
    scanOpenCode(agg, opts.opencodePath || paths.opencode, seasonStart, now, dailyStart, opts.sqliteBin);

  const daily = dailyBucketize(agg.dailyEntries, now);
  const setup = collectSetup({ toolTally: agg.toolTally, modelTally: agg.modelTally, skillTally: agg.skillTally });
  const modelBreakdown = Array.from(agg.modelBreakdown.values()).sort(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model)
  );
  const buildings = 2 + Math.floor(agg.tokens / TOK_PER_BUILD_REAL);
  return {
    seasonId,
    tokens: agg.tokens,
    cost: agg.cost,
    residents: agg.residents,
    buildings,
    daily,
    setup,
    modelBreakdown,
    sources: agg.sources,
    filesScanned: agg.filesScanned,
    daysLeft: daysLeftIn(now),
  };
}

// ---------------------------------------------------------------------------
// CITY BLOB — a deterministic, honest portrait built from the numbers alone
// (no game simulation, no localStorage). Same shape as the app sends:
//   { v:1, seed, buildings, pop, types, marcos, era }
//   - seed:   FNV-1a hash of the username (same seed the site's fallback uses,
//             so the skyline layout is stable and recognizable per user).
//   - buildings: 2 + floor(tokens / 6000) — same as the report body.
//   - pop:    faithful sum of the game's per-building population model
//             (game.js popForNormal), which drives how "lived-in" (lit) the
//             skyline looks. Specials pop is omitted (the CLI places no
//             specials), so types stays empty.
//   - marcos: unlocked purely by token thresholds, exactly like the game
//             (garden 100k, ferry 300k, lighthouse 1M, towers 3M).
//   - era:    floor(tokens / 2M).
// The server re-sanitizes everything; this only guarantees the shape.
// ---------------------------------------------------------------------------
const TOKEN_GARDEN = 100000;
const TOKEN_FERRY = 300000;
const TOKEN_LIGHTHOUSE = 1000000;
const TOKEN_TOWERS = 3000000;

function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function seededRand(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
// per-building population — verbatim from game.js (house 4-12, tall 14-42, tower 60-150).
function popForNormal(i, storeSeed) {
  const r = seededRand((storeSeed ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0);
  const kind = i % 9 === 4 ? "tower" : r() < 0.42 ? "tall" : "low";
  if (kind === "tower") return 60 + Math.floor(r() * 90);
  if (kind === "tall") return 14 + Math.floor(r() * 28);
  return 4 + Math.floor(r() * 8);
}

function buildCity(username, tokens) {
  const t = Math.max(0, Number(tokens) || 0);
  const seed = hashSeed(String(username || "anon"));
  const buildings = 2 + Math.floor(t / TOK_PER_BUILD_REAL);
  let pop = 0;
  const cap = Math.min(buildings, 50000); // huge cities: sum up to 50k, then extrapolate
  for (let i = 0; i < cap; i++) pop += popForNormal(i, seed);
  if (buildings > cap && cap > 0) pop += Math.round((pop / cap) * (buildings - cap));
  const marcos = [];
  if (t >= TOKEN_GARDEN) marcos.push("garden");
  if (t >= TOKEN_FERRY) marcos.push("ferry");
  if (t >= TOKEN_LIGHTHOUSE) marcos.push("lighthouse");
  if (t >= TOKEN_TOWERS) marcos.push("towers");
  const era = Math.floor(t / ERA_STEP);
  return { v: 1, seed: seed >>> 0, buildings: buildings, pop: pop, types: {}, marcos: marcos, era: era };
}

const MARCO_LABELS = {
  garden: "waterfront garden",
  ferry: "ferry across the water",
  lighthouse: "lighthouse with a beam",
  towers: "tower district",
  festival: "lantern festival",
  fireworks: "fireworks",
};

// ---------------------------------------------------------------------------
// PAYLOAD SHAPING — mirrors client/placar.js. Only names & counts; the server
// re-validates all of it. undefined = don't attach that field.
// ---------------------------------------------------------------------------
const ACCENT_SLUGS = ["dourado", "teal", "rosa", "violeta", "verde", "ambar"];
const MARCO_RE = /^[a-z-]{1,24}$/;

function nonNeg(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function shapeCity(raw) {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    if (raw.v !== 1) return undefined;
    const seed = Number(raw.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return undefined;
    const types = {};
    if (raw.types && typeof raw.types === "object") {
      const keys = Object.keys(raw.types);
      for (let i = 0; i < keys.length && Object.keys(types).length < 24; i++) {
        const k = String(keys[i]).slice(0, 24);
        const v = nonNeg(raw.types[keys[i]]);
        if (k && v > 0) types[k] = v;
      }
    }
    const marcos = [];
    if (Array.isArray(raw.marcos)) {
      for (let j = 0; j < raw.marcos.length && marcos.length < 16; j++) {
        const m = String(raw.marcos[j]).trim().toLowerCase();
        if (MARCO_RE.test(m) && marcos.indexOf(m) < 0) marcos.push(m);
      }
    }
    return {
      v: 1,
      seed: seed >>> 0,
      buildings: nonNeg(raw.buildings),
      pop: nonNeg(raw.pop),
      types: types,
      marcos: marcos,
      era: nonNeg(raw.era),
    };
  } catch (e) {
    return undefined;
  }
}

const SETUP_MAX_BYTES = 3072;
function slugList(a, cap) {
  if (!Array.isArray(a)) return [];
  const seen = new Set(),
    out = [];
  for (const x of a) {
    const s = setupSlugStrict(x);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      if (out.length >= cap) break;
    }
  }
  return out;
}
function shapeSetup(raw) {
  try {
    if (!raw || typeof raw !== "object" || raw.v !== 1) return undefined;
    const tools = Array.isArray(raw.tools)
      ? raw.tools
          .filter((p) => Array.isArray(p) && p.length === 2)
          .map((p) => [String(p[0]).replace(/[^A-Za-z0-9_.-]+/g, "").slice(0, 48), nonNeg(p[1])])
          .filter((p) => p[0] && p[1] > 0)
          .slice(0, 10)
      : [];
    const models = Array.isArray(raw.models)
      ? raw.models
          .filter((p) => Array.isArray(p) && p.length === 2)
          .map((p) => [setupSlugStrict(p[0]), Math.max(0, Math.min(1, Number(p[1]) || 0))])
          .filter((p) => p[0] && p[1] > 0)
          .slice(0, 6)
      : [];
    const out = {
      v: 1,
      skills: slugList(raw.skills, 40),
      mcp: slugList(raw.mcp, 20),
      hooks: slugList(raw.hooks, 12),
      tools: tools,
      models: models,
    };
    if (Buffer.byteLength(JSON.stringify(out)) > SETUP_MAX_BYTES) return undefined;
    return out;
  } catch (e) {
    return undefined;
  }
}
function shapeDailyTokens(raw) {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const keys = Object.keys(raw)
      .filter((k) => /^\d{8}$/.test(k))
      .sort()
      .reverse();
    const out = {};
    let n = 0;
    for (const k of keys) {
      const v = nonNeg(raw[k]);
      if (v > 0) {
        out[k] = v;
        if (++n >= 7) break;
      }
    }
    return n ? out : undefined;
  } catch (e) {
    return undefined;
  }
}
function shapeProfile(cfg) {
  try {
    const p = {};
    if (typeof cfg.cityName === "string") {
      const c = cfg.cityName.trim();
      p.cityName = c ? c.slice(0, 24) : "";
    }
    if (typeof cfg.motto === "string") {
      const m = cfg.motto.trim();
      p.motto = m ? m.slice(0, 48) : "";
    }
    if (typeof cfg.accent === "string") {
      const a = cfg.accent.trim().toLowerCase();
      if (ACCENT_SLUGS.indexOf(a) >= 0) p.accent = a;
    }
    return Object.keys(p).length ? p : undefined;
  } catch (e) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CONFIG — ~/.tokentown-placar.json (or $TOKENTOWN_CONFIG). Same shape as the
// app's reporter config.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: false,
  username: "",
  key: "",
  url: "",
  shareSetup: false,
  cityName: "",
  motto: "",
  accent: "",
};

function readConfigRaw(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}
function readConfig(p) {
  const parsed = readConfigRaw(p);
  return Object.assign({}, DEFAULT_CONFIG, parsed || {});
}
function writeConfig(p, cfg) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  } catch (e) {
    return false;
  }
}
function newKey() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars
}

const USERNAME_RE = /^[a-z0-9-]{2,24}$/;

function cityUrlFor(cfg) {
  const u = String(cfg.url || DEFAULT_URL);
  let origin = u.replace(/\/api\/report\/?$/, "");
  if (!origin || !/^https?:\/\//.test(origin)) origin = SITE_ORIGIN;
  return origin.replace(/\/+$/, "") + "/u/" + String(cfg.username).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// TERMINAL PRETTY-PRINT
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const gold = (s) => c("33", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);

function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}
function fmtCompact(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}
function line(s) {
  process.stdout.write((s == null ? "" : s) + "\n");
}

function banner() {
  line("");
  line("  " + gold("▛▀▖") + " " + bold("TOKENTOWN") + "  " + dim("where prompts become skyline"));
  line("");
}

function sourceLabel(sources) {
  sources = sources || {};
  const active = [];
  if (sources.claude > 0) active.push("Claude Code");
  if (sources.codex > 0) active.push("Codex");
  if (sources.opencode > 0) active.push("OpenCode");
  return active.length ? active.join(" + ") : "no local usage found";
}

function printModelBreakdown(data, all) {
  const rows = data && Array.isArray(data.modelBreakdown) ? data.modelBreakdown : [];
  if (!rows.length) return;
  line("  " + bold("Cost by model") + dim("  ·  estimated/API-equivalent where the client does not expose billing"));
  const shown = all ? rows : rows.slice(0, 6);
  for (const r of shown) {
    const provider = String(r.provider || "unknown").replace(/^opencode:/, "opencode/");
    line(
      "  " +
        dim(provider + " · ") +
        String(r.model || "unknown").padEnd(22).slice(0, 22) +
        "  " +
        gold("$" + Number(r.cost || 0).toFixed(4).padStart(9)) +
        dim("  ·  " + fmtCompact(r.tokens) + " city tokens")
    );
  }
  if (!all && rows.length > shown.length)
    line("  " + dim("+ " + (rows.length - shown.length) + " more model(s); run with --models to show all"));
  line("");
}

function printSummary(cfg, data, city, opts) {
  opts = opts || {};
  const url = cityUrlFor(cfg);
  line("  " + bold("Your city:  ") + cyan(url));
  line("");
  line("  " + gold("●") + " season " + bold("T" + data.seasonId) + dim("  ·  " + data.daysLeft + " day" + (data.daysLeft === 1 ? "" : "s") + " left"));
  line("  " + dim("sources: ") + sourceLabel(data.sources));
  line("  " + bold(fmtInt(data.tokens)) + " tokens " + dim("(" + fmtCompact(data.tokens) + ")") + "  →  " + bold(fmtInt(city.buildings)) + " buildings");
  line("  " + dim("population ") + fmtInt(city.pop) + dim("  ·  residents (subagents) ") + fmtInt(data.residents) + dim("  ·  est. cost ") + "$" + Number(data.cost || 0).toFixed(2));
  const landmarks = (city.marcos || []).map((m) => MARCO_LABELS[m] || m);
  if (landmarks.length) line("  " + dim("landmarks: ") + landmarks.join(dim(" · ")));
  else line("  " + dim("landmarks: none yet — first one lights up at 100k tokens"));
  line("");
  printModelBreakdown(data, !!opts.models);
  if (cfg.shareSetup) {
    const s = data.setup || {};
    const bits = [];
    if (s.skills && s.skills.length) bits.push(s.skills.length + " skills");
    if (s.mcp && s.mcp.length) bits.push(s.mcp.length + " MCP");
    if (s.tools && s.tools.length) bits.push(s.tools.length + " tools");
    if (s.models && s.models.length) bits.push(s.models.length + " models");
    if (bits.length) line("  " + dim("setup shared: ") + bits.join(dim(", ")));
  }
  line("");
}

// ---------------------------------------------------------------------------
// PAYLOAD + REPORT
// ---------------------------------------------------------------------------
// NOTE: we deliberately DO NOT send `city`. The CLI can't run the game
// simulation, so it can't reproduce the app's special buildings — and the
// leaderboard does last-writer-wins on the city field, so a CLI report would
// clobber the rich city of anyone who also runs the desktop app. The server
// already does the right thing without it: it PRESERVES an existing city when a
// report arrives with no `city`, and for CLI-only users it renders a full
// skyline seeded from the username (with the same token-threshold landmarks).
// The `buildCity()` blob is still computed locally to drive the terminal
// summary (buildings / population / landmarks); it just never leaves the machine.
function buildPayload(cfg, data) {
  const username = String(cfg.username).trim().toLowerCase();
  const payload = {
    username: username,
    key: cfg.key,
    seasonId: nonNeg(data.seasonId),
    tokens: nonNeg(data.tokens),
    cost: Number(data.cost) >= 0 ? Number(data.cost) : 0,
    residents: nonNeg(data.residents),
    buildings: nonNeg(data.buildings),
  };
  const profile = shapeProfile(cfg);
  if (profile) payload.profile = profile;
  const daily = shapeDailyTokens(data.daily);
  if (daily) payload.dailyTokens = daily;
  if (cfg.shareSetup) {
    const setup = shapeSetup(data.setup);
    if (setup) payload.setup = setup;
  }
  return payload;
}

// redacted copy of the payload for printing (never echo the key to the terminal).
function redactedPayload(payload) {
  const p = Object.assign({}, payload);
  if (p.key) p.key = "<hidden " + String(p.key).length + " chars>";
  return p;
}

async function postReport(cfg, payload) {
  if (typeof fetch !== "function") {
    return { ok: false, status: 0, error: "global fetch missing — need Node 18+" };
  }
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {}
    return { ok: res.ok, status: res.status, json: json };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------------------
// ONBOARDING (first run) — ask username, generate a key, ask about setup, save.
// ---------------------------------------------------------------------------
// Line reader with a queue: captures every stdin line whether it arrives before
// or after we ask for it, so piped/CI input never races with the prompts (the
// classic rl.question drop-on-fast-EOF). next() resolves to null on EOF.
function makeLineReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => {
    if (waiters.length) waiters.shift()(l);
    else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((res) => waiters.push(res));
    },
    close() {
      try {
        rl.close();
      } catch (e) {}
    },
  };
}

async function onboard(p) {
  line("");
  line("  " + bold("Welcome to TOKENTOWN.") + " Let's put your city on the map.");
  line("  " + dim("Only your username and the season numbers are ever sent —"));
  line("  " + dim("never prompts, code, conversation content, or project names."));
  line("");
  const lr = makeLineReader();
  const ask = async (q) => {
    process.stdout.write(q);
    const l = await lr.next();
    return l == null ? null : l;
  };
  let username = "";
  for (;;) {
    const l = await ask("  " + bold("Pick a username") + dim(" (a-z, 0-9, -, 2–24 chars): "));
    if (l == null) {
      // stdin closed with no valid username -> can't onboard.
      lr.close();
      line("");
      line("  " + red("No username given — run `npx tokentown` again to join.") );
      line("");
      throw new Error("onboarding aborted: no username on stdin");
    }
    const raw = l.trim().toLowerCase();
    if (USERNAME_RE.test(raw)) {
      username = raw;
      break;
    }
    line("");
    line("  " + red("  → use only a-z, 0-9 and -, between 2 and 24 characters."));
  }
  const shareLine = await ask(
    "  " + bold("Share your setup?") + dim(" skills/MCP/tools/models, names & counts only [y/N]: ")
  );
  const shareRaw = (shareLine == null ? "" : shareLine).trim().toLowerCase();
  const shareSetup = shareRaw === "y" || shareRaw === "yes" || shareRaw === "s" || shareRaw === "sim";
  lr.close();
  line("");

  const cfg = Object.assign({}, DEFAULT_CONFIG, {
    enabled: true,
    username: username,
    key: newKey(),
    url: DEFAULT_URL,
    shareSetup: shareSetup,
  });
  const saved = writeConfig(p, cfg);
  line("");
  line("  " + green("✓") + " saved config to " + dim(p) + "  " + dim("(key generated locally)"));
  if (!saved) line("  " + red("! couldn't write the config file — will report this once but won't remember you next time."));
  line("");
  return cfg;
}

// returns { cfg, fresh }. Never rewrites an existing config except to backfill a
// missing key.
async function loadOrOnboard(p) {
  const raw = readConfigRaw(p);
  if (raw && typeof raw === "object" && raw.username) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
    if (!cfg.url) cfg.url = DEFAULT_URL;
    if (!cfg.key) {
      cfg.key = newKey();
      // persist the freshly generated key (merge onto the on-disk object).
      writeConfig(p, Object.assign({}, raw, { key: cfg.key, url: cfg.url }));
    }
    return { cfg: cfg, fresh: false };
  }
  const cfg = await onboard(p);
  return { cfg: cfg, fresh: true };
}

// ---------------------------------------------------------------------------
// COMMANDS
// ---------------------------------------------------------------------------
function reportResultLine(cfg, r) {
  if (r.ok && r.status === 200) {
    const updated = r.json && r.json.updated;
    line("  " + green("✓ reported") + dim(" (HTTP 200" + (updated === false ? ", no change — already up to date" : "") + ")"));
    return true;
  }
  if (r.status === 429) {
    line("  " + gold("• easy there") + dim(" — the board takes one report per minute. Your numbers are safe; try again shortly."));
    return true; // not a hard failure
  }
  if (r.status === 403) {
    line("  " + red("✗ that username is taken by a different key.") + dim(" Pick another username in " + configPath() + "."));
    return false;
  }
  if (r.status === 0) {
    line("  " + red("✗ couldn't reach the leaderboard") + dim(" (" + (r.error || "network error") + ")."));
    line("  " + dim("  Your usage was read fine — nothing was lost. Try again later."));
    return false;
  }
  const msg = (r.json && r.json.error) || ("HTTP " + r.status);
  line("  " + red("✗ report rejected: ") + dim(msg));
  return false;
}

async function cmdReport(cfg, opts) {
  opts = opts || {};
  const data = readSeason();
  const username = String(cfg.username).trim().toLowerCase();
  const city = buildCity(username, data.tokens); // local-only: drives the terminal summary; NOT sent
  const payload = buildPayload(cfg, data);

  if (opts.dryRun) {
    line("  " + bold("DRY RUN") + dim(" — nothing will be sent. This is exactly what a real report would POST:"));
    line("  " + dim("→ " + cfg.url));
    line("");
    line(
      JSON.stringify(redactedPayload(payload), null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")
    );
    line("");
    printSummary(cfg, data, city, opts);
    line("  " + dim("(dry run — no request sent, leaderboard untouched)"));
    line("");
    return true;
  }

  const r = await postReport(cfg, payload);
  const ok = reportResultLine(cfg, r);
  if (ok) printSummary(cfg, data, city, opts);
  return ok;
}

async function cmdWatch(cfg) {
  const EVERY_MS = 10 * 60 * 1000; // ~10 min
  line("  " + bold("watching") + dim(" — reporting every ~10 min. Ctrl+C to stop.") + "\n");
  process.on("SIGINT", () => {
    line("\n  " + dim("stopped watching. your city is saved at ") + cyan(cityUrlFor(cfg)) + "\n");
    process.exit(0);
  });

  async function tick() {
    const data = readSeason();
    const username = String(cfg.username).trim().toLowerCase();
    const city = buildCity(username, data.tokens); // local-only: drives the summary line; NOT sent
    const payload = buildPayload(cfg, data);
    const r = await postReport(cfg, payload);
    const stamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    if (r.ok && r.status === 200) {
      const changed = r.json && r.json.updated;
      line(
        "  " +
          dim(stamp) +
          "  " +
          green("✓") +
          " " +
          fmtInt(data.tokens) +
          " tokens" +
          dim(" · " + fmtInt(city.buildings) + " buildings · $" + Number(data.cost || 0).toFixed(2)) +
          (changed === false ? dim("  (no change)") : "")
      );
    } else if (r.status === 429) {
      line("  " + dim(stamp) + "  " + gold("•") + dim(" throttled (1/min) — will catch up next cycle"));
    } else if (r.status === 0) {
      line("  " + dim(stamp) + "  " + red("✗") + dim(" network error (" + (r.error || "offline") + ") — will retry next cycle"));
    } else {
      line("  " + dim(stamp) + "  " + red("✗") + dim(" " + ((r.json && r.json.error) || "HTTP " + r.status)));
    }
    const t = setTimeout(tick, EVERY_MS);
    if (t && t.unref) t.unref();
  }
  await tick();
  // keep the process alive between ticks
  setInterval(() => {}, 1 << 30);
}

// ---------------------------------------------------------------------------
// BACKGROUND SCHEDULE (macOS launchd)
// Copies this zero-dependency CLI to a stable per-user runner and invokes it
// every 10 minutes. No terminal and no long-lived `watch` process required.
// ---------------------------------------------------------------------------
const LAUNCH_LABEL = "com.tokentown.reporter";
const SCHEDULE_EVERY_SEC = 10 * 60;

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function schedulePaths(home) {
  home = home || os.homedir();
  const root = path.join(home, ".tokentown", "runner");
  return {
    root,
    runner: path.join(root, "cli.js"),
    log: path.join(home, ".tokentown", "reporter.log"),
    plist: path.join(home, "Library", "LaunchAgents", LAUNCH_LABEL + ".plist"),
  };
}

function launchDomain() {
  return "gui/" + (typeof process.getuid === "function" ? process.getuid() : 501);
}

function launchctl(args) {
  return childProcess.spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function schedulePlist(paths, cfgFile) {
  const envConfig = cfgFile || configPath();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    "  <key>Label</key><string>" + xmlEscape(LAUNCH_LABEL) + "</string>\n" +
    "  <key>ProgramArguments</key>\n  <array>\n" +
    "    <string>" + xmlEscape(process.execPath) + "</string>\n" +
    "    <string>" + xmlEscape(paths.runner) + "</string>\n" +
    "  </array>\n" +
    "  <key>EnvironmentVariables</key>\n  <dict>\n" +
    "    <key>HOME</key><string>" + xmlEscape(os.homedir()) + "</string>\n" +
    "    <key>TOKENTOWN_CONFIG</key><string>" + xmlEscape(envConfig) + "</string>\n" +
    "  </dict>\n" +
    "  <key>StartInterval</key><integer>" + SCHEDULE_EVERY_SEC + "</integer>\n" +
    "  <key>RunAtLoad</key><true/>\n" +
    "  <key>ProcessType</key><string>Background</string>\n" +
    "  <key>LowPriorityIO</key><true/>\n" +
    "  <key>StandardOutPath</key><string>" + xmlEscape(paths.log) + "</string>\n" +
    "  <key>StandardErrorPath</key><string>" + xmlEscape(paths.log) + "</string>\n" +
    "</dict>\n</plist>\n"
  );
}

function scheduleStatus() {
  if (process.platform !== "darwin") return { supported: false, loaded: false };
  const r = launchctl(["print", launchDomain() + "/" + LAUNCH_LABEL]);
  return { supported: true, loaded: r.status === 0 };
}

function cmdSchedule() {
  if (process.platform !== "darwin") {
    line("  " + red("Background schedule currently supports macOS launchd only."));
    line("  " + dim("On Linux, run `npx tokentown` from cron/systemd every 10 minutes."));
    return false;
  }
  const paths = schedulePaths();
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
    fs.copyFileSync(__filename, paths.runner);
    fs.chmodSync(paths.runner, 0o755);
    fs.writeFileSync(paths.plist, schedulePlist(paths, configPath()), "utf8");
  } catch (e) {
    line("  " + red("Couldn't install the background reporter: ") + dim(e.message || String(e)));
    return false;
  }
  launchctl(["bootout", launchDomain() + "/" + LAUNCH_LABEL]); // ignore: may not be loaded yet
  const loaded = launchctl(["bootstrap", launchDomain(), paths.plist]);
  if (loaded.status !== 0) {
    line("  " + red("Couldn't load the background reporter: ") + dim((loaded.stderr || "launchctl error").trim()));
    return false;
  }
  launchctl(["kickstart", "-k", launchDomain() + "/" + LAUNCH_LABEL]);
  line("  " + green("✓ background reporting enabled") + dim(" — every 10 minutes, no terminal needed"));
  line("  " + dim("log: ") + paths.log);
  line("  " + dim("disable: npx tokentown unschedule"));
  line("");
  return true;
}

function cmdUnschedule() {
  if (process.platform !== "darwin") return false;
  const paths = schedulePaths();
  launchctl(["bootout", launchDomain() + "/" + LAUNCH_LABEL]);
  try {
    if (fs.existsSync(paths.plist)) fs.unlinkSync(paths.plist);
    if (fs.existsSync(paths.runner)) fs.unlinkSync(paths.runner);
  } catch (e) {
    line("  " + red("Couldn't remove the schedule: ") + dim(e.message || String(e)));
    return false;
  }
  line("  " + green("✓ background reporting disabled"));
  line("");
  return true;
}

function printScheduleStatus() {
  const status = scheduleStatus();
  if (!status.supported) line("  " + dim("background schedule: unsupported on this OS"));
  else if (status.loaded) line("  " + green("● background schedule active") + dim(" · every 10 minutes"));
  else line("  " + dim("○ background schedule is not installed"));
  line("");
}

function printHelp() {
  banner();
  line("  " + bold("Usage"));
  line("    npx tokentown            report your season once, print your city URL");
  line("    npx tokentown watch      keep running, report every ~10 minutes");
  line("    npx tokentown schedule   report every ~10 min in the background (macOS)");
  line("    npx tokentown unschedule remove the background reporter");
  line("    npx tokentown status     show background reporter status");
  line("    npx tokentown --models   report and show cost for every model");
  line("    npx tokentown --dry-run  read & print what WOULD be sent (no request)");
  line("    npx tokentown --help     this help");
  line("");
  line("  " + bold("What it does"));
  line("    Reads Claude Code, Codex and OpenCode usage from their local stores and reports");
  line("    this season's numbers to " + cyan(SITE_ORIGIN) + ".");
  line("");
  line("  " + bold("Privacy"));
  line("    Only your username and the numbers are sent — never prompts, code,");
  line("    conversation content, or project names. Sharing your setup is opt-in.");
  line("");
  line("  " + dim("Config: " + configPath()));
  line("");
}

async function main() {
  const argv = process.argv.slice(2);
  const wantsHelp = argv.includes("--help") || argv.includes("-h") || argv.includes("help");
  const dryRun = argv.includes("--dry-run") || argv.includes("--dry") || argv.includes("-n");
  const watch = argv.includes("watch") || argv.includes("--watch");
  const models = argv.includes("--models") || argv.includes("models");
  const schedule = argv.includes("schedule") || argv.includes("--schedule");
  const unschedule = argv.includes("unschedule") || argv.includes("--unschedule");
  const status = argv.includes("status") || argv.includes("--status");

  if (wantsHelp) {
    printHelp();
    return 0;
  }

  banner();

  if (unschedule) return cmdUnschedule() ? 0 : 1;
  if (status) {
    printScheduleStatus();
    return 0;
  }

  const p = configPath();
  const { cfg, fresh } = await loadOrOnboard(p);

  if (!fresh) {
    line("  " + dim("reporting as ") + bold(String(cfg.username).trim().toLowerCase()) + dim("  ·  config ") + dim(p));
    line("");
  }

  if (schedule) return cmdSchedule() ? 0 : 1;

  if (watch) {
    if (dryRun) {
      // dry watch: just print one read and stop (no loop needed to prove reads).
      await cmdReport(cfg, { dryRun: true, models: models });
      return 0;
    }
    await cmdWatch(cfg);
    return 0; // (never really returns — watch keeps the loop alive)
  }

  const ok = await cmdReport(cfg, { dryRun: dryRun, models: models });
  return ok ? 0 : 1;
}

// Run as a CLI only when executed directly; when required as a module (tests,
// tooling) just export the pure pieces below. never crash with a raw stack
// trace — always a friendly message.
if (require.main === module) {
  // Exit cleanly if stdout is closed early (e.g. `npx tokentown | head`, or the
  // reader quits a pager) instead of crashing with an EPIPE stack trace.
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
  });
  process.stderr.on("error", () => {});
  main()
    .then((code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    })
    .catch((e) => {
      line("");
      line("  " + red("Something went wrong: ") + dim((e && e.message) || String(e)));
      line("  " + dim("This is a bug — please report it at https://github.com/AElise08/tokentown/issues"));
      process.exitCode = 1;
    });
}

module.exports = {
  // reading
  readSeason,
  currentSeasonId,
  daysLeftIn,
  priceFor,
  openAIPriceFor,
  openAICostFromUsage,
  tokensFromUsage,
  costFromUsage,
  collectSetup,
  dailyBucketize,
  usageDelta,
  sqliteRows,
  usagePaths,
  // city
  buildCity,
  hashSeed,
  // payload shaping
  buildPayload,
  shapeCity,
  shapeSetup,
  shapeDailyTokens,
  shapeProfile,
  // config
  readConfig,
  writeConfig,
  newKey,
  cityUrlFor,
  configPath,
  schedulePaths,
  schedulePlist,
  scheduleStatus,
  DEFAULT_URL,
  SITE_ORIGIN,
};
