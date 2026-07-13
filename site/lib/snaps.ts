// ---------------------------------------------------------------------------
// SNAPSHOT READER (read-only) — the weekly "city lights" heatmap needs each
// user's daily high-water history, which the store writes but does not expose
// through a public getter. store.ts owns the WRITE path and the KV; this is a
// thin READ mirror over the SAME key scheme and the SAME two backends store.ts
// uses (Upstash in prod, an in-memory map on globalThis in dev), so the site
// can read history WITHOUT modifying store.ts.
//
// Fully defensive: any surprise (missing global, Redis error, bad shape) yields
// [] and the heatmap simply degrades to "no lights yet". Parsing reuses the
// pure parseSnaps from ./window.
// ---------------------------------------------------------------------------
import { parseSnaps, type SnapPoint } from "./window";

// mirrors store.ts's private kSnap: HASH keyed by UTC day (AAAAMMDD).
const kSnap = (season: number, username: string) => `s${season}:snap:${username}`;

// store.ts keeps the in-memory backend on globalThis precisely so it is shared
// across the RSC and route bundles; we read the same shape here.
interface MemShape {
  hashes?: Map<string, Map<string, string | number>>;
}

export async function getUserSnaps(season: number, username: string): Promise<SnapPoint[]> {
  const key = kSnap(season, username);
  try {
    const hasRedis =
      !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

    if (hasRedis) {
      const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      });
      const hash = (await redis.hgetall(key)) as Record<string, string | number> | null;
      return parseSnaps(hash);
    }

    // in-memory (dev): read the same global map the store writes into.
    const mem = (globalThis as unknown as { __ttpMem?: MemShape }).__ttpMem;
    const m = mem?.hashes?.get(key);
    if (!m || m.size === 0) return [];
    return parseSnaps(Object.fromEntries(m));
  } catch {
    return [];
  }
}
