import {
  approveSponsorCampaign,
  getSponsorCampaign,
  listSponsorCampaigns,
  setSponsorStatus,
} from "@/lib/store";
import { sponsorAdminAuthorized } from "@/lib/sponsor-auth";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!sponsorAdminAuthorized(req)) return Response.json({ ok: false }, { status: 401 });
  return Response.json({ ok: true, campaigns: await listSponsorCampaigns() });
}

export async function POST(req: Request) {
  if (!sponsorAdminAuthorized(req)) return Response.json({ ok: false }, { status: 401 });
  let body: { id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const id = String(body.id || "");
  if (body.action === "approve") {
    const campaign = await approveSponsorCampaign(id);
    return campaign
      ? Response.json({ ok: true, campaign })
      : Response.json({ ok: false, error: "campaign is not awaiting approval" }, { status: 409 });
  }
  if (body.action === "pause") {
    const campaign = await setSponsorStatus(id, "paused");
    return campaign ? Response.json({ ok: true, campaign }) : Response.json({ ok: false }, { status: 404 });
  }
  if (body.action === "reject") {
    const campaign = await getSponsorCampaign(id);
    if (!campaign) return Response.json({ ok: false }, { status: 404 });
    let refundId: string | undefined;
    if (campaign.paymentIntentId && campaign.status !== "refunded") {
      const stripe = getStripe();
      if (!stripe) return Response.json({ ok: false, error: "Stripe is required to refund this payment" }, { status: 503 });
      const refund = await stripe.refunds.create({ payment_intent: campaign.paymentIntentId });
      refundId = refund.id;
    }
    const next = await setSponsorStatus(id, refundId ? "refunded" : "rejected", refundId);
    return Response.json({ ok: true, campaign: next });
  }
  return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
}
