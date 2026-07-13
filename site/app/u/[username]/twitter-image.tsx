// twitter card da página /u/[username] — mesma arte do og:image. A presença
// deste arquivo faz o Next emitir twitter:card=summary_large_image + twitter:image.
import { renderOgImage } from "./og-card";

export { size, contentType } from "./og-card";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "The dev's city on the TOKENTOWN leaderboard, with tokens, residents and buildings";

export default async function Image({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return renderOgImage(username);
}
