// Testes da janela do ranking (7d) + projeção/format da manchete. Puros, sem
// I/O. Roda com Node 22+/24 (strip de tipos nativo):  node --test lib/window.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  windowDelta,
  rankWindow,
  seasonPosition,
  parseSnaps,
  utcDayKey,
  dayKeyRefMs,
  WINDOW_7D_MS,
  MAX_SNAP_DAYS,
} from "./window.ts";
import {
  projectAnnualCost,
  daysElapsed,
  seasonStart,
  seasonEnd,
  SEASON_MS,
  isFinale,
  isReportSeasonValid,
  REPORT_GRACE_MS,
  currentSeasonId,
} from "./season.ts";
import { formatAnnualCost } from "./format.ts";

const DAY = 86400000;
// "agora" fixo: 2026-07-20 12:00 UTC (determinístico).
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

const snap = (dayKey, tokens, cost) => ({ dayKey, refMs: dayKeyRefMs(dayKey), tokens, cost });
const mkEntry = (username, tokens, cost, extra = {}) => ({
  username,
  tokens,
  cost,
  residents: extra.residents ?? 0,
  buildings: extra.buildings ?? 0,
  lastReport: extra.lastReport ?? 0,
  city: extra.city ?? null,
});

// ===========================================================================
// dias / chaves UTC
// ===========================================================================
test("utcDayKey / dayKeyRefMs: ida e volta em UTC", () => {
  assert.equal(utcDayKey(Date.UTC(2026, 6, 10, 23, 59)), "20260710");
  assert.equal(dayKeyRefMs("20260710"), Date.UTC(2026, 6, 10));
  assert.equal(WINDOW_7D_MS, 7 * DAY);
  assert.equal(MAX_SNAP_DAYS, 35);
});

test("parseSnaps: lê hash e ignora campos que não são AAAAMMDD", () => {
  const pts = parseSnaps({ "20260710": "1000|5.5", "20260712": "1500|8", lixo: "9|9" });
  assert.equal(pts.length, 2);
  const p = pts.find((x) => x.dayKey === "20260710");
  assert.equal(p.tokens, 1000);
  assert.equal(p.cost, 5.5);
  assert.equal(p.refMs, Date.UTC(2026, 6, 10));
});

// ===========================================================================
// windowDelta — histórico sintético
// ===========================================================================
test("7d: usuário com snapshot de 10 dias atrás -> delta = agora - baseline", () => {
  // 2026-07-10 tem ~10,5 dias -> ELEGÍVEL (> 7 dias).
  const d = windowDelta([snap("20260710", 1000, 5)], 3000, 15, NOW);
  assert.equal(d.sinceRegister, false);
  assert.equal(d.tokens, 2000);
  assert.equal(d.cost, 10);
});

test("7d: usuário NOVO (sem snapshots) -> delta = total, 'desde o registro'", () => {
  const d = windowDelta([], 3000, 15, NOW);
  assert.equal(d.sinceRegister, true);
  assert.equal(d.tokens, 3000);
  assert.equal(d.cost, 15);
});

test("7d: só há snapshot recente (3 dias) -> ainda 'desde o registro'", () => {
  // 2026-07-17 tem ~3,5 dias -> NÃO elegível (nenhum > 7 dias).
  const d = windowDelta([snap("20260717", 2500, 12)], 3000, 15, NOW);
  assert.equal(d.sinceRegister, true);
  assert.equal(d.tokens, 3000);
});

test("7d: baseline = snapshot MAIS RECENTE dentre os com +7 dias", () => {
  // 10/07 (10,5d) e 12/07 (8,5d) ambos elegíveis; escolhe o mais recente (12/07).
  const d = windowDelta([snap("20260710", 1000, 5), snap("20260712", 1500, 8)], 3000, 15, NOW);
  assert.equal(d.sinceRegister, false);
  assert.equal(d.tokens, 1500);
  assert.equal(d.cost, 7);
});

test("7d: snapshot com menos de 7 dias é ignorado como baseline", () => {
  // 18/07 (2,5d) é ignorado; usa 10/07.
  const d = windowDelta([snap("20260710", 1000, 5), snap("20260718", 2500, 12)], 3000, 15, NOW);
  assert.equal(d.tokens, 2000);
  assert.equal(d.cost, 10);
});

test("7d: delta nunca fica negativo (guarda contra regressão de dados)", () => {
  const d = windowDelta([snap("20260710", 5000, 50)], 3000, 15, NOW);
  assert.equal(d.tokens, 0);
  assert.equal(d.cost, 0);
  assert.equal(d.sinceRegister, false);
});

// ===========================================================================
// rankWindow — ordena por janela e preserva o absoluto (seasonTokens)
// ===========================================================================
test("rankWindow 7d: re-ordena por ganho da janela e marca sinceRegister", () => {
  const A = { entry: mkEntry("veterano", 10000, 100), snaps: [snap("20260710", 9000, 90)] };
  const B = { entry: mkEntry("novato", 3000, 30), snaps: [] };

  const seven = rankWindow([A, B], "7d", NOW, 100);
  // B ganhou 3000 nos últimos 7 dias; A só 1000 -> B na frente.
  assert.equal(seven[0].username, "novato");
  assert.equal(seven[0].position, 1);
  assert.equal(seven[0].tokens, 3000); // delta = total
  assert.equal(seven[0].seasonTokens, 3000); // absoluto preservado
  assert.equal(seven[0].sinceRegister, true);

  assert.equal(seven[1].username, "veterano");
  assert.equal(seven[1].tokens, 1000); // delta da janela
  assert.equal(seven[1].cost, 10);
  assert.equal(seven[1].seasonTokens, 10000); // absoluto preservado (skyline)
  assert.equal(seven[1].seasonCost, 100);
  assert.equal(seven[1].sinceRegister, false);
});

test("rankWindow season: ordena pelo total e não marca sinceRegister", () => {
  const A = { entry: mkEntry("veterano", 10000, 100), snaps: [snap("20260710", 9000, 90)] };
  const B = { entry: mkEntry("novato", 3000, 30), snaps: [] };

  const s = rankWindow([A, B], "season", NOW, 100);
  assert.equal(s[0].username, "veterano");
  assert.equal(s[0].tokens, 10000);
  assert.equal(s[0].seasonTokens, 10000);
  assert.equal(s[0].sinceRegister, undefined);
  assert.equal(s[1].username, "novato");
});

test("rankWindow: respeita o limit", () => {
  const A = { entry: mkEntry("a", 10000, 100), snaps: [] };
  const B = { entry: mkEntry("b", 3000, 30), snaps: [] };
  assert.equal(rankWindow([A, B], "7d", NOW, 1).length, 1);
});

test("7d: snapshot só de HOJE -> 'desde o registro' (delta = total)", () => {
  const today = utcDayKey(NOW);
  const d = windowDelta([snap(today, 2000, 10)], 3000, 15, NOW);
  assert.equal(d.sinceRegister, true);
  assert.equal(d.tokens, 3000);
});

test("7d: borda EXATA de 7 dias não é baseline; 1ms além já é", () => {
  // now - refMs === WINDOW_7D_MS -> NÃO é > 7d -> não elegível -> desde o registro
  const exact = { dayKey: "borda", refMs: NOW - WINDOW_7D_MS, tokens: 1000, cost: 5 };
  const d0 = windowDelta([exact], 3000, 15, NOW);
  assert.equal(d0.sinceRegister, true);
  assert.equal(d0.tokens, 3000);
  // 1ms mais velho -> vira baseline
  const older = { dayKey: "borda", refMs: NOW - WINDOW_7D_MS - 1, tokens: 1000, cost: 5 };
  const d1 = windowDelta([older], 3000, 15, NOW);
  assert.equal(d1.sinceRegister, false);
  assert.equal(d1.tokens, 2000);
});

// ===========================================================================
// seasonPosition — posição do /u coerente com o quadro (desempate por username)
// ===========================================================================
test("seasonPosition: no EMPATE desempata por username ASC (coerente com rankWindow)", () => {
  // dois empatados em 5000; inserção reversa (zzz antes de aaa) como no ZSET
  const A = { entry: mkEntry("aaa-tie", 5000, 1), snaps: [] };
  const Z = { entry: mkEntry("zzz-tie", 5000, 1), snaps: [] };
  const board = rankWindow([Z, A], "season", NOW, 100);
  const pos = Object.fromEntries(board.map((r) => [r.username, r.position]));
  assert.equal(pos["aaa-tie"], 1); // quadro: username ASC
  assert.equal(pos["zzz-tie"], 2);

  // members na ORDEM DO ZSET (empate -> ordem de inserção: zzz, aaa)
  const members = [
    { member: "zzz-tie", tokens: 5000 },
    { member: "aaa-tie", tokens: 5000 },
  ];
  // FIX: seasonPosition concorda com o quadro
  assert.equal(seasonPosition(members, "aaa-tie", 5000), pos["aaa-tie"]); // 1
  assert.equal(seasonPosition(members, "zzz-tie", 5000), pos["zzz-tie"]); // 2

  // BUG ANTIGO (posição = índice na ordem do ZSET) daria zzz #1 / aaa #2 -> INCOERENTE
  const oldPos = (u) => members.findIndex((m) => m.member === u) + 1;
  assert.equal(oldPos("zzz-tie"), 1); // antigo colocava zzz no topo (errado)
  assert.notEqual(oldPos("aaa-tie"), pos["aaa-tie"]); // discordava do quadro
});

test("seasonPosition: tokens distintos -> 1 + (quantos têm mais tokens)", () => {
  const members = [
    { member: "a", tokens: 100 },
    { member: "b", tokens: 300 },
    { member: "c", tokens: 200 },
  ];
  assert.equal(seasonPosition(members, "b", 300), 1);
  assert.equal(seasonPosition(members, "c", 200), 2);
  assert.equal(seasonPosition(members, "a", 100), 3);
});

// ===========================================================================
// manchete: projeção anualizada + formatação
// ===========================================================================
test("projectAnnualCost: soma ÷ dias decorridos × 365", () => {
  const now = seasonStart(0) + 10 * DAY;
  assert.equal(daysElapsed(0, now), 10);
  assert.equal(projectAnnualCost(100, 0, now), (100 / 10) * 365); // 3650
});

test("projectAnnualCost: 0/negativo -> 0; cresce com a soma", () => {
  const now = seasonStart(0) + 10 * DAY;
  assert.equal(projectAnnualCost(0, 0, now), 0);
  assert.ok(projectAnnualCost(200, 0, now) > projectAnnualCost(100, 0, now));
});

test("daysElapsed: piso de 1 dia no comecinho e satura em 28 na temporada fechada", () => {
  assert.equal(daysElapsed(0, seasonStart(0) + 0.2 * DAY), 1); // piso
  assert.equal(daysElapsed(0, seasonStart(0) + 40 * DAY), SEASON_MS / DAY); // 28, saturado
  assert.equal(seasonEnd(0) - seasonStart(0), SEASON_MS);
});

test("formatAnnualCost: arredonda com esperteza (en-US)", () => {
  assert.equal(formatAnnualCost(127000), "$127k");
  assert.equal(formatAnnualCost(48000), "$48k");
  assert.equal(formatAnnualCost(53050), "$53k");
  assert.equal(formatAnnualCost(1_200_000), "$1.2M");
  assert.equal(formatAnnualCost(1_234_567_000), "$1.2B");
  assert.equal(formatAnnualCost(900), "$900");
  assert.equal(formatAnnualCost(-5), "$0");
});

// ===========================================================================
// FINALE — verdadeiro só no ÚLTIMO dia da temporada (daysLeft===1)
// ===========================================================================
test("isFinale: verdadeiro na última noite, falso antes e no resto", () => {
  const end = seasonEnd(0);
  const start = seasonStart(0);
  assert.equal(isFinale(end - 1), true); // 1ms antes do fim -> último dia
  assert.equal(isFinale(end - DAY), true); // exatamente 1 dia restante
  assert.equal(isFinale(end - DAY - 1), false); // 1ms além de 1 dia -> 2 dias
  assert.equal(isFinale(end - 2 * DAY), false); // 2 dias restantes
  assert.equal(isFinale(start), false); // começo: 28 dias
  assert.equal(isFinale(start + 5 * DAY), false); // meio da temporada
  // vale pra qualquer temporada (borda da T3)
  assert.equal(isFinale(seasonEnd(3) - 1), true);
  assert.equal(isFinale(seasonEnd(3) - 3 * DAY), false);
});

// ===========================================================================
// PÓDIO CONGELA — grace de 60min pro report da temporada anterior
// ===========================================================================
test("isReportSeasonValid: a temporada ATUAL sempre entra", () => {
  const midT1 = seasonStart(1) + 10 * DAY;
  assert.equal(currentSeasonId(midT1), 1);
  assert.equal(isReportSeasonValid(1, midT1), true);
});

test("isReportSeasonValid: temporada ANTERIOR só nos primeiros 60min da virada", () => {
  const start1 = seasonStart(1); // virada T0 -> T1
  assert.equal(currentSeasonId(start1), 1);
  // dentro do grace: T0 ainda entra
  assert.equal(isReportSeasonValid(0, start1), true); // 0ms após a virada
  assert.equal(isReportSeasonValid(0, start1 + REPORT_GRACE_MS - 1), true); // 59min59s
  // na borda exata dos 60min e além: pódio da T0 congelado
  assert.equal(isReportSeasonValid(0, start1 + REPORT_GRACE_MS), false); // 60min exatos
  assert.equal(isReportSeasonValid(0, start1 + REPORT_GRACE_MS + 1), false);
  assert.equal(isReportSeasonValid(0, start1 + 3 * DAY), false); // dias depois: barrado
  // MUITO depois (o bug antigo ±1 deixava entrar por até 28 dias) -> agora barrado
  assert.equal(isReportSeasonValid(0, seasonStart(1) + 20 * DAY), false);
});

test("isReportSeasonValid: temporada SEGUINTE só nos últimos 60min (cliente adiantado)", () => {
  const end1 = seasonEnd(1); // fim da T1
  // relógio ainda em T1, cliente já reportando T2 (adiantado)
  assert.equal(isReportSeasonValid(2, end1 - REPORT_GRACE_MS + 1), true); // últimos <60min
  assert.equal(isReportSeasonValid(2, end1 - REPORT_GRACE_MS), false); // exatamente 60min antes
  assert.equal(isReportSeasonValid(2, end1 - 3 * DAY), false); // cedo demais
});

test("isReportSeasonValid: |diff|>1, negativo e não-inteiro sempre barrados", () => {
  const mid = seasonStart(2) + 5 * DAY; // cur=2
  assert.equal(isReportSeasonValid(0, mid), false); // 2 atrás
  assert.equal(isReportSeasonValid(4, mid), false); // 2 à frente
  assert.equal(isReportSeasonValid(-1, mid), false);
  assert.equal(isReportSeasonValid(1.5, mid), false);
});
