// og:image da página /u/[username] — Next injeta as meta tags og:image
// automaticamente a partir deste arquivo. A arte vem do módulo compartilhado.
import { renderOgImage } from "./og-card";

export { size, contentType } from "./og-card";
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // usa os dados do momento (sem cache esperto)
export const alt = "The dev's city on the TOKENTOWN leaderboard, with tokens, residents and buildings";

export default async function Image({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return renderOgImage(username);
}
