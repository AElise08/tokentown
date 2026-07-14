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

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_URL = "https://tokentown-gamma.vercel.app/api/report";
const SITE_ORIGIN = "https://tokentown-gamma.vercel.app";

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
// PRICING — USD per 1M tokens (source: claude-api skill). input = uncached
// input; output = generation. Cache multipliers over INPUT price: read = 0.10x,
// 5-min write = 1.25x, 1-hour write = 2.00x. Opus 4.8 keeps the standard table
// for its 1M window, so the "[1m]" suffix uses the same prices.
// ---------------------------------------------------------------------------
const PRICING = {
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

function priceFor(model) {
  if (!model) return SONNET_PRICE;
  let m = String(model).toLowerCase();
  if (m === "<synthetic>") return { in: 0, out: 0 }; // local message, no API cost
  m = m.replace(/\[1m\]$/, ""); // drop long-context marker
  m = m.replace(/-\d{8}$/, ""); // drop date suffix (e.g. -20251001)
  if (PRICING[m]) return PRICING[m];
  if (m === "opus" || m.startsWith("claude-opus")) return { in: 5, out: 25 };
  if (m === "fable" || m.startsWith("claude-fable") || m.startsWith("claude-mythos")) return { in: 10, out: 50 };
  if (m === "sonnet" || m.startsWith("claude-sonnet")) return { in: 3, out: 15 };
  if (m === "haiku" || m.startsWith("claude-haiku")) return { in: 1, out: 5 };
  return SONNET_PRICE;
}

// tokens that raise buildings: newly generated content (uncached input + output
// + newly written cache). Ignores cache_read (cheap, huge re-reads).
function tokensFromUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// honest USD cost of one usage line — every field (input, output, cache write,
// cache read) with real per-model pricing.
function costFromUsage(u, model) {
  if (!u) return 0;
  const p = priceFor(model);
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
// SEASON READ — the single source of truth: scan every transcript under
// ~/.claude/projects/**/*.jsonl (subagent mirrors included), count only lines
// whose timestamp falls in the current season, with the SAME dedupe as the app.
// Full re-scan each call (no offsets) — simple and correct for a one-shot / poll
// CLI; fresh dedupe state per scan so watch mode never under- or double-counts.
// ---------------------------------------------------------------------------
function readSeason(now) {
  now = now || Date.now();
  const seasonId = currentSeasonId(now);
  const seasonStart = SEASON_EPOCH + seasonId * SEASON_MS;
  const dailyStart = dailyWindowStartMs(now);

  const seenUsage = new Set();
  const seenAgents = new Set();
  const seenTools = new Set();
  const toolTally = new Map();
  const modelTally = new Map();
  const skillTally = new Map();

  let tokens = 0,
    cost = 0,
    residents = 0;
  const dailyEntries = [];

  const files = listJsonl(PROJECTS, []);
  for (const f of files) {
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch (e) {
      continue;
    }
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) continue; // no complete line
    for (const line of buf.slice(0, nl).toString("utf8").split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!o.timestamp) continue; // no timestamp -> skip
      const ts = Date.parse(o.timestamp);
      if (!(ts >= seasonStart)) continue; // outside the current season
      const u = o.message && o.message.usage;
      if (u) {
        const mid = o.message && o.message.id;
        const rid = o.requestId;
        let counted = true;
        if (mid != null && rid != null) counted = remember(seenUsage, mid + ":" + rid, USAGE_CAP);
        if (counted) {
          const lineTk = tokensFromUsage(u);
          tokens += lineTk;
          cost += costFromUsage(u, o.message.model);
          tallyForSetup(o, u, modelTally);
          if (ts >= dailyStart && lineTk > 0) dailyEntries.push({ ts: ts, tokens: lineTk });
        }
      }
      tallyTools(o, seenTools, toolTally, skillTally); // tools/skills — dedupe by block id
      residents += countNewSubagents(o, seenAgents);
    }
  }

  const daily = dailyBucketize(dailyEntries, now);
  const setup = collectSetup({ toolTally, modelTally, skillTally });
  const buildings = 2 + Math.floor(tokens / TOK_PER_BUILD_REAL);
  return { seasonId, tokens, cost, residents, buildings, daily, setup, filesScanned: files.length, daysLeft: daysLeftIn(now) };
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

function printSummary(cfg, data, city, opts) {
  opts = opts || {};
  const url = cityUrlFor(cfg);
  line("  " + bold("Your city:  ") + cyan(url));
  line("");
  line("  " + gold("●") + " season " + bold("T" + data.seasonId) + dim("  ·  " + data.daysLeft + " day" + (data.daysLeft === 1 ? "" : "s") + " left"));
  line("  " + bold(fmtInt(data.tokens)) + " tokens " + dim("(" + fmtCompact(data.tokens) + ")") + "  →  " + bold(fmtInt(city.buildings)) + " buildings");
  line("  " + dim("population ") + fmtInt(city.pop) + dim("  ·  residents (subagents) ") + fmtInt(data.residents) + dim("  ·  est. cost ") + "$" + Number(data.cost || 0).toFixed(2));
  const landmarks = (city.marcos || []).map((m) => MARCO_LABELS[m] || m);
  if (landmarks.length) line("  " + dim("landmarks: ") + landmarks.join(dim(" · ")));
  else line("  " + dim("landmarks: none yet — first one lights up at 100k tokens"));
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

function printHelp() {
  banner();
  line("  " + bold("Usage"));
  line("    npx tokentown            report your season once, print your city URL");
  line("    npx tokentown watch      keep running, report every ~10 minutes");
  line("    npx tokentown --dry-run  read & print what WOULD be sent (no request)");
  line("    npx tokentown --help     this help");
  line("");
  line("  " + bold("What it does"));
  line("    Reads your real Claude Code usage under ~/.claude/projects and reports");
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

  if (wantsHelp) {
    printHelp();
    return 0;
  }

  banner();

  const p = configPath();
  const { cfg, fresh } = await loadOrOnboard(p);

  if (!fresh) {
    line("  " + dim("reporting as ") + bold(String(cfg.username).trim().toLowerCase()) + dim("  ·  config ") + dim(p));
    line("");
  }

  if (watch) {
    if (dryRun) {
      // dry watch: just print one read and stop (no loop needed to prove reads).
      await cmdReport(cfg, { dryRun: true });
      return 0;
    }
    await cmdWatch(cfg);
    return 0; // (never really returns — watch keeps the loop alive)
  }

  const ok = await cmdReport(cfg, { dryRun: dryRun });
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
  tokensFromUsage,
  costFromUsage,
  collectSetup,
  dailyBucketize,
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
  DEFAULT_URL,
  SITE_ORIGIN,
};
