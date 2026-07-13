// ---------------------------------------------------------------------------
// JANELA DO RANKING — lógica PURA (sem I/O) de histórico diário e ranqueamento
// por janela. Vive num módulo próprio pra ser 100% testável sem arrastar o
// store (que faz require de @upstash/redis / crypto). Só importa TIPOS do store
// (apagados na compilação), então roda direto no `node --test`.
// ---------------------------------------------------------------------------
import type { Entry, RankedEntry } from "./store";

export type WindowKind = "season" | "7d";

// Um ponto de histórico diário: alta-marca (tokens/custo) de um dia UTC.
export interface SnapPoint {
  dayKey: string; // AAAAMMDD (UTC)
  refMs: number; // início do dia UTC em ms
  tokens: number;
  cost: number;
}

// Entrada bruta pra ranquear por janela: o registro atual + o histórico diário.
export interface UserWindowInput {
  entry: Entry;
  snaps: SnapPoint[];
}

export const MAX_SNAP_DAYS = 35; // dias de histórico guardados por usuário
export const WINDOW_7D_MS = 7 * 86400000;

// Chave de dia UTC (AAAAMMDD) a partir de um instante.
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Meia-noite UTC (ms) do dia AAAAMMDD.
export function dayKeyRefMs(dayKey: string): number {
  const y = Number(dayKey.slice(0, 4));
  const m = Number(dayKey.slice(4, 6));
  const d = Number(dayKey.slice(6, 8));
  return Date.UTC(y, m - 1, d);
}

// HASH de snapshots -> lista de pontos (ignora campos que não são AAAAMMDD).
export function parseSnaps(hash: Record<string, string | number> | null): SnapPoint[] {
  if (!hash) return [];
  const out: SnapPoint[] = [];
  for (const [dayKey, raw] of Object.entries(hash)) {
    if (!/^\d{8}$/.test(dayKey)) continue;
    const [t, c] = String(raw).split("|");
    out.push({
      dayKey,
      refMs: dayKeyRefMs(dayKey),
      tokens: Number(t) || 0,
      cost: Number(c) || 0,
    });
  }
  return out;
}

// DELTA da janela de 7 dias. Baseline = snapshot MAIS RECENTE com MAIS DE 7 dias.
// Sem baseline (usuário novo / sem histórico antigo) -> o delta é o total dele,
// sinalizado por sinceRegister (honestidade: "desde o registro", não "em 7 dias").
export function windowDelta(
  snaps: SnapPoint[],
  nowTokens: number,
  nowCost: number,
  now: number
): { tokens: number; cost: number; sinceRegister: boolean } {
  let baseline: SnapPoint | null = null;
  for (const s of snaps) {
    if (now - s.refMs > WINDOW_7D_MS) {
      if (!baseline || s.refMs > baseline.refMs) baseline = s;
    }
  }
  if (!baseline) return { tokens: nowTokens, cost: nowCost, sinceRegister: true };
  return {
    tokens: Math.max(0, nowTokens - baseline.tokens),
    cost: Math.max(0, nowCost - baseline.cost),
    sinceRegister: false,
  };
}

// Posição de UM usuário no ranking da TEMPORADA (total de tokens), com o MESMO
// critério de desempate do quadro (rankWindow): tokens desc e, no empate,
// username ASC. `members` é o topo do ZSET (member + tokens). Antes a posição
// era o ÍNDICE na ordem do ZSET, que no empate segue a ordem de inserção — e
// discordava do quadro (que desempata por username). Isso deixava /u mostrando
// uma posição diferente da tabela pra usuários com tokens iguais.
export function seasonPosition(
  members: Array<{ member: string; tokens: number }>,
  username: string,
  tokens: number
): number {
  let ahead = 0;
  for (const m of members) {
    if (m.member === username) continue; // não conta a si mesmo
    if (m.tokens > tokens || (m.tokens === tokens && m.member.localeCompare(username) < 0)) ahead++;
  }
  return ahead + 1;
}

// Ranqueia por janela. "season" -> tokens/cost absolutos (ordem por total).
// "7d" -> tokens/cost viram o delta e a lista é RE-ORDENADA por delta desc.
// seasonTokens/seasonCost preservam sempre o total (skyline/população continuam
// absolutos na tela, só tokens/custo é que mudam com a janela).
export function rankWindow(
  users: UserWindowInput[],
  window: WindowKind,
  now: number,
  limit: number
): RankedEntry[] {
  const computed = users.map(({ entry, snaps }) => {
    if (window === "7d") {
      const d = windowDelta(snaps, entry.tokens, entry.cost, now);
      return { entry, winTokens: d.tokens, winCost: d.cost, sinceRegister: d.sinceRegister };
    }
    return { entry, winTokens: entry.tokens, winCost: entry.cost, sinceRegister: false };
  });

  computed.sort(
    (a, b) =>
      b.winTokens - a.winTokens ||
      b.entry.tokens - a.entry.tokens ||
      a.entry.username.localeCompare(b.entry.username)
  );

  const out: RankedEntry[] = [];
  let position = 1;
  for (const c of computed.slice(0, limit)) {
    const ranked: RankedEntry = {
      ...c.entry,
      tokens: c.winTokens,
      cost: c.winCost,
      seasonTokens: c.entry.tokens,
      seasonCost: c.entry.cost,
      position: position++,
    };
    if (window === "7d") ranked.sinceRegister = c.sinceRegister;
    out.push(ranked);
  }
  return out;
}
