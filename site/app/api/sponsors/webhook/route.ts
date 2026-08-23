import Stripe from "stripe";
import { markSponsorPaid } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get("stripe-signature");
  if (!stripe || !secret || !signature)
    return Response.json({ ok: false, error: "webhook unavailable" }, { status: 503 });

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_WEBHOOK_BYTES)
    return Response.json({ ok: false, error: "request too large" }, { status: 413 });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_WEBHOOK_BYTES)
    return Response.json({ ok: false, error: "request too large" }, { status: 413 });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch {
    return Response.json({ ok: false, error: "invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") return Response.json({ received: true });
    const id = session.metadata?.campaignId || session.client_reference_id;
    if (id) {
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : undefined;
      await markSponsorPaid({
        id,
        checkoutSessionId: session.id,
        paymentIntentId,
        email: session.customer_details?.email || undefined,
      });
    }
  }
  return Response.json({ received: true });
}
