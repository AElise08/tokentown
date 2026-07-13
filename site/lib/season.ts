// Temporadas globais de 28 dias por calendário — MESMA fórmula do app TOKENTOWN.
// Toda temporada começa/termina no mesmo instante pra todo mundo (UTC).
export const SEASON_EPOCH = Date.UTC(2026, 6, 1); // 01/07/2026 00:00 UTC
export const SEASON_MS = 28 * 86400000; // 28 dias

export function currentSeasonId(now: number = Date.now()): number {
  return Math.floor((now - SEASON_EPOCH) / SEASON_MS);
}

export function seasonStart(seasonId: number): number {
  return SEASON_EPOCH + seasonId * SEASON_MS;
}

export function seasonEnd(seasonId: number): number {
  return seasonStart(seasonId + 1);
}

// Quantos dias inteiros faltam pra temporada atual acabar (>= 0).
export function daysRemaining(now: number = Date.now()): number {
  const end = seasonEnd(currentSeasonId(now));
  return Math.max(0, Math.ceil((end - now) / 86400000));
}

// FINALE — a ÚLTIMA noite da temporada: verdadeiro só no último dia (daysLeft===1).
// Durante o finale o site inteiro solta fogos. now injetável pra testar as bordas.
export function isFinale(now: number = Date.now()): boolean {
  return daysRemaining(now) === 1;
}

// GRACE de relógio pra report de temporada vizinha (clock skew na virada): 60 min.
export const REPORT_GRACE_MS = 60 * 60 * 1000;

// PÓDIO CONGELA — janela de temporada aceita num report. A atual sempre entra.
// A ANTERIOR só nos primeiros 60 min da nova (relógio atrasado do cliente na
// virada); depois disso o pódio está congelado e nada da temporada velha entra.
// A SEGUINTE só nos últimos 60 min da atual (relógio adiantado do cliente).
// Puro + now injetável -> testável sem I/O.
export function isReportSeasonValid(seasonId: number, now: number = Date.now()): boolean {
  if (!Number.isInteger(seasonId) || seasonId < 0) return false;
  const cur = currentSeasonId(now);
  if (seasonId === cur) return true;
  if (seasonId === cur - 1) return now - seasonStart(cur) < REPORT_GRACE_MS; // grace da virada
  if (seasonId === cur + 1) return seasonEnd(cur) - now < REPORT_GRACE_MS; // cliente adiantado
  return false;
}

// Intervalo legível de uma temporada (pt-BR, datas em UTC).
export function seasonRange(seasonId: number): { start: Date; end: Date } {
  return { start: new Date(seasonStart(seasonId)), end: new Date(seasonEnd(seasonId) - 1) };
}

// Dias já decorridos da temporada (fracionário, >= 1 pra não explodir a projeção
// no comecinho). Temporada encerrada satura em 28 dias.
export function daysElapsed(seasonId: number, now: number = Date.now()): number {
  const elapsedMs = Math.min(now, seasonEnd(seasonId)) - seasonStart(seasonId);
  return Math.max(1, elapsedMs / 86400000);
}

// Projeção anualizada do custo: soma ÷ dias decorridos × 365. É a fórmula da
// manchete "TOP N DEVS CONSOMEM ≈ US$ X/ANO".
export function projectAnnualCost(sumCost: number, seasonId: number, now: number = Date.now()): number {
  if (!Number.isFinite(sumCost) || sumCost <= 0) return 0;
  return (sumCost / daysElapsed(seasonId, now)) * 365;
}
