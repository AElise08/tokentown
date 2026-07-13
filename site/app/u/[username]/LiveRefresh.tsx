"use client";

// AO VIVO — a cidade de alguém, respirando. Componente client MÍNIMO: re-busca
// o Server Component com router.refresh() a cada ~60s (a página re-renderiza
// com dados frescos, sem JS de dados aqui). Pausa quando a aba está escondida
// (document.hidden) e re-atualiza na volta. Mostra um indicador discreto de
// frescor perto do "último report".
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 60_000; // re-render a cada ~60s
const TICK_MS = 20_000; // atualiza só o rótulo "há X min"

export default function LiveRefresh({ renderedAt }: { renderedAt: number }) {
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

    // rótulo "há X min" avança sozinho mesmo sem refresh do servidor.
    const labelTimer = setInterval(() => setTick((t) => t + 1), TICK_MS);

    const onVisibility = () => {
      if (document.hidden) {
        stopRefresh(); // aba escondida -> não gasta refresh
      } else {
        router.refresh(); // voltou pra aba -> atualiza na hora e retoma o ciclo
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

  // freshness since the last server render (renderedAt changes on every refresh,
  // so the label naturally snaps back to "just now").
  const mins = Math.max(0, Math.floor((Date.now() - renderedAt) / 60_000));
  const fresh = mins < 1 ? "just now" : `${mins}m ago`;

  return (
    <span className="live" aria-live="polite" title="This page refreshes itself every minute">
      <span className="live-dot" aria-hidden="true" />
      auto-refreshing · {fresh}
    </span>
  );
}
