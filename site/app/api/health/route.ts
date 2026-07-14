import { NextResponse } from "next/server";
import { storeHealth, getUserSnaps, sanitizeUsername } from "@/lib/store";
import { currentSeasonId } from "@/lib/season";

export const dynamic = "force-dynamic";

// Diagnóstico: NÃO expõe valores — só NOMES de env vars que parecem credenciais
// de Redis, com flags (https? / tamanho) pra sabermos se o Upstash está setado
// em produção e com qual prefixo. Remover depois de resolver o deploy.
export async function GET(req: Request) {
  // SONDA DO HEATMAP: ?snaps=<username> -> diz QUAIS dias (AAAAMMDD) existem no
  // kSnap desse usuário e QUANTOS, lendo pelo MESMO backend do store. Só nomes de
  // dia e contagem — NUNCA tokens/custo/valores. Serve pra confirmar se os
  // snapshots retro-datados do heatmap realmente persistem no Redis em produção.
  const snapUser = new URL(req.url).searchParams.get("snaps");
  if (snapUser != null) {
    const u = sanitizeUsername(snapUser);
    if (!u) return NextResponse.json({ ok: false, error: "username inválido" }, { status: 400 });
    const season = currentSeasonId();
    const snaps = await getUserSnaps(season, u);
    const days = snaps.map((p) => p.dayKey).sort();
    return NextResponse.json({ ok: true, snaps: { user: u, season, count: days.length, days } });
  }

  const env = process.env as Record<string, string | undefined>;
  const redisEnvKeys = Object.keys(env)
    .filter(
      (k) =>
        /(URL|TOKEN|REST)/i.test(k) &&
        /(UPSTASH|REDIS|KV|STORAGE|TOKENTOWN)/i.test(k)
    )
    .sort()
    .map((k) => ({
      key: k,
      https: /^https:\/\//.test(env[k] || ""),
      len: (env[k] || "").length,
    }));
  const storage = await storeHealth(); // backend ativo + roundtrip real (com timeout — não pendura)
  return NextResponse.json({ ok: true, storage, redisEnvKeys });
}
