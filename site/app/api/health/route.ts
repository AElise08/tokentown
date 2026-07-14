import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Diagnóstico: NÃO expõe valores — só NOMES de env vars que parecem credenciais
// de Redis, com flags (https? / tamanho) pra sabermos se o Upstash está setado
// em produção e com qual prefixo. Remover depois de resolver o deploy.
export async function GET() {
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
  return NextResponse.json({ ok: true, redisEnvKeys });
}
