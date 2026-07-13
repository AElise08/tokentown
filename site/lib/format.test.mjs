// Tests for the en-US formatting helpers. Run with Node 22+/24 (native type
// stripping):  node --import ./lib/tshook.mjs --test lib/format.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCount, formatCost, formatAnnualCost, formatAgo, formatDate } from "./format.ts";

// ---------------------------------------------------------------------------
// formatCount — "1.2M" / "12.3k" / "980" (en-US, dot decimals, comma groups)
// ---------------------------------------------------------------------------
test("formatCount: compact en-US buckets", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(980), "980");
  assert.equal(formatCount(1200), "1.2k");
  assert.equal(formatCount(12345), "12.3k");
  assert.equal(formatCount(1_200_000), "1.2M");
  assert.equal(formatCount(2_000_000), "2M"); // drops trailing .0
  assert.equal(formatCount(1_500_000_000), "1.5B");
});

test("formatCount: sub-thousands grouped en-US, junk -> 0", () => {
  assert.equal(formatCount(1058), "1.1k");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(-5), "0");
  assert.equal(formatCount(NaN), "0");
  assert.equal(formatCount(Infinity), "0"); // non-finite -> "0", never a locale string
});

// ---------------------------------------------------------------------------
// formatCost — "$1,059" whole dollars, "$0.42" sub-dollar, "$1.2M" compact
// ---------------------------------------------------------------------------
test("formatCost: en-US dollars", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(61.3), "$61");
  assert.equal(formatCost(298.1), "$298");
  assert.equal(formatCost(1059.4864503), "$1,059");
  assert.equal(formatCost(0.42), "$0.42");
  assert.equal(formatCost(150000), "$150k");
  assert.equal(formatCost(1_200_000), "$1.2M");
  assert.equal(formatCost(-5), "$0");
});

// ---------------------------------------------------------------------------
// formatAnnualCost — headline projection, en-US
// ---------------------------------------------------------------------------
test("formatAnnualCost: en-US k/M/B", () => {
  assert.equal(formatAnnualCost(127000), "$127k");
  assert.equal(formatAnnualCost(48000), "$48k");
  assert.equal(formatAnnualCost(53050), "$53k");
  assert.equal(formatAnnualCost(1_200_000), "$1.2M");
  assert.equal(formatAnnualCost(1_234_567_000), "$1.2B");
  assert.equal(formatAnnualCost(900), "$900");
  assert.equal(formatAnnualCost(-5), "$0");
});

// ---------------------------------------------------------------------------
// formatAgo — "just now" / "3m ago" / "2h ago" / "5d ago"
// ---------------------------------------------------------------------------
test("formatAgo: en-US relative time", () => {
  const now = 10_000_000_000;
  assert.equal(formatAgo(0, now), "—");
  assert.equal(formatAgo(now - 5_000, now), "just now");
  assert.equal(formatAgo(now - 3 * 60_000, now), "3m ago");
  assert.equal(formatAgo(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(formatAgo(now - 5 * 86_400_000, now), "5d ago");
});

// ---------------------------------------------------------------------------
// formatDate — "Jul 1" style, UTC
// ---------------------------------------------------------------------------
test("formatDate: 'Mon D' in UTC", () => {
  assert.equal(formatDate(new Date(Date.UTC(2026, 6, 1))), "Jul 1");
  assert.equal(formatDate(new Date(Date.UTC(2026, 6, 28))), "Jul 28");
  assert.equal(formatDate(new Date(Date.UTC(2026, 0, 5))), "Jan 5");
  assert.equal(formatDate(new Date(Date.UTC(2026, 11, 31))), "Dec 31");
});
