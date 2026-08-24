const DAY_MS = 24 * 60 * 60 * 1000;

export const SPONSOR_PLANS = {
  day: { id: "day", days: 1, priceCents: 200, label: "1 day" },
  three: { id: "three", days: 3, priceCents: 300, label: "3 days" },
  ten: { id: "ten", days: 10, priceCents: 1000, label: "10 days" },
} as const;
export type SponsorPlanId = keyof typeof SPONSOR_PLANS;
export const DEFAULT_SPONSOR_PLAN_ID: SponsorPlanId = "day";
export const SPONSOR_PRICE_CENTS = SPONSOR_PLANS.day.priceCents;
export const SPONSOR_DURATION_MS = DAY_MS;
export const SPONSOR_GAP_MS = 30 * 60 * 1000;
export const SPONSOR_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SPONSOR_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type SponsorStatus =
  | "draft"
  | "paid"
  | "scheduled"
  | "active"
  | "completed"
  | "paused"
  | "rejected"
  | "refunded";

export type SponsorCampaign = {
  id: string;
  name: string;
  tagline: string;
  url: string;
  email: string;
  planId: SponsorPlanId;
  priceCents: number;
  durationMs: number;
  status: SponsorStatus;
  createdAt: number;
  paidAt?: number;
  approvedAt?: number;
  startsAt?: number;
  endsAt?: number;
  checkoutSessionId?: string;
  paymentIntentId?: string;
  refundId?: string;
  pausedAt?: number;
  remainingMs?: number;
};

export type PublicSponsor = Pick<SponsorCampaign, "id" | "name" | "tagline" | "url" | "startsAt" | "endsAt" | "planId" | "priceCents" | "durationMs">;
export type PublicSponsorSlot = PublicSponsor & { status: "active" | "scheduled" };
export type PublicSponsorHistory = PublicSponsor & { status: "active" | "scheduled" | "completed" };

export type SponsorDraft = Pick<SponsorCampaign, "name" | "tagline" | "url" | "email" | "planId">;

export function sponsorPlan(raw: unknown) {
  const id = typeof raw === "string" && raw in SPONSOR_PLANS
    ? raw as SponsorPlanId
    : DEFAULT_SPONSOR_PLAN_ID;
  const plan = SPONSOR_PLANS[id];
  return { ...plan, durationMs: plan.days * DAY_MS };
}

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function sanitizeSponsorDraft(raw: unknown): SponsorDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = cleanText(r.name, 18);
  const tagline = cleanText(r.tagline, 60);
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase().slice(0, 160) : "";
  const planId = sponsorPlan(r.planId).id;
  let url = "";
  try {
    const parsed = new URL(typeof r.url === "string" ? r.url.trim() : "");
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.toString().slice(0, 500);
  } catch {}
  if (!name || !tagline || !url || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name, tagline, url, email, planId };
}

export function effectiveSponsorStatus(c: SponsorCampaign, now = Date.now()): SponsorStatus {
  if (c.status !== "scheduled" && c.status !== "active" && c.status !== "completed") return c.status;
  if (!(c.startsAt && c.endsAt)) return "paid";
  if (now < c.startsAt) return "scheduled";
  if (now < c.endsAt) return "active";
  return "completed";
}

export function nextSponsorWindow(campaigns: SponsorCampaign[], now = Date.now(), durationMs = SPONSOR_DURATION_MS): { startsAt: number; endsAt: number } {
  let startsAt = now;
  for (const c of campaigns) {
    const status = effectiveSponsorStatus(c, now);
    if (
      (status === "scheduled" || status === "active" || status === "completed") &&
      c.endsAt &&
      c.endsAt + SPONSOR_GAP_MS > startsAt
    ) startsAt = c.endsAt + SPONSOR_GAP_MS;
  }
  return { startsAt, endsAt: startsAt + durationMs };
}

export function toPublicSponsor(c: SponsorCampaign | null, now = Date.now()): PublicSponsor | null {
  if (!c || effectiveSponsorStatus(c, now) !== "active") return null;
  const { id, name, tagline, url, startsAt, endsAt, planId, priceCents, durationMs } = c;
  return { id, name, tagline, url, startsAt, endsAt, planId, priceCents, durationMs };
}
