import {
  approveSponsorCampaign,
  getSponsorCampaign,
  listSponsorCampaigns,
  pauseSponsorCampaign,
  renameUser,
  reserveSponsorAdminAttempt,
  resumeSponsorCampaign,
  setSponsorStatus,
} from "@/lib/store";
import { sponsorAdminAuthorized } from "@/lib/sponsor-auth";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestFingerprint(req: Request): string {
  return (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown")
    .split(",")[0]
    .trim();
}

async function rejectUnauthorized(req: Request): Promise<Response> {
  const allowed = await reserveSponsorAdminAttempt(requestFingerprint(req));
  return Response.json({ ok: false }, { status: allowed ? 401 : 429 });
}

export async function GET(req: Request) {
  if (!sponsorAdminAuthorized(req)) return rejectUnauthorized(req);
  return Response.json(
    { ok: true, campaigns: await listSponsorCampaigns() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ ok: false }, { status: 403 });
  if (!sponsorAdminAuthorized(req)) return rejectUnauthorized(req);
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 2048)
    return Response.json({ ok: false, error: "request too large" }, { status: 413 });
  let body: { id?: string; action?: string; from?: string; to?: string; dryRun?: boolean };
  try {
    const raw = await req.text();
    if (raw.length > 2048)
      return Response.json({ ok: false, error: "request too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const id = String(body.id || "");
  if (body.action === "rename-user") {
    const result = await renameUser({
      from: String(body.from || ""),
      to: String(body.to || ""),
      dryRun: body.dryRun === true,
    });
    return Response.json(result, { status: result.status });
  }
  if (body.action === "approve") {
    const campaign = await approveSponsorCampaign(id);
    return campaign
      ? Response.json({ ok: true, campaign })
      : Response.json({ ok: false, error: "approve the oldest paid campaign first, or retry" }, { status: 409 });
  }
  if (body.action === "pause") {
    const campaign = await pauseSponsorCampaign(id);
    return campaign ? Response.json({ ok: true, campaign }) : Response.json({ ok: false }, { status: 404 });
  }
  if (body.action === "resume") {
    const campaign = await resumeSponsorCampaign(id);
    return campaign
      ? Response.json({ ok: true, campaign })
      : Response.json({ ok: false, error: "finish the paid queue first, or retry" }, { status: 409 });
  }
  if (body.action === "reject") {
    const campaign = await getSponsorCampaign(id);
    if (!campaign) return Response.json({ ok: false }, { status: 404 });
    let refundId: string | undefined;
    if (campaign.paymentIntentId && campaign.status !== "refunded") {
      const stripe = getStripe();
      if (!stripe) return Response.json({ ok: false, error: "Stripe is required to refund this payment" }, { status: 503 });
      try {
        const refund = await stripe.refunds.create({ payment_intent: campaign.paymentIntentId });
        refundId = refund.id;
      } catch (error) {
        console.error("sponsor refund failed", error);
        return Response.json({ ok: false, error: "refund failed; campaign was not changed" }, { status: 502 });
      }
    }
    const next = await setSponsorStatus(id, refundId ? "refunded" : "rejected", refundId);
    return Response.json({ ok: true, campaign: next });
  }
  return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
}
