import Stripe from "stripe";
import { DEFAULT_SPONSOR_PLAN_ID, type SponsorPlanId } from "./sponsor";

let cached: Stripe | null = null;

export function sponsorSalesEnabled(): boolean {
  if (process.env.NODE_ENV !== "production" && process.env.SPONSOR_DEMO_MODE === "1") return true;
  return (
    process.env.SPONSOR_SALES_ENABLED === "1" &&
    !!process.env.STRIPE_SECRET_KEY &&
    !!process.env.STRIPE_WEBHOOK_SECRET &&
    (process.env.SPONSOR_ADMIN_KEY || "").length >= 32
  );
}

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!cached) cached = new Stripe(key, { maxNetworkRetries: 2 });
  return cached;
}

export function sponsorPriceId(planId: SponsorPlanId = DEFAULT_SPONSOR_PLAN_ID): string | null {
  const envName = planId === "day"
    ? "STRIPE_SPONSOR_PRICE_ID_1D"
    : planId === "three"
      ? "STRIPE_SPONSOR_PRICE_ID_3D"
      : "STRIPE_SPONSOR_PRICE_ID_10D";
  const value = (process.env[envName] || (planId === "day" ? process.env.STRIPE_SPONSOR_PRICE_ID : ""))?.trim();
  return value && /^price_[A-Za-z0-9]+$/.test(value) ? value : null;
}

export function siteOrigin(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:3000";
}
