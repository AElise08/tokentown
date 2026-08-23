"use client";

import { useState } from "react";
import type { SponsorCampaign } from "@/lib/sponsor";

export default function SponsorAdminPage() {
  const [key, setKey] = useState("");
  const [campaigns, setCampaigns] = useState<SponsorCampaign[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const res = await fetch("/api/sponsors/admin", { headers: { "x-sponsor-admin-key": key } });
    if (!res.ok) return setMessage("Access denied");
    const json = await res.json();
    setCampaigns(json.campaigns || []);
    setMessage("");
  }

  async function act(id: string, action: "approve" | "reject" | "pause" | "resume") {
    const res = await fetch("/api/sponsors/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sponsor-admin-key": key },
      body: JSON.stringify({ id, action }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage(json.error || "Action failed");
      return;
    }
    await load();
  }

  return (
    <main className="wrap sponsor-admin">
      <a href="/" className="back">‹ back to NORTOWN</a>
      <h1>Sponsor flights</h1>
      <div className="admin-key">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Admin key" />
        <button onClick={load}>Load campaigns</button>
      </div>
      {message && <p className="sponsor-error">{message}</p>}
      <div className="admin-campaigns">
        {campaigns.map((c) => (
          <article key={c.id}>
            <div><b>{c.name}</b><span className={`admin-status ${c.status}`}>{c.status}</span></div>
            <p>{c.tagline}</p>
            <a href={c.url} target="_blank" rel="noopener noreferrer">{c.url}</a>
            <small>{c.email} · created {new Date(c.createdAt).toLocaleString()}</small>
            {c.startsAt && <small>{new Date(c.startsAt).toLocaleString()} → {new Date(c.endsAt!).toLocaleString()}</small>}
            <div className="admin-actions">
              {c.status === "paid" && <button onClick={() => act(c.id, "approve")}>Approve & schedule</button>}
              {c.status === "paused" && <button onClick={() => act(c.id, "resume")}>Resume remaining time</button>}
              {(["paid", "scheduled", "active"] as string[]).includes(c.status) &&
                <button onClick={() => act(c.id, "pause")}>Pause</button>}
              {(c.status === "paid" || c.status === "paused") &&
                <button className="danger" onClick={() => act(c.id, "reject")}>Reject / refund</button>}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
