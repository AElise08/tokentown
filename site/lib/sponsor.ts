export const SPONSOR_PRICE_CENTS = 200;
export const SPONSOR_DURATION_MS = 24 * 60 * 60 * 1000;
export const SPONSOR_GAP_MS = 30 * 60 * 1000;

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
  status: SponsorStatus;
  createdAt: number;
  paidAt?: number;
  approvedAt?: number;
  startsAt?: number;
  endsAt?: number;
  checkoutSessionId?: string;
  paymentIntentId?: string;
  refundId?: string;
};

export type PublicSponsor = Pick<SponsorCampaign, "id" | "name" | "tagline" | "url" | "startsAt" | "endsAt">;
export type PublicSponsorSlot = PublicSponsor & { status: "active" | "scheduled" };

export type SponsorDraft = Pick<SponsorCampaign, "name" | "tagline" | "url" | "email">;

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
  let url = "";
  try {
    const parsed = new URL(typeof r.url === "string" ? r.url.trim() : "");
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.toString().slice(0, 500);
  } catch {}
  if (!name || !tagline || !url || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name, tagline, url, email };
}

export function effectiveSponsorStatus(c: SponsorCampaign, now = Date.now()): SponsorStatus {
  if (c.status !== "scheduled" && c.status !== "active" && c.status !== "completed") return c.status;
  if (!(c.startsAt && c.endsAt)) return "paid";
  if (now < c.startsAt) return "scheduled";
  if (now < c.endsAt) return "active";
  return "completed";
}

export function nextSponsorWindow(campaigns: SponsorCampaign[], now = Date.now()): { startsAt: number; endsAt: number } {
  let startsAt = now;
  for (const c of campaigns) {
    const status = effectiveSponsorStatus(c, now);
    if (
      (status === "scheduled" || status === "active" || status === "completed") &&
      c.endsAt &&
      c.endsAt + SPONSOR_GAP_MS > startsAt
    ) startsAt = c.endsAt + SPONSOR_GAP_MS;
  }
  return { startsAt, endsAt: startsAt + SPONSOR_DURATION_MS };
}

export function toPublicSponsor(c: SponsorCampaign | null, now = Date.now()): PublicSponsor | null {
  if (!c || effectiveSponsorStatus(c, now) !== "active") return null;
  const { id, name, tagline, url, startsAt, endsAt } = c;
  return { id, name, tagline, url, startsAt, endsAt };
}
