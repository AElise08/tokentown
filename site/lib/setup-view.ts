// ---------------------------------------------------------------------------
// SETUP → CITY, the VIEW layer. Pure (no I/O): turns the sanitized `Setup`
// blob (skills / MCP / hooks / tools / models) that the store keeps into the
// render models the site draws — leaderboard skill chips, the "How this city
// was built" panel (skill/MCP chips, tool bars, model donut), the weekly
// "city lights" heatmap, and the short "what's shared" summary.
//
// Everything here degrades gracefully: a null / empty / partial `Setup` never
// throws — it just yields empty lists so the pages render nothing extra. Covered
// by lib/setup-view.test.mjs. Colours come from the site palette (globals.css /
// city.ts) so the setup reads as part of the same dark-retro city, never a
// bolt-on dashboard.
// ---------------------------------------------------------------------------
import type { Setup } from "./setup";
import type { SnapPoint } from "./window";
import { utcDayKey } from "./window";

// ---------------------------------------------------------------------------
// SKILL / MCP / HOOK chips
// ---------------------------------------------------------------------------

// True when the setup carries anything worth drawing.
export function hasSetup(setup: Setup | null | undefined): boolean {
  if (!setup) return false;
  return (
    setup.skills.length > 0 ||
    setup.mcp.length > 0 ||
    setup.hooks.length > 0 ||
    setup.tools.length > 0 ||
    setup.models.length > 0
  );
}

// Top-N skill slugs for the leaderboard chips (discreet, in-palette). Empty when
// there is no setup — the row then shows nothing.
export function topSkills(setup: Setup | null | undefined, n = 3): string[] {
  if (!setup || !setup.skills.length) return [];
  return setup.skills.slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// TOOL BARS — the "industries". Each tool gets a share of the total (for the %
// label) and a bar width relative to the busiest tool (so the top one fills the
// bar). Bash 40% … Edit 22% …
// ---------------------------------------------------------------------------
export interface ToolBar {
  slug: string;
  label: string;
  count: number;
  share: number; // fraction of ALL tool calls (0..1) — drives the % label
  bar: number; // width relative to the busiest tool (0..1) — drives the bar
}

// Human labels for the built-in tool names (slugs arrive lower-cased).
const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  multiedit: "MultiEdit",
  read: "Read",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  agent: "Agent",
  task: "Task",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  notebookedit: "NotebookEdit",
  ls: "LS",
};

// Title-cases an unknown slug for display: "some-tool" -> "Some Tool".
function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// MCP TOOL NAMES. An MCP tool arrives on the wire as "mcp__<server>__<tool>"
// (e.g. "mcp__claude-in-chrome__get_page_text"), but the setup sanitizer has
// already slugified it by here — every "__"/"_" collapsed to "-" and the whole
// slug capped at 32 chars — so it reads "mcp-claude-in-chrome-get-page-te".
// Title-casing THAT gives four identical, unreadable "Mcp Claude In Chrome …"
// rows in the tool mix. So we detect the mcp prefix, shorten the server, and
// show "<short server> · <tool>" — the tool being the part that tells them
// apart: "chrome · computer", "chrome · navigate", "chrome · get page te".
// ---------------------------------------------------------------------------

// Known verbose servers -> a short, readable tag. Unknown servers fall back to
// stripping a "claude-ai-"/"claude-in-" vendor prefix, then spacing the rest.
const MCP_SERVER_SHORT: Record<string, string> = {
  "claude-in-chrome": "chrome",
};

function shortServer(server: string): string {
  if (!server) return "";
  if (MCP_SERVER_SHORT[server]) return MCP_SERVER_SHORT[server];
  // "claude-in-chrome" -> "chrome", "claude-ai-canva" -> "canva", then "-" -> " ".
  return server.replace(/^claude-(ai|in)-/, "").replace(/-+/g, " ");
}

// Split an mcp slug into [server, tool]. Handles the raw wire form (still
// carrying "__") and the slugified "mcp-server-tool" form. In the slugified
// form the "__" boundary is gone, so we recover the server by matching the
// server slugs the setup itself shares (`servers`), longest first; failing
// that, the first segment is the server. Null when the slug isn't an mcp tool.
function splitMcp(slug: string, servers: string[]): [string, string] | null {
  const raw = slug.match(/^mcp__(.+?)__(.+)$/i);
  if (raw) return [raw[1].toLowerCase(), raw[2].toLowerCase()];
  if (!slug.startsWith("mcp-")) return null;
  const rest = slug.slice(4); // drop "mcp-"
  // recover the server boundary the "__"->"-" slugify erased: prefer a server
  // slug we actually know — the ones the setup shares PLUS the known verbose
  // ones — matching the longest. (A city's mcp list can omit a server whose
  // tools it still used, so we can't rely on `servers` alone.)
  const known = [...servers, ...Object.keys(MCP_SERVER_SHORT)]
    .filter((s) => s && (rest === s || rest.startsWith(s + "-")))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return [known, rest.slice(known.length).replace(/^-+/, "")];
  // vendor-style server ("claude-in-chrome", "claude-ai-canva"): keep 3 parts.
  const vendor = rest.match(/^(claude-(?:in|ai)-[a-z0-9]+)-(.+)$/);
  if (vendor) return [vendor[1], vendor[2]];
  // generic: first segment is the server, the rest the tool.
  const dash = rest.indexOf("-");
  if (dash === -1) return null; // no server/tool split -> treat as a normal slug
  return [rest.slice(0, dash), rest.slice(dash + 1)];
}

// Readable label for a tool slug. `mcpServers` are the setup's shared MCP
// server slugs, used to split "mcp-…" tool slugs on the right boundary.
export function prettyTool(slug: string, mcpServers: string[] = []): string {
  const parts = splitMcp(slug, mcpServers);
  if (parts) {
    const srv = shortServer(parts[0]);
    const tool = parts[1].replace(/[_-]+/g, " ").trim();
    if (!tool) return srv || TOOL_LABELS[slug] || titleCase(slug);
    return srv ? `${srv} · ${tool}` : tool;
  }
  return TOOL_LABELS[slug] ?? titleCase(slug);
}

// Back-compat: a plain tool label with no MCP server context.
export function toolLabel(slug: string): string {
  return prettyTool(slug);
}

export function toolBars(setup: Setup | null | undefined): ToolBar[] {
  const tools = setup?.tools ?? [];
  if (!tools.length) return [];
  const servers = setup?.mcp ?? [];
  const total = tools.reduce((a, [, c]) => a + c, 0);
  const max = tools.reduce((m, [, c]) => (c > m ? c : m), 0);
  return tools.map(([slug, count]) => ({
    slug,
    label: prettyTool(slug, servers),
    count,
    share: total > 0 ? count / total : 0,
    bar: max > 0 ? count / max : 0,
  }));
}

// Whole-percent label for a share ("40%"). A positive-but-tiny slice reads
// "<1%" instead of a misleading "0%" (a slice is drawn, so it isn't zero).
export function pct(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  if (frac < 0.005) return "<1%";
  return `${Math.round(frac * 100)}%`;
}

// ---------------------------------------------------------------------------
// MODEL DONUT — the "power sources". Each model is a slice, coloured by family
// (opus / sonnet / haiku / fable), with a cumulative start so the page can draw
// an SVG ring (stroke-dasharray) or the og card a simple bar.
// ---------------------------------------------------------------------------
export type PowerFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";

// Power-source colours, drawn from the site palette (calm, night-scene).
export const POWER_COLORS: Record<PowerFamily, string> = {
  opus: "#ffd79a", // gold
  sonnet: "#7fc7bf", // teal
  haiku: "#e08aa0", // rosa
  fable: "#c98ac4", // violeta
  other: "#8a7f96", // muted
};

const FAMILY_LABELS: Record<PowerFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  other: "Other",
};

// Classify a model slug into a power-source family by its prefix.
export function modelFamily(slug: string): PowerFamily {
  const s = slug.toLowerCase();
  if (s.startsWith("opus")) return "opus";
  if (s.startsWith("sonnet")) return "sonnet";
  if (s.startsWith("haiku")) return "haiku";
  if (s.startsWith("fable")) return "fable";
  return "other";
}

export function powerColor(slug: string): string {
  return POWER_COLORS[modelFamily(slug)];
}

export function familyLabel(family: PowerFamily): string {
  return FAMILY_LABELS[family];
}

export interface DonutSeg {
  slug: string;
  family: PowerFamily;
  label: string; // the model slug, as shared
  frac: number; // 0..1 share of the ring
  color: string;
  start: number; // cumulative start (0..1) — where this slice begins
}

// Donut segments for the model mix. Fractions come already normalized (~1) from
// the store's sanitizeSetup; we defensively re-normalize so a partial blob still
// draws a full ring. Empty when there are no models.
export function modelDonut(setup: Setup | null | undefined): DonutSeg[] {
  const models = setup?.models ?? [];
  const clean = models.filter(([, f]) => Number.isFinite(f) && f > 0);
  if (!clean.length) return [];
  const sum = clean.reduce((a, [, f]) => a + f, 0);
  if (sum <= 0) return [];
  const segs: DonutSeg[] = [];
  let start = 0;
  for (const [slug, f] of clean) {
    const frac = f / sum;
    segs.push({
      slug,
      family: modelFamily(slug),
      label: slug,
      frac,
      color: powerColor(slug),
      start,
    });
    start += frac;
  }
  return segs;
}

// ---------------------------------------------------------------------------
// WEEKLY HEATMAP — "city lights this week". Turns the daily high-water snapshots
// (cumulative tokens per UTC day) into per-day token GAINS for the last `days`
// UTC days, and normalizes each day's gain into an intensity (0..1) so the
// busiest day glows brightest. Robust to gaps: a day with no snapshot inherits
// the previous cumulative, so its gain is 0 (dim), never negative.
// ---------------------------------------------------------------------------
export interface HeatCell {
  dayKey: string; // AAAAMMDD (UTC)
  refMs: number; // that day's UTC midnight
  label: string; // weekday abbrev (UTC): "Mon" …
  gain: number; // tokens gained that day (>= 0)
  intensity: number; // 0..1 (relative to the brightest day in the window)
  today: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400000;

// UTC midnight (ms) for the day containing `ms`.
function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function weekHeatmap(
  snaps: SnapPoint[] | null | undefined,
  now: number = Date.now(),
  days = 7
): HeatCell[] {
  const list = Array.isArray(snaps) ? snaps.slice() : [];
  // sort ascending so the "latest snap <= t" scan is stable.
  list.sort((a, b) => a.refMs - b.refMs);

  // cumulative tokens as of the END of a given UTC day (midnight ms): the
  // high-water of the latest snapshot whose day is <= that day. Monotonic, so
  // we take the max among eligible snaps.
  const cumAsOf = (dayMidnight: number): number => {
    let best = 0;
    for (const s of list) {
      if (s.refMs <= dayMidnight && s.tokens > best) best = s.tokens;
    }
    return best;
  };

  const todayKey = utcDayKey(now);
  const today0 = utcMidnight(now);

  // build the last `days` days, oldest -> newest.
  const cells: HeatCell[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const refMs = today0 - i * DAY_MS;
    const prevMs = refMs - DAY_MS;
    const gain = Math.max(0, cumAsOf(refMs) - cumAsOf(prevMs));
    const dayKey = utcDayKey(refMs);
    cells.push({
      dayKey,
      refMs,
      label: WEEKDAYS[new Date(refMs).getUTCDay()],
      gain,
      intensity: 0, // filled below
      today: dayKey === todayKey,
    });
  }

  const maxGain = cells.reduce((m, c) => (c.gain > m ? c.gain : m), 0);
  if (maxGain > 0) {
    for (const c of cells) c.intensity = c.gain / maxGain;
  }
  return cells;
}

// ---------------------------------------------------------------------------
// "WHAT'S SHARED" — the transparency line: only names & counts, never prompts
// or code. Used by the ⓘ note on /u.
// ---------------------------------------------------------------------------
export interface SetupSummary {
  skills: number;
  mcp: number;
  hooks: number;
  tools: number;
  models: number;
  text: string;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function setupSummary(setup: Setup | null | undefined): SetupSummary {
  const skills = setup?.skills.length ?? 0;
  const mcp = setup?.mcp.length ?? 0;
  const hooks = setup?.hooks.length ?? 0;
  const tools = setup?.tools.length ?? 0;
  const models = setup?.models.length ?? 0;
  const parts: string[] = [];
  if (skills) parts.push(plural(skills, "skill"));
  if (mcp) parts.push(`${mcp} MCP`);
  if (hooks) parts.push(plural(hooks, "hook"));
  if (tools) parts.push(plural(tools, "tool"));
  if (models) parts.push(plural(models, "power source"));
  const text = parts.length ? parts.join(" · ") : "nothing shared yet";
  return { skills, mcp, hooks, tools, models, text };
}

// ---------------------------------------------------------------------------
// AGGREGATE view model — one call for the /u panel. Null when there is nothing
// to show (so the page can skip the whole section).
// ---------------------------------------------------------------------------
export interface SetupView {
  skills: string[];
  mcp: string[];
  hooks: string[];
  tools: ToolBar[];
  donut: DonutSeg[];
  summary: SetupSummary;
}

export function setupView(setup: Setup | null | undefined): SetupView | null {
  if (!hasSetup(setup)) return null;
  return {
    skills: setup!.skills.slice(),
    mcp: setup!.mcp.slice(),
    hooks: setup!.hooks.slice(),
    tools: toolBars(setup),
    donut: modelDonut(setup),
    summary: setupSummary(setup),
  };
}
