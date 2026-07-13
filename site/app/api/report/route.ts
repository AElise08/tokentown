import { submitReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Teto do corpo do POST. Um report legítimo é minúsculo (username + key +
// números + city, cuja parte bruta já é limitada a 2KB). Sem este guarda,
// `req.json()` bufferiza o corpo inteiro em memória — um POST de 10MB/1GB
// derrubaria o processo (DoS). Lemos o stream com corte e abortamos cedo.
const MAX_BODY_BYTES = 16 * 1024; // 16KB

async function readBodyLimited(req: Request, max: number): Promise<string | null> {
  const cl = req.headers.get("content-length");
  if (cl != null && Number(cl) > max) return null; // corta pelo header quando confiável
  if (!req.body) {
    const t = await req.text();
    return new TextEncoder().encode(t).length > max ? null : t;
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > max) {
      try {
        await reader.cancel();
      } catch {
        /* ignora */
      }
      return null; // estourou o teto no meio do stream -> aborta sem bufferizar tudo
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(req: Request) {
  const text = await readBodyLimited(req, MAX_BODY_BYTES);
  if (text === null) {
    return Response.json(
      { ok: false, error: `corpo grande demais (máx ${MAX_BODY_BYTES} bytes)` },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, error: "corpo não é JSON válido" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const result = await submitReport({
    username: b.username as string,
    key: b.key as string,
    seasonId: b.seasonId as number,
    tokens: b.tokens as number,
    cost: b.cost as number,
    residents: b.residents as number,
    buildings: b.buildings as number,
    city: b.city, // payload BRUTO; sanitizado dentro de submitReport
    profile: b.profile, // payload BRUTO do perfil; sanitizado dentro de submitReport
    setup: b.setup, // payload BRUTO do setup; sanitizado dentro de submitReport
    dailyTokens: b.dailyTokens, // payload BRUTO do breakdown diário; sanitizado dentro de submitReport
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }
  return Response.json(
    { ok: true, updated: result.updated, entry: result.entry },
    { status: 200 }
  );
}
