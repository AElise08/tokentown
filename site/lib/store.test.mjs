// Testes do store — foco na PRESERVAÇÃO do profile no honor system (backend em
// memória). Roda com Node 22+/24:  node lib/store.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __resetStoreForTests,
  submitReport,
  deleteUser,
  getUserWithRank,
  getLeaderboard,
  getUserSnaps,
  sanitizeDailyTokens,
} from "./store.ts";
import { currentSeasonId } from "./season.ts";
import { utcDayKey } from "./window.ts";
import { weekHeatmap } from "./setup-view.ts";

const DAY_MS = 86400000;
// chave AAAAMMDD de `i` dias UTC atrás (i=0 = hoje).
const dayBack = (now, i) => utcDayKey(now - i * DAY_MS);

// O rate limit é 1/min por username. Nos testes, reports do MESMO user em
// sequência precisam limpar a chave de rate limit do storage em memória
// (white-box) — senão o 2º report tomaria 429 antes de chegar na escrita.
function clearRate(u) {
  const m = globalThis.__ttpMem;
  if (m) {
    m.hashes.delete(`rl:${u}`);
    m.expires.delete(`rl:${u}`);
  }
}

test("profile: persiste, e report SEM profile PRESERVA o existente", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const u = "proftest";
  const base = { username: u, key: "k".repeat(16), seasonId: s, cost: 1, residents: 1, buildings: 1 };

  // 1) primeiro report COM profile -> persiste
  let r = await submitReport({
    ...base,
    tokens: 1000,
    profile: { cityName: "Meltown", motto: "feita de tokens", accent: "teal" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.profile.cityName, "Meltown");
  assert.equal(r.entry.profile.accent, "teal");

  // 2) report SEM profile (tokens maiores) -> PRESERVA o profile anterior
  clearRate(u);
  r = await submitReport({ ...base, tokens: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.equal(r.entry.profile.cityName, "Meltown");
  assert.equal(r.entry.profile.accent, "teal");

  // e persiste na LEITURA (getUserWithRank revalida do hash)
  let got = await getUserWithRank(s, u);
  assert.equal(got.profile.cityName, "Meltown");
  assert.equal(got.profile.motto, "feita de tokens");

  // 3) report com profile TODO inválido -> ignorado, preserva
  clearRate(u);
  r = await submitReport({ ...base, tokens: 3000, profile: { accent: "neon", cityName: "<<<>>>" } });
  assert.equal(r.entry.profile.cityName, "Meltown");

  // 4) report com NOVO profile válido -> substitui
  clearRate(u);
  r = await submitReport({ ...base, tokens: 4000, profile: { cityName: "Nova", accent: "rosa" } });
  assert.equal(r.entry.profile.cityName, "Nova");
  assert.equal(r.entry.profile.accent, "rosa");
  got = await getUserWithRank(s, u);
  assert.equal(got.profile.cityName, "Nova");
});

test('profile: "" LIMPA só o campo (motto), preservando cityName/accent — mesmo sem crescer tokens', async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const u = "cleartest";
  const base = { username: u, key: "k".repeat(16), seasonId: s, cost: 1, residents: 1, buildings: 1 };

  // 1) semeia perfil cheio
  let r = await submitReport({
    ...base,
    tokens: 1000,
    profile: { cityName: "Meltown", motto: "old motto", accent: "dourado" },
  });
  assert.equal(r.entry.profile.motto, "old motto");

  // 2) MESMOS tokens (sem crescimento) + motto "" -> limpa só o motto
  clearRate(u);
  r = await submitReport({ ...base, tokens: 1000, profile: { cityName: "Meltown", motto: "", accent: "dourado" } });
  assert.equal(r.ok, true);
  assert.equal(r.updated, false); // números não cresceram
  assert.equal(r.entry.profile.motto, undefined); // motto apagado
  assert.equal(r.entry.profile.cityName, "Meltown"); // cityName preservado
  assert.equal(r.entry.profile.accent, "dourado"); // accent preservado

  // persiste na leitura
  let got = await getUserWithRank(s, u);
  assert.equal(got.profile.motto, undefined);
  assert.equal(got.profile.cityName, "Meltown");

  // 3) campo AUSENTE preserva: report só com cityName não mexe no accent
  clearRate(u);
  r = await submitReport({ ...base, tokens: 2000, profile: { cityName: "Meltown" } });
  assert.equal(r.entry.profile.accent, "dourado"); // accent preservado (ausente do patch)
  assert.equal(r.entry.profile.cityName, "Meltown");
});

test("user NOVO sem profile -> profile null (não inventa)", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const r = await submitReport({
    username: "noprof",
    key: "k".repeat(16),
    seasonId: s,
    tokens: 500,
    cost: 1,
    residents: 1,
    buildings: 1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.profile, null);
  const got = await getUserWithRank(s, "noprof");
  assert.equal(got.profile, null);
});

// ---------------------------------------------------------------------------
// BREAKDOWN DIÁRIO (heatmap "CITY LIGHTS · THIS WEEK")
// ---------------------------------------------------------------------------
test("sanitizeDailyTokens: mantém AAAAMMDD na janela, descarta lixo/fora/negativo, cap 7", () => {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const raw = {
    [dayBack(now, 0)]: 40, // hoje
    [dayBack(now, 3)]: 10, // dentro
    [dayBack(now, 6)]: 5, // borda (today-6, dentro)
    [dayBack(now, 9)]: 999, // fora da janela (> 7 dias) -> descarta
    "2026aa13": 3, // formato inválido -> descarta
    [dayBack(now, 1)]: -7, // negativo -> descarta
  };
  const out = sanitizeDailyTokens(raw, now);
  assert.equal(out[dayBack(now, 0)], 40);
  assert.equal(out[dayBack(now, 3)], 10);
  assert.equal(out[dayBack(now, 6)], 5);
  assert.equal(out[dayBack(now, 9)], undefined);
  assert.equal(out["2026aa13"], undefined);
  assert.equal(out[dayBack(now, 1)], undefined);
  assert.equal(Object.keys(out).length, 3);
});

test("sanitizeDailyTokens: cap de 7 chaves mantém as mais recentes", () => {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const raw = {};
  for (let i = 0; i <= 7; i++) raw[dayBack(now, i)] = 100 + i; // 8 dias válidos (0..7)
  const out = sanitizeDailyTokens(raw, now);
  assert.equal(Object.keys(out).length, 7);
  assert.equal(out[dayBack(now, 0)], 100); // hoje mantido
  assert.equal(out[dayBack(now, 6)], 106); // 7º mais recente mantido
  assert.equal(out[dayBack(now, 7)], undefined); // o mais antigo cortado
});

test("sanitizeDailyTokens: vazio/ausente/array -> null (preserva no servidor)", () => {
  const now = Date.now();
  assert.equal(sanitizeDailyTokens(undefined, now), null);
  assert.equal(sanitizeDailyTokens(null, now), null);
  assert.equal(sanitizeDailyTokens({}, now), null);
  assert.equal(sanitizeDailyTokens([1, 2, 3], now), null);
  assert.equal(sanitizeDailyTokens({ notaday: 5 }, now), null);
});

test("dailyTokens no report -> heatmap acende VÁRIOS dias (não só hoje) + floor sem vazamento pré-janela", async () => {
  __resetStoreForTests();
  const now = Date.now();
  const s = currentSeasonId(now);
  const u = "heatmel";
  // ganhos por dia dos últimos 4 dias; total da temporada inclui 5M pré-janela.
  const daily = {
    [dayBack(now, 0)]: 4_000_000,
    [dayBack(now, 1)]: 3_000_000,
    [dayBack(now, 2)]: 2_000_000,
    [dayBack(now, 3)]: 1_000_000,
  };
  const seasonTotal = 15_000_000; // 10M na janela + 5M pré-janela (07-01..07-06)
  const r = await submitReport({
    username: u, key: "k".repeat(16), seasonId: s,
    tokens: seasonTotal, cost: 30, residents: 5, buildings: 10,
    dailyTokens: daily,
  });
  assert.equal(r.ok, true);
  assert.equal(r.updated, true);

  // lê os snapshots diários back-datados e desenha o heatmap real.
  const snaps = await getUserSnaps(s, u);
  const cells = weekHeatmap(snaps, now);
  const byKey = Object.fromEntries(cells.map((c) => [c.dayKey, c]));

  // os 4 dias reportados acendem com o GANHO exato...
  assert.equal(byKey[dayBack(now, 0)].gain, 4_000_000);
  assert.equal(byKey[dayBack(now, 1)].gain, 3_000_000);
  assert.equal(byKey[dayBack(now, 2)].gain, 2_000_000);
  assert.equal(byKey[dayBack(now, 3)].gain, 1_000_000);
  // ...e os dias mais antigos da janela ficam ESCUROS (o floor em today-7 evita que os
  // 5M pré-janela vazem pro dia mais antigo visível = today-6).
  assert.equal(byKey[dayBack(now, 4)].gain, 0);
  assert.equal(byKey[dayBack(now, 5)].gain, 0);
  assert.equal(byKey[dayBack(now, 6)].gain, 0);
  // VÁRIOS dias acesos (o bug era só HOJE).
  const litDays = cells.filter((c) => c.gain > 0).length;
  assert.equal(litDays, 4);
});

// REGRESSÃO (bug de produção): o LEITOR do heatmap tem que usar o MESMO backend
// que o store ESCREVE. Antes getUserSnaps vivia em lib/snaps.ts e só sabia ler
// Upstash REST; em prod (Redis nativo `tokentown_REDIS_URL`, sem vars REST) ele
// caía pro mapa em memória vazio e devolvia [] -> /u/mel mostrava só "hoje".
// Agora getUserSnaps é exportado do PRÓPRIO store (mesmo kv()), então o que foi
// escrito é exatamente o que é lido — este teste trava esse contrato.
test("getUserSnaps lê pelo MESMO backend do store (regressão do heatmap em prod)", async () => {
  __resetStoreForTests();
  const now = Date.now();
  const s = currentSeasonId(now);
  const u = "snapread";
  const daily = { [dayBack(now, 0)]: 5_000_000, [dayBack(now, 1)]: 3_000_000, [dayBack(now, 2)]: 2_000_000 };
  const r = await submitReport({
    username: u, key: "k".repeat(16), seasonId: s,
    tokens: 10_000_000, cost: 20, residents: 4, buildings: 8,
    dailyTokens: daily,
  });
  assert.equal(r.ok, true);
  // o mesmo leitor que a /u usa devolve os snapshots que o store acabou de gravar.
  const snaps = await getUserSnaps(s, u);
  const gotDays = new Set(snaps.map((p) => p.dayKey));
  // os 3 dias reportados (+ hoje) precisam estar presentes — não pode voltar [].
  assert.ok(snaps.length >= 3, `esperava >=3 snapshots, veio ${snaps.length}`);
  for (let i = 0; i <= 2; i++) assert.ok(gotDays.has(dayBack(now, i)), `dia ${dayBack(now, i)} sumiu na leitura`);
});

test("report SEM dailyTokens PRESERVA os snapshots diários já back-datados", async () => {
  __resetStoreForTests();
  const now = Date.now();
  const s = currentSeasonId(now);
  const u = "presmel";
  // 1) report COM dailyTokens -> back-data.
  let r = await submitReport({
    username: u, key: "k".repeat(16), seasonId: s,
    tokens: 10_000_000, cost: 20, residents: 3, buildings: 6,
    dailyTokens: { [dayBack(now, 0)]: 6_000_000, [dayBack(now, 1)]: 4_000_000 },
  });
  assert.equal(r.ok, true);
  const litBefore = weekHeatmap(await getUserSnaps(s, u), now).filter((c) => c.gain > 0).length;
  assert.ok(litBefore >= 2, "esperava >=2 dias acesos após o 1º report");

  // 2) report SEM dailyTokens (tokens maiores) -> NÃO apaga os snapshots anteriores.
  const m = globalThis.__ttpMem;
  if (m) { m.hashes.delete(`rl:${u}`); m.expires.delete(`rl:${u}`); } // limpa rate limit
  r = await submitReport({
    username: u, key: "k".repeat(16), seasonId: s,
    tokens: 12_000_000, cost: 24, residents: 3, buildings: 7,
  });
  assert.equal(r.ok, true);
  const cellsAfter = weekHeatmap(await getUserSnaps(s, u), now);
  // ainda há vários dias com histórico (ontem preservado; hoje subiu pra 12M).
  assert.ok(cellsAfter.filter((c) => c.gain > 0).length >= 2, "snapshots diários foram perdidos");
});

test("deleteUser: key correta remove do placar e libera o username", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const u = "deleteme";
  const key = "k".repeat(16);
  const base = { username: u, key, seasonId: s, cost: 1, residents: 1, buildings: 10 };

  let r = await submitReport({ ...base, tokens: 50_000 });
  assert.equal(r.ok, true);
  assert.ok(await getUserWithRank(s, u));

  // key errada -> 403, perfil permanece
  let d = await deleteUser({ username: u, key: "wrong-key-xxxx" });
  assert.equal(d.ok, false);
  assert.equal(d.status, 403);
  assert.ok(await getUserWithRank(s, u));

  // key certa -> some do placar
  d = await deleteUser({ username: u, key });
  assert.equal(d.ok, true);
  assert.equal(d.deleted, true);
  assert.equal(await getUserWithRank(s, u), null);

  const board = await getLeaderboard(s, { limit: 100 });
  assert.ok(!board.some((e) => e.username === u));

  // username liberado: outra key consegue registrar de novo
  r = await submitReport({ ...base, key: "n".repeat(16), tokens: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.entry.tokens, 1000);
});

test("deleteUser: username inexistente -> 404", async () => {
  __resetStoreForTests();
  const d = await deleteUser({ username: "nobody-here", key: "k".repeat(16) });
  assert.equal(d.ok, false);
  assert.equal(d.status, 404);
});
