// Source-level guards for the launch UX changes. Run with:
//   node --import ./lib/tshook.mjs --test lib/site.test.mjs
// These read the source files (not lib exports) to assert that the board's
// live auto-refresh exists, the reporter throttle was lowered to ~3 min, and
// the embedded demo opens into the rooftops platformer in auto-play.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url); // repo root (this file lives in lib/)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

// ---------------------------------------------------------------------------
// BOARD AUTO-REFRESH — the "/" board keeps itself fresh with a client component.
// ---------------------------------------------------------------------------
test("board page mounts a live auto-refresh component", () => {
  const page = read("app/page.tsx");
  assert.match(page, /import\s+LiveBoard\s+from\s+["']\.\/LiveBoard["']/);
  assert.match(page, /<LiveBoard\s+renderedAt=\{now\}\s*\/>/);
});

test("LiveBoard is a client component that refreshes on an interval and pauses when hidden", () => {
  const lb = read("app/LiveBoard.tsx");
  assert.match(lb, /^["']use client["'];/m, "must be a client component");
  assert.match(lb, /router\.refresh\(\)/, "must re-render the server component");
  assert.match(lb, /REFRESH_MS\s*=\s*35_?000/, "should refresh roughly every 35s");
  assert.match(lb, /document\.hidden/, "should pause while the tab is hidden");
  assert.match(lb, /updates automatically/, "discreet live indicator copy");
});

// ---------------------------------------------------------------------------
// REPORTER THROTTLE — lowered from 10 min to ~3 min so the board feels live.
// ---------------------------------------------------------------------------
test("client reporter throttle is 3 minutes (not 10)", () => {
  const src = read("client/placar.js");
  assert.match(src, /THROTTLE_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(src, /THROTTLE_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
});

// ---------------------------------------------------------------------------
// DEMO — opens into the rooftops platformer in auto-play (attract mode) and the
// simulation runs at a lively pace. This is the site copy only (public/demo).
// ---------------------------------------------------------------------------
test("embedded demo has a rooftops attract-mode auto-pilot with takeover", () => {
  const g = read("public/demo/game.js");
  assert.match(g, /function rcAutoPilot\(/, "auto-play pilot exists");
  assert.match(g, /function rcTakeover\(/, "visitor can take control");
  assert.match(g, /rcAuto\s*=\s*true;\s*startRecreio\(\)/, "opens straight into rooftops");
  assert.match(g, /rooftops · '\+rc\.score/, "HUD is English 'rooftops'");
});

test("demo simulation pace is lively (fast burn, small tokens-per-building)", () => {
  const g = read("public/demo/game.js");
  const burn = /var SIM_BURN\s*=\s*(\d+)/.exec(g);
  const per = /var TOK_PER_BUILD_SIM\s*=\s*(\d+)/.exec(g);
  assert.ok(burn && per, "both sim constants present");
  const rate = Number(burn[1]) / Number(per[1]); // buildings per second
  // target ~1 building every 2-4s -> 0.25..0.5 buildings/s
  assert.ok(rate >= 0.25 && rate <= 0.6, `sim build rate out of range: ${rate.toFixed(3)}/s`);
  assert.ok(Number(burn[1]) >= 1000, "token burn should be clearly running");
});
