"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { SPONSOR_PLANS, type PublicSponsor, type PublicSponsorHistory, type PublicSponsorSlot, type SponsorPlanId } from "@/lib/sponsor";
import type { SiteMetrics } from "@/lib/store";
import { formatCount } from "@/lib/format";

function slotTime(slot: PublicSponsorSlot, nowMs: number | null): string {
  if (slot.status === "active") {
    if (!nowMs || !slot.endsAt) return "flying now";
    const mins = Math.max(0, Math.ceil((slot.endsAt - nowMs) / 60_000));
    return `${Math.floor(mins / 60)}h ${mins % 60}m remaining`;
  }
  if (!slot.startsAt) return "next";
  const iso = new Date(slot.startsAt).toISOString();
  return `${iso.slice(5, 10)} · ${iso.slice(11, 16)} UTC`;
}

function availabilityTime(startsAt: number): string {
  const iso = new Date(startsAt).toISOString();
  return `${iso.slice(5, 10)} at ${iso.slice(11, 16)} UTC`;
}

function availabilityLabel(startsAt: number, nowMs: number | null): string {
  if (!nowMs) return availabilityTime(startsAt);
  const start = new Date(startsAt);
  const now = new Date(nowMs);
  const today = start.getUTCFullYear() === now.getUTCFullYear()
    && start.getUTCMonth() === now.getUTCMonth()
    && start.getUTCDate() === now.getUTCDate();
  return today ? `today · ${start.toISOString().slice(11, 16)} UTC` : availabilityTime(startsAt);
}

export default function SponsorDock({
  sponsor,
  lineup,
  history,
  metrics,
  salesEnabled,
  nextAvailableAt,
  previewCitySvg,
}: {
  sponsor: PublicSponsor | null;
  lineup: PublicSponsorSlot[];
  history: PublicSponsorHistory[];
  metrics: SiteMetrics;
  salesEnabled: boolean;
  nextAvailableAt: number;
  previewCitySvg: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [liveMetrics, setLiveMetrics] = useState(metrics);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<SponsorPlanId>("day");
  const plan = SPONSOR_PLANS[selectedPlan];
  const openCheckout = () => {
    if (salesEnabled) dialog.current?.showModal();
  };

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("sponsor");
    if (status === "paid" || status === "demo-paid")
      setNotice("Payment received · your flight is waiting for approval.");
    else if (status === "cancelled") setNotice("Checkout cancelled · nothing was charged.");
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const update = (event: Event) => setLiveMetrics((event as CustomEvent<SiteMetrics>).detail);
    window.addEventListener("tokentown:metrics", update);
    return () => window.removeEventListener("tokentown:metrics", update);
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const res = await fetch("/api/sponsors/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "Checkout unavailable");
      window.location.assign(json.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout unavailable");
      setBusy(false);
    }
  }

  return (
    <>
      <aside className="sponsor-lineup" aria-label="NORTOWN departures board">
        <div className="lineup-head">
          <span className="lineup-title">
            <small>NORTOWN AIR</small>
            <b><i aria-hidden="true" /> departures</b>
          </span>
          <button type="button" disabled={!salesEnabled} onClick={openCheckout}>
            {salesEnabled ? "from $2" : "soon"}
          </button>
        </div>
        <ol>
          {lineup.map((slot, index) => (
            <li key={slot.id} className={slot.status}>
              <span className="lineup-seq">{slot.status === "active" ? "LIVE" : String(index + 1).padStart(2, "0")}</span>
              <span className="lineup-name">
                <a href={slot.url} target="_blank" rel="sponsored noopener noreferrer">{slot.name}</a>
                <small>{slotTime(slot, nowMs)}</small>
              </span>
            </li>
          ))}
          {lineup.length < 3 && (
            <li className="available">
              <span className="lineup-seq">OPEN</span>
              <span className="lineup-name">
                <button type="button" disabled={!salesEnabled} onClick={openCheckout}>
                  {salesEnabled ? "your site here →" : "sales opening soon"}
                </button>
                <small>{salesEnabled ? `estimated ${availabilityTime(nextAvailableAt)}` : "checkout stays closed until launch"}</small>
              </span>
            </li>
          )}
        </ol>
        <div className="lineup-gap"><span aria-hidden="true">☾</span> 30 min runway reset between flights</div>
      </aside>

      <aside className="sponsor-dock" aria-label="NORTOWN sponsor">
        <header className="sponsor-showcase-head">
          <div>
            <div className="sponsor-cap"><span aria-hidden="true" /> NORTOWN AIR · sponsored</div>
            <h2>Fly your name over the city.</h2>
            <p>Your site joins the world itself: a clickable airship crosses the pixel cities and your name enters the public sponsor board.</p>
          </div>
          <div className="sponsor-metrics">{formatCount(liveMetrics.visitors)} sessions · {formatCount(liveMetrics.pageviews)} pageviews</div>
        </header>

        <div className="sponsor-preview" aria-label="Live sponsored flight preview and sponsor board">
          <div className="sponsor-preview-sky">
            <div className="sponsor-preview-label"><span>LIVE PLACEMENT PREVIEW</span><small>the real NORTOWN city</small></div>
            <div className="sponsor-real-city" aria-hidden="true" dangerouslySetInnerHTML={{ __html: previewCitySvg }} />
            <div className="sponsor-preview-airship" aria-hidden="true">
              <i className="preview-tail" /><span>{sponsor?.name || "YOUR SITE"}</span><i className="preview-gondola" />
            </div>
          </div>
          <section className="sponsor-flight-log" aria-label="Sites that have sponsored NORTOWN">
            <div className="sponsor-preview-label"><span>SPONSOR BOARD</span><small>past &amp; queued flights</small></div>
            {history.length ? (
              <ol>
                {history.map((item, index) => (
                  <li key={item.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <a href={item.url} target="_blank" rel="sponsored noopener noreferrer">{item.name}</a>
                    <small>{SPONSOR_PLANS[item.planId].label}</small>
                    <em className={item.status}>{item.status === "completed" ? "landed" : item.status}</em>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="sponsor-log-empty"><b>No flights logged yet.</b><span>The first approved sponsor takes position 01.</span></div>
            )}
          </section>
        </div>

        <div className="sponsor-booking-row">
          <fieldset className="sponsor-plan-picker">
            <legend>Choose your flight</legend>
            {(Object.values(SPONSOR_PLANS) as Array<(typeof SPONSOR_PLANS)[SponsorPlanId]>).map((item) => (
              <button key={item.id} type="button" className={selectedPlan === item.id ? "selected" : ""} onClick={() => setSelectedPlan(item.id)}>
                <span>{item.label}</span><strong>${item.priceCents / 100}</strong>
              </button>
            ))}
          </fieldset>
          <div className="sponsor-review-note">
            <b>Pay once, then we review.</b>
            <span>Approved sites start at the next open slot. Rejected sites are refunded. There is a 30-minute pause between flights.</span>
          </div>
          <button className="sponsor-launch" type="button" disabled={!salesEnabled} onClick={openCheckout}>
            <span className="sponsor-launch-copy">
              <small>{salesEnabled ? `starts ${availabilityLabel(nextAvailableAt, nowMs)}` : "sponsored flights"}</small>
              <strong>{salesEnabled ? `book ${plan.label}` : "opening soon"}</strong>
              <em>{salesEnabled ? "airship + sponsor board" : "checkout is not live yet"}</em>
            </span>
            <span className="sponsor-launch-price"><b>{salesEnabled ? `$${plan.priceCents / 100}` : "—"}</b><small aria-hidden="true">→</small></span>
          </button>
        </div>
        {notice && <div className="sponsor-notice" role="status">{notice}</div>}
        <p className="sponsor-terms-note">No traffic guarantee · labeled as sponsored · individual ad impressions and clicks are not tracked.</p>
      </aside>

      <dialog
        className="sponsor-dialog"
        ref={dialog}
        aria-labelledby="sponsor-dialog-title"
        aria-describedby="sponsor-dialog-description"
        onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close();
      }}>
        <form onSubmit={submit}>
          <div className="sponsor-dialog-head">
            <div>
              <small>NORTOWN AIR</small>
              <h2 id="sponsor-dialog-title"><span aria-hidden="true">✦</span> Put your site in the sky</h2>
            </div>
            <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
          </div>
          <p id="sponsor-dialog-description">A {plan.label} sponsored flight across every city and the public sponsor board, after approval.</p>
          <fieldset className="sponsor-modal-plans">
            <legend>Flight plan</legend>
            {(Object.values(SPONSOR_PLANS) as Array<(typeof SPONSOR_PLANS)[SponsorPlanId]>).map((item) => (
              <label key={item.id} className={selectedPlan === item.id ? "selected" : ""}>
                <input type="radio" name="planId" value={item.id} checked={selectedPlan === item.id} onChange={() => setSelectedPlan(item.id)} />
                <span>{item.label}</span><strong>${item.priceCents / 100}</strong>
              </label>
            ))}
          </fieldset>
          <div className="sponsor-fields">
            <label>Site name <input name="name" required maxLength={18} placeholder="Linear" autoFocus /></label>
            <label>Receipt email <input name="email" required type="email" placeholder="you@company.com" /></label>
            <label className="wide">One-line message <input name="tagline" required maxLength={60} placeholder="Issue tracking built for speed" /></label>
            <label className="wide">Destination URL <input name="url" required type="url" pattern="https://.*" placeholder="https://linear.app/" /></label>
          </div>
          <div className="sponsor-flight-plan" aria-label="Flight details">
            <div><span>Next takeoff</span><strong>{availabilityTime(nextAvailableAt)}</strong></div>
            <div><span>Duration</span><strong>{plan.label}</strong></div>
            <div><span>Total</span><strong>${plan.priceCents / 100} USD</strong></div>
          </div>
          <label className="sponsor-consent">
            <input name="accepted" type="checkbox" required /> <span>I own or represent this site and accept the <a href="/privacy#sponsored-flights" target="_blank">flight terms</a>.</span>
          </label>
          {error && <div className="sponsor-error" role="alert">{error}</div>}
          <button className="sponsor-pay" disabled={busy}>{busy ? "opening Stripe…" : `continue to Stripe · $${plan.priceCents / 100}`}</button>
          <small>Reviewed before takeoff. Rejected submissions are refunded. No traffic guarantee. Individual ad impressions and clicks are not tracked.</small>
        </form>
      </dialog>
    </>
  );
}
