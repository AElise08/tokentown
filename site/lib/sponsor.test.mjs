import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPONSOR_DURATION_MS,
  sanitizeSponsorDraft,
  effectiveSponsorStatus,
  nextSponsorWindow,
  toPublicSponsor,
} from "./sponsor.ts";

test("sponsor draft accepts safe HTTPS fields and strips markup", () => {
  const d = sanitizeSponsorDraft({
    name: "<Linear>", tagline: "Build <fast>\nwith issues", url: "https://linear.app/", email: "HELLO@EXAMPLE.COM",
  });
  assert.deepEqual(d, {
    name: "Linear", tagline: "Build fast with issues", url: "https://linear.app/", email: "hello@example.com",
  });
});

test("sponsor draft rejects non-HTTPS URLs, credentials and bad emails", () => {
  assert.equal(sanitizeSponsorDraft({ name: "X", tagline: "Y", url: "http://x.dev", email: "a@b.com" }), null);
  assert.equal(sanitizeSponsorDraft({ name: "X", tagline: "Y", url: "https://u:p@x.dev", email: "a@b.com" }), null);
  assert.equal(sanitizeSponsorDraft({ name: "X", tagline: "Y", url: "https://x.dev", email: "bad" }), null);
});

test("effective status and public sponsor follow the scheduled 24-hour window", () => {
  const now = 1_000_000;
  const base = { id: "c1", name: "Linear", tagline: "Fast", url: "https://linear.app/", email: "a@b.com", createdAt: 1, status: "scheduled", startsAt: now + 100, endsAt: now + 200 };
  assert.equal(effectiveSponsorStatus(base, now), "scheduled");
  assert.equal(effectiveSponsorStatus(base, now + 150), "active");
  assert.equal(effectiveSponsorStatus(base, now + 250), "completed");
  assert.equal(toPublicSponsor(base, now), null);
  assert.equal(toPublicSponsor(base, now + 150)?.name, "Linear");
});

test("new approvals queue after the last active or scheduled campaign", () => {
  const now = 2_000;
  const c = { id: "c1", name: "A", tagline: "B", url: "https://a.dev/", email: "a@b.com", createdAt: 1, status: "scheduled", startsAt: now, endsAt: now + SPONSOR_DURATION_MS };
  const w = nextSponsorWindow([c], now);
  assert.equal(w.startsAt, c.endsAt);
  assert.equal(w.endsAt - w.startsAt, SPONSOR_DURATION_MS);
});
