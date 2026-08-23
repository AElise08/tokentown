"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicSponsor, PublicSponsorSlot } from "@/lib/sponsor";
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

export default function SponsorDock({
  sponsor,
  lineup,
  metrics,
  salesEnabled,
  nextAvailableAt,
}: {
  sponsor: PublicSponsor | null;
  lineup: PublicSponsorSlot[];
  metrics: SiteMetrics;
  salesEnabled: boolean;
  nextAvailableAt: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [liveMetrics, setLiveMetrics] = useState(metrics);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
            {salesEnabled ? "fly · $2" : "soon"}
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
        <div className="lineup-gap"><span aria-hidden="true">☾</span> 30 min runway reset between 24h flights</div>
      </aside>

      <aside className="sponsor-dock" aria-label="NORTOWN sponsor">
        <div className="sponsor-bottom-copy">
          <div className="sponsor-cap">{sponsor ? "now flying" : salesEnabled ? "next sponsored flight" : "sponsored flights"}</div>
          {sponsor ? (
            <a className="sponsor-live" href={sponsor.url} target="_blank" rel="sponsored noopener noreferrer">
              <strong>{sponsor.name}</strong><span>{sponsor.tagline}</span>
            </a>
          ) : (
            <div className="sponsor-empty">
              <strong>{salesEnabled ? "put your site in the city sky" : "flights opening soon"}</strong>
              <span>{salesEnabled ? `next departure estimated ${availabilityTime(nextAvailableAt)}` : "the city is ready; checkout is not live yet"}</span>
            </div>
          )}
          <div className="sponsor-metrics">
            {formatCount(liveMetrics.visitors)} sessions · {formatCount(liveMetrics.pageviews)} pageviews
          </div>
        </div>
        <button className="sponsor-launch" type="button" disabled={!salesEnabled} onClick={openCheckout}>
          {salesEnabled ? "put your site in the sky · $2" : "sponsored flights · soon"}
        </button>
        {notice && <div className="sponsor-notice" role="status">{notice}</div>}
      </aside>

      <dialog className="sponsor-dialog" ref={dialog} onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close();
      }}>
        <form onSubmit={submit}>
          <div className="sponsor-dialog-head">
            <div><span>✦</span> launch a sponsored flight</div>
            <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
          </div>
          <p>Your name flies inside NORTOWN&apos;s cities and appears on the departures board for 24 hours after approval.</p>
          <label>Site name <input name="name" required maxLength={18} placeholder="Linear" /></label>
          <label>Short line <input name="tagline" required maxLength={60} placeholder="Issue tracking built for speed" /></label>
          <label>Destination <input name="url" required type="url" pattern="https://.*" placeholder="https://linear.app/" /></label>
          <label>Receipt email <input name="email" required type="email" placeholder="you@company.com" /></label>
          <label className="sponsor-consent">
            <input name="accepted" type="checkbox" required /> <span>I own or represent this site and accept the <a href="/privacy#sponsored-flights" target="_blank">flight terms</a>. No adult, gambling, deceptive, illegal or malicious content.</span>
          </label>
          <div className="sponsor-price">
            <span>estimated departure {availabilityTime(nextAvailableAt)} · 24h flight</span>
            <strong>$2.00 USD</strong>
          </div>
          {error && <div className="sponsor-error" role="alert">{error}</div>}
          <button className="sponsor-pay" disabled={busy}>{busy ? "opening checkout…" : "continue to secure checkout"}</button>
          <small>No traffic guarantee. Rejected campaigns are refunded. Site-wide session and pageview totals are public; individual ad impressions and clicks are not tracked.</small>
        </form>
      </dialog>
    </>
  );
}
