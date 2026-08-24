import { sanitizeSponsorDraft, sponsorPlan } from "@/lib/sponsor";
import {
  attachSponsorCheckout,
  createSponsorCampaign,
  deleteSponsorDraft,
  finalizeSponsorPayment,
  reserveSponsorCheckout,
} from "@/lib/store";
import { getStripe, siteOrigin, sponsorPriceId, sponsorSalesEnabled } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sponsorSalesEnabled())
    return Response.json({ ok: false, error: "sponsored flights are not on sale yet" }, { status: 503 });
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ ok: false, error: "cross-site request blocked" }, { status: 403 });
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 4096)
    return Response.json({ ok: false, error: "request too large" }, { status: 413 });

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4096)
      return Response.json({ ok: false, error: "request too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || (body as Record<string, unknown>).accepted !== "on")
    return Response.json({ ok: false, error: "flight terms must be accepted" }, { status: 400 });
  const draft = sanitizeSponsorDraft(body);
  if (!draft) return Response.json({ ok: false, error: "invalid sponsor details" }, { status: 400 });
  if (!(await reserveSponsorCheckout(draft.email)))
    return Response.json({ ok: false, error: "please wait a minute before trying again" }, { status: 429 });
  const campaign = await createSponsorCampaign(draft);
  if (!campaign) return Response.json({ ok: false, error: "invalid sponsor details" }, { status: 400 });

  const stripe = getStripe();
  const origin = siteOrigin(req);
  if (!stripe) {
    const sessionId = `demo_${campaign.id}`;
    await attachSponsorCheckout(campaign.id, sessionId);
    const activated = await finalizeSponsorPayment({ id: campaign.id, checkoutSessionId: sessionId, email: campaign.email });
    if (!activated)
      return Response.json({ ok: false, error: "automatic scheduling unavailable" }, { status: 503 });
    return Response.json({ ok: true, demo: true, url: `${origin}/?sponsor=demo-paid` });
  }

  try {
    const plan = sponsorPlan(campaign.planId);
    const fixedPrice = sponsorPriceId(plan.id);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: campaign.email,
      client_reference_id: campaign.id,
      metadata: { campaignId: campaign.id, sponsorPlan: plan.id },
      line_items: [
        fixedPrice ? { quantity: 1, price: fixedPrice } : {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: plan.priceCents,
            product_data: {
              name: `NORTOWN sponsored flight · ${plan.label}`,
              description: `${campaign.name} — ${campaign.tagline}`,
            },
          },
        },
      ],
      success_url: `${origin}/?sponsor=paid#sponsor`,
      cancel_url: `${origin}/?sponsor=cancelled#sponsor`,
    });
    if (!session.url) {
      await deleteSponsorDraft(campaign.id);
      return Response.json({ ok: false, error: "checkout unavailable" }, { status: 502 });
    }
    await attachSponsorCheckout(campaign.id, session.id);
    return Response.json({ ok: true, url: session.url });
  } catch (error) {
    console.error("sponsor checkout creation failed", error);
    await deleteSponsorDraft(campaign.id);
    return Response.json({ ok: false, error: "checkout unavailable" }, { status: 502 });
  }
}
