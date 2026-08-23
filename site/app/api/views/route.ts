import { getSiteMetrics, recordSiteView, reserveSiteView } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ ok: false }, { status: 403 });
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 512)
    return Response.json({ ok: false, error: "request too large" }, { status: 413 });
  let newVisitor = false;
  let sessionId = "";
  try {
    const raw = await req.text();
    if (raw.length > 512)
      return Response.json({ ok: false, error: "request too large" }, { status: 413 });
    const body = JSON.parse(raw) as { newVisitor?: unknown; sessionId?: unknown };
    newVisitor = body?.newVisitor === true;
    sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  } catch {}
  if (!/^[a-f0-9-]{20,64}$/i.test(sessionId))
    return Response.json({ ok: false, error: "invalid session" }, { status: 400 });
  if (!(await reserveSiteView(sessionId)))
    return Response.json(
      { ok: true, metrics: await getSiteMetrics(), limited: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  const metrics = await recordSiteView(newVisitor);
  return Response.json({ ok: true, metrics }, { headers: { "Cache-Control": "no-store" } });
}
