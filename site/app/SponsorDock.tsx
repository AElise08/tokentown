"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicSponsor } from "@/lib/sponsor";
import type { SiteMetrics } from "@/lib/store";
import { formatCount } from "@/lib/format";

export default function SponsorDock({ sponsor, metrics }: { sponsor: PublicSponsor | null; metrics: SiteMetrics }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [liveMetrics, setLiveMetrics] = useState(metrics);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("sponsor");
    if (status === "paid" || status === "demo-paid")
      setNotice("Payment received · your flight is waiting for approval.");
    else if (status === "cancelled") setNotice("Checkout cancelled · nothing was charged.");
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
      <div className="site-flight" aria-label={sponsor ? `Sponsored flight: ${sponsor.name}` : "TOKENTOWN airship"}>
        {sponsor ? (
          <a className="site-airship" href={sponsor.url} target="_blank" rel="sponsored noopener noreferrer">
            <span className="airship-tail" aria-hidden="true" />
            <span className="airship-envelope"><strong>{sponsor.name}</strong></span>
            <span className="airship-gondola" aria-hidden="true" />
          </a>
        ) : (
          <div className="site-airship" aria-hidden="true">
            <span className="airship-tail" />
            <span className="airship-envelope"><strong>TOKENTOWN</strong></span>
            <span className="airship-gondola" />
          </div>
        )}
      </div>

      <aside className="sponsor-dock" aria-label="TOKENTOWN sponsor">
        <div className="sponsor-bottom-copy">
          <div className="sponsor-cap">{sponsor ? "now flying" : "next sponsored flight"}</div>
          {sponsor ? (
            <a className="sponsor-live" href={sponsor.url} target="_blank" rel="sponsored noopener noreferrer">
              <strong>{sponsor.name}</strong><span>{sponsor.tagline}</span>
            </a>
          ) : (
            <div className="sponsor-empty"><strong>put your site in the sky</strong><span>one clear 24-hour flight</span></div>
          )}
          <div className="sponsor-metrics">
            {formatCount(liveMetrics.visitors)} visitors · {formatCount(liveMetrics.pageviews)} pageviews
          </div>
        </div>
        <button className="sponsor-launch" type="button" onClick={() => dialog.current?.showModal()}>
          put your site in the sky · $2
        </button>
        {notice && <div className="sponsor-notice" role="status">{notice}</div>}
      </aside>

      <dialog className="sponsor-dialog" ref={dialog} onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close();
      }}>
        <form onSubmit={submit}>
          <div className="sponsor-dialog-head">
            <div><span>◍</span> launch a sponsored flight</div>
            <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
          </div>
          <p>Your name flies across TOKENTOWN and appears in the sponsor strip below for 24 hours after approval.</p>
          <label>Site name <input name="name" required maxLength={18} placeholder="Linear" /></label>
          <label>Short line <input name="tagline" required maxLength={60} placeholder="Issue tracking built for speed" /></label>
          <label>Destination <input name="url" required type="url" pattern="https://.*" placeholder="https://linear.app/" /></label>
          <label>Receipt email <input name="email" required type="email" placeholder="you@company.com" /></label>
          <label className="sponsor-consent">
            <input name="accepted" type="checkbox" required /> I own or represent this site and accept manual review. No adult, gambling, deceptive, illegal or malicious content.
          </label>
          <div className="sponsor-price"><span>24-hour flight</span><strong>$2.00 USD</strong></div>
          {error && <div className="sponsor-error" role="alert">{error}</div>}
          <button className="sponsor-pay" disabled={busy}>{busy ? "opening checkout…" : "continue to secure checkout"}</button>
          <small>No traffic guarantee. Rejected campaigns are refunded. Site-wide visitor and pageview totals are public; individual ad impressions and clicks are not tracked.</small>
        </form>
      </dialog>
    </>
  );
}
