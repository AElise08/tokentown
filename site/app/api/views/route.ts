import { recordSiteView } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ ok: false }, { status: 403 });
  let newVisitor = false;
  try {
    const body = (await req.json()) as { newVisitor?: unknown };
    newVisitor = body?.newVisitor === true;
  } catch {}
  const metrics = await recordSiteView(newVisitor);
  return Response.json({ ok: true, metrics }, { headers: { "Cache-Control": "no-store" } });
}
