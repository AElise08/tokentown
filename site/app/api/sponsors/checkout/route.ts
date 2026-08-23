import { SPONSOR_PRICE_CENTS } from "@/lib/sponsor";
import {
  attachSponsorCheckout,
  createSponsorCampaign,
  markSponsorPaid,
} from "@/lib/store";
import { getStripe, siteOrigin } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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
    return Response.json({ ok: false, error: "review terms must be accepted" }, { status: 400 });
  const campaign = await createSponsorCampaign(body);
  if (!campaign) return Response.json({ ok: false, error: "invalid sponsor details" }, { status: 400 });

  const stripe = getStripe();
  const origin = siteOrigin(req);
  if (!stripe) {
    if (process.env.NODE_ENV === "production" && process.env.SPONSOR_DEMO_MODE !== "1") {
      return Response.json({ ok: false, error: "checkout is not configured yet" }, { status: 503 });
    }
    const sessionId = `demo_${campaign.id}`;
    await attachSponsorCheckout(campaign.id, sessionId);
    await markSponsorPaid({ id: campaign.id, checkoutSessionId: sessionId, email: campaign.email });
    return Response.json({ ok: true, demo: true, url: `${origin}/?sponsor=demo-paid` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: campaign.email,
      client_reference_id: campaign.id,
      metadata: { campaignId: campaign.id },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: SPONSOR_PRICE_CENTS,
            product_data: {
              name: "TOKENTOWN sponsored flight · 24 hours",
              description: `${campaign.name} — ${campaign.tagline}`,
            },
          },
        },
      ],
      success_url: `${origin}/?sponsor=paid`,
      cancel_url: `${origin}/?sponsor=cancelled`,
    });
    if (!session.url) return Response.json({ ok: false, error: "checkout unavailable" }, { status: 502 });
    await attachSponsorCheckout(campaign.id, session.id);
    return Response.json({ ok: true, url: session.url });
  } catch (error) {
    console.error("sponsor checkout creation failed", error);
    return Response.json({ ok: false, error: "checkout unavailable" }, { status: 502 });
  }
}
