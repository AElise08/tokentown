"use client";

import { useEffect, useState } from "react";

export default function VisitorCounter({ initial }: { initial: number }) {
  const [visitors, setVisitors] = useState(initial);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ visitors?: unknown }>).detail;
      if (typeof detail?.visitors === "number" && Number.isFinite(detail.visitors)) {
        setVisitors(Math.max(0, Math.floor(detail.visitors)));
      }
    };
    window.addEventListener("tokentown:metrics", update);
    return () => window.removeEventListener("tokentown:metrics", update);
  }, []);

  return (
    <div className="site-visitors" aria-live="polite" aria-label={`${visitors.toLocaleString("en-US")} approximate visitor sessions since launch`}>
      <span className="site-visitors-cap"><i aria-hidden="true" /> visitors since launch</span>
      <strong>{visitors.toLocaleString("en-US")}</strong>
      <span className="site-visitors-note">approx. browser sessions</span>
    </div>
  );
}
