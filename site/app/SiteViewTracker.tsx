"use client";

import { useEffect } from "react";

export default function SiteViewTracker() {
  useEffect(() => {
    const key = "tt-site-session";
    let sessionId = sessionStorage.getItem(key) || "";
    const newVisitor = !sessionId;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem(key, sessionId);
    }
    fetch("/api/views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newVisitor, sessionId }),
      keepalive: true,
    })
      .then((res) => res.json())
      .then((json) => {
        if (json?.metrics) window.dispatchEvent(new CustomEvent("tokentown:metrics", { detail: json.metrics }));
      })
      .catch(() => {});
  }, []);
  return null;
}
