import { getLeaderboard } from "@/lib/store";
import { currentSeasonId } from "@/lib/season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("season");
  const cur = currentSeasonId();
  let season = raw == null ? cur : parseInt(raw, 10);
  if (!Number.isInteger(season) || season < 0) season = cur;

  // janela: "7d" (ganho dos últimos 7 dias) ou "season" (padrão, temporada).
  const window = url.searchParams.get("window") === "7d" ? "7d" : "season";

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
