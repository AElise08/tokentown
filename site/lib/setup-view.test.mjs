// Tests for the SETUP → CITY view layer (lib/setup-view.ts): skill chips, tool
// bars, model donut, weekly heatmap and the "what's shared" summary. All PURE,
// so they run under the native type-stripper. The overriding requirement is
// that a null / empty / partial Setup never throws.
//   node --import ./lib/tshook.mjs --test lib/setup-view.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasSetup,
  topSkills,
  toolBars,
  toolLabel,
  prettyTool,
  pct,
  modelFamily,
  powerColor,
  modelDonut,
  weekHeatmap,
  setupSummary,
  setupView,
  POWER_COLORS,
} from "./setup-view.ts";
import { utcDayKey, dayKeyRefMs } from "./window.ts";

// A full, realistic setup blob (already sanitized shape).
const FULL = {
  v: 1,
  skills: ["copy-mel", "superpowers", "flow-broll-palmier", "deep-research"],
  mcp: ["palmier-pro", "claude-in-chrome"],
  hooks: ["stop", "posttooluse"],
  tools: [
    ["bash", 1859],
    ["edit", 846],
    ["agent", 100],
    ["websearch", 40],
  ],
  models: [
    ["opus-4-8", 0.71],
    ["sonnet-5", 0.2],
    ["haiku-4-5", 0.09],
  ],
};

const EMPTY = { v: 1, skills: [], mcp: [], hooks: [], tools: [], models: [] };

// ---------------------------------------------------------------------------
// NULL / EMPTY — nothing throws, everything degrades to empty.
// ---------------------------------------------------------------------------
test("null / undefined / empty setup never throws and yields empties", () => {
  for (const s of [null, undefined, EMPTY]) {
    assert.equal(hasSetup(s), false);
    assert.deepEqual(topSkills(s), []);
    assert.deepEqual(toolBars(s), []);
    assert.deepEqual(modelDonut(s), []);
    assert.equal(setupView(s), null);
    const sum = setupSummary(s);
    assert.equal(sum.skills, 0);
    assert.equal(sum.text, "nothing shared yet");
  }
});

test("hasSetup is true when any list has content", () => {
  assert.equal(hasSetup(FULL), true);
  assert.equal(hasSetup({ ...EMPTY, mcp: ["x"] }), true);
  assert.equal(hasSetup({ ...EMPTY, models: [["opus-4", 1]] }), true);
});

// ---------------------------------------------------------------------------
// SKILL CHIPS
// ---------------------------------------------------------------------------
test("topSkills returns the first N (default 3)", () => {
  assert.deepEqual(topSkills(FULL), ["copy-mel", "superpowers", "flow-broll-palmier"]);
  assert.deepEqual(topSkills(FULL, 2), ["copy-mel", "superpowers"]);
  assert.deepEqual(topSkills(FULL, 0), []);
  assert.deepEqual(topSkills({ ...EMPTY, skills: ["only-one"] }), ["only-one"]);
});

// ---------------------------------------------------------------------------
// TOOL BARS
// ---------------------------------------------------------------------------
test("toolBars: share sums to ~1, bar is relative to the busiest tool", () => {
  const bars = toolBars(FULL);
  assert.equal(bars.length, 4);
  // labels are humanized
  assert.equal(bars[0].label, "Bash");
  assert.equal(bars[1].label, "Edit");
  assert.equal(bars[3].label, "WebSearch");
  // busiest tool fills the bar
  assert.equal(bars[0].bar, 1);
  // shares add up to ~1
  const shareSum = bars.reduce((a, b) => a + b.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, `share sum ${shareSum}`);
  // bar is count / maxCount
  assert.ok(Math.abs(bars[1].bar - 846 / 1859) < 1e-9);
  // % label for the top tool
  assert.equal(pct(bars[0].share), `${Math.round((1859 / 2845) * 100)}%`);
});

test("toolLabel humanizes known + unknown slugs", () => {
  assert.equal(toolLabel("bash"), "Bash");
  assert.equal(toolLabel("multiedit"), "MultiEdit");
  assert.equal(toolLabel("some-custom-tool"), "Some Custom Tool");
});

// MCP tool names: the bug was four identical, unreadable "Mcp Claude In Chrome …"
// rows. By the time slugs reach here the wire "mcp__server__tool" has been
// slugified ("__"/"_" -> "-", capped at 32 chars), so we render "<server> · <tool>",
// leading with the tool — the part that actually differs.
test("prettyTool renders mcp tools readably & distinctly (server · tool)", () => {
  // mel's REAL setup lists only "palmier-pro" as an mcp server even though its
  // tool mix used claude-in-chrome tools — so the split must NOT depend on the
  // server being in the list; the known verbose-server map recovers it.
  const servers = ["palmier-pro"];
  // exactly the four real slugs the sanitizer produces (get-page-text / tabs-
  // context-mcp are clipped at the 32-char cap to -te / -contex).
  const slugs = [
    "mcp-claude-in-chrome-computer",
    "mcp-claude-in-chrome-navigate",
    "mcp-claude-in-chrome-get-page-te",
    "mcp-claude-in-chrome-tabs-contex",
  ];
  const labels = slugs.map((s) => prettyTool(s, servers));
  assert.deepEqual(labels, [
    "chrome · computer",
    "chrome · navigate",
    "chrome · get page te",
    "chrome · tabs contex",
  ]);
  // all four DISTINCT, and none is the old unreadable "Mcp Claude …"
  assert.equal(new Set(labels).size, 4);
  assert.ok(labels.every((l) => !/^mcp claude/i.test(l)));
  // also works with no server hint at all (the map still recovers it)
  assert.equal(prettyTool("mcp-claude-in-chrome-navigate"), "chrome · navigate");
});

test("prettyTool handles the raw wire form and unknown servers", () => {
  // raw "mcp__server__tool" (underscores intact) parses without a servers hint
  assert.equal(prettyTool("mcp__claude-in-chrome__get_page_text"), "chrome · get page text");
  // unknown server, split recovered from the servers list; vendor prefix untouched
  assert.equal(prettyTool("mcp-palmier-pro-export-clip", ["palmier-pro"]), "palmier pro · export clip");
  // no servers hint -> first segment is the server
  assert.equal(prettyTool("mcp-acme-do-thing"), "acme · do thing");
});

test("prettyTool leaves normal tools untouched (incl. taskupdate)", () => {
  assert.equal(prettyTool("bash"), "Bash");
  assert.equal(prettyTool("webfetch"), "WebFetch");
  assert.equal(prettyTool("some-custom-tool"), "Some Custom Tool");
  assert.equal(prettyTool("taskupdate"), "Taskupdate");
});

test("toolBars labels mcp tools using the setup's own mcp servers", () => {
  const s = {
    v: 1,
    skills: [],
    hooks: [],
    models: [],
    mcp: ["claude-in-chrome"],
    tools: [
      ["mcp-claude-in-chrome-computer", 50],
      ["bash", 200],
      ["mcp-claude-in-chrome-navigate", 10],
    ],
  };
  const byslug = Object.fromEntries(toolBars(s).map((b) => [b.slug, b.label]));
  assert.equal(byslug["mcp-claude-in-chrome-computer"], "chrome · computer");
  assert.equal(byslug["mcp-claude-in-chrome-navigate"], "chrome · navigate");
  assert.equal(byslug["bash"], "Bash");
});

test("pct clamps and rounds; tiny positive slices read <1%", () => {
  assert.equal(pct(0), "0%");
  assert.equal(pct(-1), "0%");
  assert.equal(pct(0.003), "<1%");
  assert.equal(pct(0.404), "40%");
  assert.equal(pct(1), "100%");
});

// ---------------------------------------------------------------------------
// MODEL DONUT
// ---------------------------------------------------------------------------
test("modelFamily classifies by prefix; colors come from the palette", () => {
  assert.equal(modelFamily("opus-4-8"), "opus");
  assert.equal(modelFamily("sonnet-5"), "sonnet");
  assert.equal(modelFamily("haiku-4-5"), "haiku");
  assert.equal(modelFamily("fable-1"), "fable");
  assert.equal(modelFamily("gpt-9000"), "other");
  assert.equal(powerColor("opus-4-8"), POWER_COLORS.opus);
  assert.equal(powerColor("mystery"), POWER_COLORS.other);
});

test("modelDonut: fracs sum to 1, starts are cumulative & monotonic", () => {
  const segs = modelDonut(FULL);
  assert.equal(segs.length, 3);
  const fracSum = segs.reduce((a, s) => a + s.frac, 0);
  assert.ok(Math.abs(fracSum - 1) < 1e-9, `frac sum ${fracSum}`);
  // starts are cumulative and increasing
  assert.equal(segs[0].start, 0);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].start > segs[i - 1].start);
    assert.ok(Math.abs(segs[i].start - (segs[i - 1].start + segs[i - 1].frac)) < 1e-9);
  }
  // colored by family
  assert.equal(segs[0].color, POWER_COLORS.opus);
  assert.equal(segs[1].color, POWER_COLORS.sonnet);
});

test("modelDonut re-normalizes a partial (non-summing) blob", () => {
  const segs = modelDonut({ ...EMPTY, models: [["opus-4", 0.3], ["sonnet-5", 0.1]] });
  const fracSum = segs.reduce((a, s) => a + s.frac, 0);
  assert.ok(Math.abs(fracSum - 1) < 1e-9);
  assert.ok(Math.abs(segs[0].frac - 0.75) < 1e-9);
});

test("modelDonut drops non-positive / non-finite fractions", () => {
  const segs = modelDonut({ ...EMPTY, models: [["opus-4", 1], ["bad", 0], ["nan", Number.NaN]] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].frac, 1);
});

// ---------------------------------------------------------------------------
// WEEKLY HEATMAP
// ---------------------------------------------------------------------------
// A fixed "now": 2026-07-13 12:00 UTC.
const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const snap = (dayKey, tokens) => ({
  dayKey,
  refMs: dayKeyRefMs(dayKey),
  tokens,
  cost: tokens / 1000,
});

test("weekHeatmap returns 7 cells for null / empty snaps, all dim", () => {
  for (const s of [null, undefined, []]) {
    const cells = weekHeatmap(s, NOW);
    assert.equal(cells.length, 7);
    assert.ok(cells.every((c) => c.gain === 0 && c.intensity === 0));
    // last cell is today
    assert.equal(cells[6].today, true);
    assert.equal(cells[6].dayKey, utcDayKey(NOW));
    // ordered oldest -> newest
    for (let i = 1; i < cells.length; i++) assert.ok(cells[i].refMs > cells[i - 1].refMs);
  }
});

test("weekHeatmap: single day of history lights only today", () => {
  const cells = weekHeatmap([snap("20260713", 5_000_000)], NOW);
  assert.equal(cells.length, 7);
  const today = cells[6];
  assert.equal(today.today, true);
  assert.equal(today.gain, 5_000_000);
  assert.equal(today.intensity, 1);
  // earlier days are dark
  assert.ok(cells.slice(0, 6).every((c) => c.gain === 0 && c.intensity === 0));
});

test("weekHeatmap: per-day gains are the cumulative deltas, normalized", () => {
  // cumulative high-water: Jul 11 -> 1M, Jul 12 -> 3M, Jul 13 -> 3.5M
  const cells = weekHeatmap(
    [snap("20260711", 1_000_000), snap("20260712", 3_000_000), snap("20260713", 3_500_000)],
    NOW
  );
  const byKey = Object.fromEntries(cells.map((c) => [c.dayKey, c]));
  assert.equal(byKey["20260711"].gain, 1_000_000);
  assert.equal(byKey["20260712"].gain, 2_000_000); // 3M - 1M
  assert.equal(byKey["20260713"].gain, 500_000); // 3.5M - 3M
  // brightest day (Jul 12) is full intensity; others are proportional
  assert.equal(byKey["20260712"].intensity, 1);
  assert.ok(Math.abs(byKey["20260711"].intensity - 0.5) < 1e-9);
  assert.ok(Math.abs(byKey["20260713"].intensity - 0.25) < 1e-9);
});

test("weekHeatmap: gaps carry the cumulative forward (no negative gains)", () => {
  // a snapshot from BEFORE the window (Jul 5) then one today; the days in between
  // inherit the Jul-5 cumulative so their gain is 0, and today's gain is the jump.
  const cells = weekHeatmap([snap("20260705", 2_000_000), snap("20260713", 9_000_000)], NOW);
  assert.ok(cells.every((c) => c.gain >= 0));
  const today = cells.find((c) => c.today);
  assert.equal(today.gain, 7_000_000); // 9M - 2M carried
  // days between the out-of-window baseline and today stayed dim
  assert.ok(cells.slice(0, 6).every((c) => c.gain === 0));
});

test("weekHeatmap: the server's back-dated cumulative (7 days + today-7 floor) fills every visible day", () => {
  // This is exactly the shape recordBackdatedDailySnapshots writes for daily gains
  // {13:4M,12:3M,11:2M,10:1M} over a 15M season (5M of it PRE-window): cumulative
  // back-dated Jul13=15M,12=11M,11=8M,10=6M,09=5M,08=5M,07=5M plus the Jul6 FLOOR=5M.
  const cells = weekHeatmap(
    [
      snap("20260706", 5_000_000), // today-7 floor (= pre-window total)
      snap("20260707", 5_000_000),
      snap("20260708", 5_000_000),
      snap("20260709", 5_000_000),
      snap("20260710", 6_000_000),
      snap("20260711", 8_000_000),
      snap("20260712", 11_000_000),
      snap("20260713", 15_000_000),
    ],
    NOW
  );
  const byKey = Object.fromEntries(cells.map((c) => [c.dayKey, c]));
  assert.equal(byKey["20260713"].gain, 4_000_000);
  assert.equal(byKey["20260712"].gain, 3_000_000);
  assert.equal(byKey["20260711"].gain, 2_000_000);
  assert.equal(byKey["20260710"].gain, 1_000_000);
  // the oldest visible days are dark — the 5M pre-window total does NOT leak into
  // Jul 7 (today-6), because the Jul 6 floor anchors the difference to 0.
  assert.equal(byKey["20260709"].gain, 0);
  assert.equal(byKey["20260708"].gain, 0);
  assert.equal(byKey["20260707"].gain, 0);
  // several days lit — the original bug was ONLY today lighting up.
  assert.equal(cells.filter((c) => c.gain > 0).length, 4);
});

// ---------------------------------------------------------------------------
// SUMMARY + AGGREGATE
// ---------------------------------------------------------------------------
test("setupSummary counts and pluralizes; MCP stays upper-case", () => {
  const s = setupSummary(FULL);
  assert.equal(s.skills, 4);
  assert.equal(s.mcp, 2);
  assert.equal(s.models, 3);
  assert.match(s.text, /4 skills/);
  assert.match(s.text, /2 MCP/);
  assert.match(s.text, /3 power sources/);
  // singular
  assert.match(setupSummary({ ...EMPTY, mcp: ["one"] }).text, /1 MCP/);
  assert.match(setupSummary({ ...EMPTY, skills: ["one"] }).text, /1 skill(?!s)/);
});

test("setupView aggregates everything, or null when empty", () => {
  assert.equal(setupView(EMPTY), null);
  const v = setupView(FULL);
  assert.ok(v);
  assert.deepEqual(v.skills, FULL.skills);
  assert.deepEqual(v.mcp, FULL.mcp);
  assert.equal(v.tools.length, 4);
  assert.equal(v.donut.length, 3);
  assert.equal(v.summary.skills, 4);
});
