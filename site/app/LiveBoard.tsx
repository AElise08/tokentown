"use client";

// LIVE BOARD — keeps the leaderboard fresh on its own. Minimal client component
// (adapted from /u's LiveRefresh): it re-fetches the Server Component with
// router.refresh() every ~35s, so the page re-renders with fresh ranking data
// without any data-fetching JS living here. Pauses while the tab is hidden
// (document.hidden) and refreshes immediately when it comes back. Shows a
// discreet "live · updates automatically" indicator.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 35_000; // re-render the board every ~35s
const TICK_MS = 15_000; // advance the "updated Xm ago" label on its own

export default function LiveBoard({ renderedAt }: { renderedAt: number }) {
  const router = useRouter();
  const [, setTick] = useState(0);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    const stopRefresh = () => {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    };
    const startRefresh = () => {
      stopRefresh();
      refreshTimer = setInterval(() => {
        if (!document.hidden) router.refresh();
      }, REFRESH_MS);
    };

    // the label ticks forward on its own even between server refreshes.
    const labelTimer = setInterval(() => setTick((t) => t + 1), TICK_MS);

    const onVisibility = () => {
      if (document.hidden) {
        stopRefresh(); // hidden tab -> stop spending refreshes
      } else {
        router.refresh(); // back on the tab -> refresh now and resume the cycle
        startRefresh();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) startRefresh();

    return () => {
      stopRefresh();
      clearInterval(labelTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  // freshness since the last server render (renderedAt changes on each refresh,
  // so the label naturally snaps back to "just now").
  const mins = Math.max(0, Math.floor((Date.now() - renderedAt) / 60_000));
  const fresh = mins < 1 ? "just now" : `${mins}m ago`;

  return (
    <span className="live" aria-live="polite" title="This board refreshes itself every ~35 seconds">
      <span className="live-dot" aria-hidden="true" />
      live · updates automatically <span className="live-fresh">· {fresh}</span>
    </span>
  );
}
