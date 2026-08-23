import Stripe from "stripe";

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

export function siteOrigin(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:3000";
}
