// Source-level guards for the launch UX changes. Run with:
//   node --import ./lib/tshook.mjs --test lib/site.test.mjs
// These read the source files (not lib exports) to assert that the board's
// live auto-refresh exists, the reporter throttle was lowered to ~3 min, and
// the embedded demo opens into the rooftops platformer in auto-play.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url); // repo root (this file lives in lib/)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

test("public brand uses NORTOWN at the nort.works root domain", () => {
  const layout = read("app/layout.tsx");
  const page = read("app/page.tsx");
  const cli = read("../cli/cli.js");
  assert.match(layout, /https:\/\/nort\.works/);
  assert.match(layout, /title: "NORTOWN — leaderboard"/);
  assert.match(page, />✦<\/span> NORTOWN/);
  assert.match(page, /className="hero-cta"[^>]*>build your city/);
  assert.doesNotMatch(page, /◍/);
  assert.match(cli, /const DEFAULT_URL = "https:\/\/nort\.works\/api\/report"/);
  assert.match(cli, /LEGACY_DEFAULT_URL/);
});

test("production responses use security headers and health exposes no environment diagnostics", () => {
  const config = read("next.config.js");
  const health = read("app/api/health/route.ts");
  assert.match(config, /poweredByHeader:\s*false/);
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /X-Content-Type-Options/);
  assert.match(config, /Permissions-Policy/);
  assert.doesNotMatch(health, /redisEnvKeys|getUserSnaps|searchParams/);
});

test("sponsor sales stay disabled until the explicit production flag and credentials exist", () => {
  const stripe = read("lib/stripe.ts");
  const checkout = read("app/api/sponsors/checkout/route.ts");
  assert.match(stripe, /SPONSOR_SALES_ENABLED\s*===\s*["']1["']/);
  assert.match(stripe, /STRIPE_WEBHOOK_SECRET/);
  assert.match(checkout, /sponsorSalesEnabled\(\)/);
  assert.match(checkout, /reserveSponsorCheckout/);
  assert.match(checkout, /deleteSponsorDraft/);
});

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

test("isometric profiles vary structure by deterministic city family", () => {
  const iso = read("public/demo/isometric-city.js");
  assert.match(iso, /family === 0[\s\S]*financial core/);
  assert.match(iso, /family === 4[\s\S]*industrial waterfront/);
  assert.match(iso, /family === 6[\s\S]*twin clusters/);
  assert.match(iso, /towerKind\s*=\s*\(family \|\| 0\) % 4/);
  assert.match(iso, /city-layout-7|Macro-family/);
});

test("isometric city keeps growing beyond the old 9,999-building ceiling", () => {
  const context = { window: {} };
  runInNewContext(read("public/demo/isometric-city.js"), context);
  const plan = context.window.TokentownIsoCity.plan;
  const input = { seed: 2422228418, era: 12, types: {}, marcos: [] };
  const oldCeiling = plan({ ...input, buildings: 9_999 });
  const current = plan({ ...input, buildings: 10_588 });
  const laterInCycle = plan({ ...input, buildings: 10_638 });
  const future = plan({ ...input, buildings: 22_000 });
  const count = (city) => city.outer.length + city.background.length + city.middle.length + city.foreground.length;
  const height = (city) => city.outer.concat(city.background, city.middle, city.foreground)
    .reduce((sum, building) => sum + building.h, 0);

  assert.ok(count(current) > count(oldCeiling), "crossing 10k unlocks another visible district lot");
  assert.ok(height(laterInCycle) > height(current), "the active construction rises inside each 100-building cycle");
  assert.ok(current.background.concat(current.middle, current.foreground).some((building) => building.underConstruction),
    "the active expansion is marked as under construction");
  assert.ok(count(future) > count(current), "later milestones keep adding visible lots");
  assert.ok(height(future) > height(current), "the existing skyline also rises over time");
  assert.deepEqual(plan({ ...input, buildings: 10_588 }), current, "growth remains deterministic");
});

test("a new isometric town starts empty and occupies its first lots honestly", () => {
  const context = { window: {}, URL, console };
  runInNewContext(read("public/demo/isometric-city.js"), context);
  const plan = context.window.TokentownIsoCity.plan;
  const input = { seed: 12_345, era: 0, types: {}, marcos: [] };
  const count = (city) => city.outer.length + city.background.length + city.middle.length + city.foreground.length;
  assert.equal(count(plan({ ...input, buildings: 0 })), 0);
  assert.equal(count(plan({ ...input, buildings: 1 })), 1);
  assert.equal(count(plan({ ...input, buildings: 4 })), 1);
  assert.equal(count(plan({ ...input, buildings: 5 })), 2);
  assert.match(read("public/demo/isometric-city.js"), /plan\.buildingCount >= 25/);
});

test("profile keeps the isometric main view and synchronized pixel mini", () => {
  const profile = read("app/u/[username]/page.tsx");
  assert.match(profile, /renderer:\s*"iso-original"/);
  assert.match(profile, /flightEpoch:\s*String\(now\)/);
  assert.match(profile, /profileDemoSrc/);
  assert.match(profile, /railDemoParams\.set\("renderer",\s*"classic"\)/);
  assert.match(profile, /const railDemoSrc = `\/demo\/index\.html\?/);
});

test("profile exposes an isolated accelerated city-growth preview", () => {
  const profile = read("app/u/[username]/page.tsx");
  const game = read("public/demo/game.js");
  const iso = read("public/demo/isometric-city.js");
  assert.match(profile, /sp\?\.preview === "growth"/);
  assert.match(profile, /demoParams\.set\("growthPreview", "1"\)/);
  assert.match(game, /query\.get\('growthPreview'\) === '1'/);
  assert.match(iso, /function updateGrowthPreview\(now\)/);
  assert.match(iso, /previewFrom \+ \(previewTo - previewFrom\) \* progress/);
  assert.match(iso, /previewRendered < 100 \|\| nextBuildings < 100 \? 1 : 50/);
  assert.match(iso, /first 100 buildings arrive/);
});

test("site exposes a dedicated privacy page and links it from the board", () => {
  const page = read("app/page.tsx");
  const privacy = read("app/privacy/page.tsx");
  assert.match(page, /href="\/privacy"/);
  assert.match(privacy, /What is never sent/);
  assert.match(privacy, /Prompts, responses, source code/);
  assert.match(privacy, /github\.com\/AElise08\/tokentown/);
});

test("closed season albums expose only the final 28-day totals", () => {
  const page = read("app/page.tsx");
  const api = read("app/api/placar/route.ts");
  assert.match(page, /isCurrent\s*&&\s*sp\?\.window\s*===\s*["']7d["']/);
  assert.match(page, /!isCurrent\s*\?\s*["']final totals · season closed["']/);
  assert.match(page, /isCurrent\s*\?\s*\([\s\S]*7 days[\s\S]*\)\s*:\s*\([\s\S]*season · 28d/);
  assert.match(api, /season\s*===\s*cur\s*&&\s*url\.searchParams\.get\(["']window["']\)\s*===\s*["']7d["']/);
});

test("sponsored flights stay site-only and do not track per-ad impressions or clicks", () => {
  const page = read("app/page.tsx");
  const dock = read("app/SponsorDock.tsx");
  const game = read("public/demo/isometric-city.js");
  const privacy = read("app/privacy/page.tsx");
  assert.match(page, /<SponsorDock[\s\S]*sponsor=\{sponsor\}[\s\S]*lineup=\{sponsorLineup\}[\s\S]*salesEnabled=\{salesEnabled\}/);
  assert.match(dock, /put your site in the sky · \$2/);
  assert.match(dock, /departures/);
  assert.match(dock, /individual ad impressions and clicks are not tracked/);
  assert.match(game, /sponsorName/);
  assert.match(privacy, /does not create browsing profiles or track individual/);
  assert.doesNotMatch(dock, /\/api\/sponsors\/(impression|click)/);
});
