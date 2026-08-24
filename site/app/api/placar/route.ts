import { getLeaderboard } from "@/lib/store";
import { currentSeasonId, FIRST_PUBLIC_SEASON_ID } from "@/lib/season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("season");
  const cur = currentSeasonId();
  let season = raw == null ? cur : parseInt(raw, 10);
  if (!Number.isInteger(season) || season < FIRST_PUBLIC_SEASON_ID || season > cur) season = cur;

  // janela: "7d" (ganho dos últimos 7 dias) ou "season" (padrão, temporada).
  // Closed seasons are immutable albums. A 7-day window relative to today's
  // date would compare the final snapshot with itself and return fake zeros.
  const window = season === cur && url.searchParams.get("window") === "7d" ? "7d" : "season";

  const ranking = await getLeaderboard(season, { window, limit: 100 });

  return Response.json(
    { season, currentSeason: cur, window, count: ranking.length, ranking },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}
