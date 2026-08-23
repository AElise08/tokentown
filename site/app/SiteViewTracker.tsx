"use client";

import { useEffect } from "react";

export default function SiteViewTracker() {
  useEffect(() => {
    const key = "tt-site-visitor-counted";
    const newVisitor = sessionStorage.getItem(key) !== "1";
    if (newVisitor) sessionStorage.setItem(key, "1");
    fetch("/api/views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newVisitor }),
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
