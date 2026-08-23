import { NextResponse } from "next/server";
import { storeHealth } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const storage = await storeHealth();
  return NextResponse.json(
    { ok: storage.roundtrip, storage },
    {
      status: storage.roundtrip ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
