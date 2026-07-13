// Testes do SETUP ("teu setup vira cidade"): sanitização pura (shape/caps/slug/
// dedup/3KB/normalização) + round-trip no store (persiste/preserva/limpa).
// Roda com Node 22+/24 (strip de tipos nativo):  node lib/setup.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSetup, SETUP_CAPS } from "./setup.ts";
import { __resetStoreForTests, submitReport, getUserWithRank } from "./store.ts";
import { currentSeasonId } from "./season.ts";

// ---------------------------------------------------------------------------
// sanitizeSetup — SHAPE
// ---------------------------------------------------------------------------
test("aceita setup válido e devolve o shape esperado (nomes viram slug)", () => {
  const s = sanitizeSetup({
    v: 1,
    skills: ["superpowers", "roborev", "agentsview"],
    mcp: ["palmier"],
    hooks: ["stop", "posttooluse"],
    tools: [["Bash", 4200], ["Edit", 1800], ["Agent", 90]],
    models: [["opus-4-8", 0.8], ["sonnet-5", 0.2]],
  });
  assert.equal(s.v, 1);
  assert.deepEqual(s.skills, ["superpowers", "roborev", "agentsview"]);
  assert.deepEqual(s.mcp, ["palmier"]);
  assert.deepEqual(s.hooks, ["stop", "posttooluse"]);
  assert.deepEqual(s.tools, [["bash", 4200], ["edit", 1800], ["agent", 90]]);
  assert.deepEqual(s.models, [["opus-4-8", 0.8], ["sonnet-5", 0.2]]);
});

test("arrays ausentes viram vazio (só v:1 é obrigatório)", () => {
  const s = sanitizeSetup({ v: 1, skills: ["copy-mel"] });
  assert.deepEqual(s.skills, ["copy-mel"]);
  assert.deepEqual(s.mcp, []);
  assert.deepEqual(s.hooks, []);
  assert.deepEqual(s.tools, []);
  assert.deepEqual(s.models, []);
});

// ---------------------------------------------------------------------------
// CAPS — skills<=40, mcp<=20, hooks<=12, tools<=10, models<=6
// ---------------------------------------------------------------------------
test("CAPS por lista", () => {
  const many = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const s = sanitizeSetup({
    v: 1,
    skills: many(60, "s"),
    mcp: many(40, "m"),
    hooks: many(30, "h"),
    tools: many(30, "t").map((name, i) => [name, 30 - i]),
    models: many(20, "md").map((name) => [name, 0.5]),
  });
  assert.equal(s.skills.length, SETUP_CAPS.skills);
  assert.equal(s.mcp.length, SETUP_CAPS.mcp);
  assert.equal(s.hooks.length, SETUP_CAPS.hooks);
  assert.equal(s.tools.length, SETUP_CAPS.tools);
  assert.equal(s.models.length, SETUP_CAPS.models);
});

// ---------------------------------------------------------------------------
// SLUG — markup e acentos viram slug seguro [a-z0-9-]{1,32}
// ---------------------------------------------------------------------------
test('MARKUP vira slug seguro: "<script>" -> "script"', () => {
  const s = sanitizeSetup({ v: 1, skills: ["<script>", "copy-mel", 'a"><img src=x>'] });
  assert.equal(s.skills[0], "script");
  assert.equal(s.skills[1], "copy-mel");
  for (const slug of s.skills) {
    assert.ok(/^[a-z0-9-]{1,32}$/.test(slug), `slug inseguro: ${slug}`);
    assert.ok(!slug.includes("<") && !slug.includes(">") && !slug.includes('"'));
  }
});

test("acentos viram ASCII: coração -> coracao, São Paulo -> sao-paulo", () => {
  const s = sanitizeSetup({ v: 1, skills: ["coração", "São Paulo"] });
  assert.deepEqual(s.skills, ["coracao", "sao-paulo"]);
});

test("slug corta em 32 e apara hífens das pontas", () => {
  const s = sanitizeSetup({ v: 1, skills: ["--Ab CD--", "z".repeat(50)] });
  assert.equal(s.skills[0], "ab-cd"); // pontas aparadas, espaço -> hífen, minúsculo
  assert.equal(s.skills[1].length, 32);
});

// ---------------------------------------------------------------------------
// DEDUP — slugs repetidos (inclusive após slug) somem
// ---------------------------------------------------------------------------
test("DEDUP preservando ordem", () => {
  const s = sanitizeSetup({ v: 1, skills: ["copy-mel", "copy-mel", "Copy Mel", "copy--mel", "roborev"] });
  assert.deepEqual(s.skills, ["copy-mel", "roborev"]);
});

// ---------------------------------------------------------------------------
// TOOLS — slug + top 10 desc, contagem int>=0, colisão soma, inválidas caem
// ---------------------------------------------------------------------------
test("tools: top por contagem desc, soma colisão, dropa contagem inválida", () => {
  const t = sanitizeSetup({
    v: 1,
    tools: [["Edit", 1800], ["Bash", 4200], ["Agent", 90], ["WebSearch", -5], ["Bad", "x"], ["Edit", 200]],
  }).tools;
  assert.deepEqual(t, [["bash", 4200], ["edit", 2000], ["agent", 90]]);
  for (const [, c] of t) assert.ok(Number.isInteger(c) && c >= 0);
});

// ---------------------------------------------------------------------------
// MODELS — normalizados (somam ~1), clamp 0..1, top 6, dropa fração <= 0
// ---------------------------------------------------------------------------
test("models: normaliza pra somar ~1", () => {
  const m = sanitizeSetup({ v: 1, models: [["a", 0.5], ["b", 0.5], ["c", 0.5]] }).models;
  assert.deepEqual(m, [["a", 0.3333], ["b", 0.3333], ["c", 0.3333]]);
});

test("models: clampa fração >1 pra 1 e dropa <= 0", () => {
  const m = sanitizeSetup({ v: 1, models: [["a", 3], ["b", 1], ["c", -1], ["d", 0]] }).models;
  assert.deepEqual(m, [["a", 0.5], ["b", 0.5]]); // a,b clampados a 1; c,d dropados; normaliza
});

test("models: fração já somando 1 fica intacta; tudo zero -> vazio", () => {
  assert.deepEqual(
    sanitizeSetup({ v: 1, models: [["opus-4-8", 0.8], ["sonnet-5", 0.2]] }).models,
    [["opus-4-8", 0.8], ["sonnet-5", 0.2]]
  );
  assert.deepEqual(sanitizeSetup({ v: 1, models: [["a", 0], ["b", -5]] }).models, []);
});

// ---------------------------------------------------------------------------
// 3KB — setup serializado grande demais é DESCARTADO (undefined -> preserva)
// ---------------------------------------------------------------------------
const distinctSlugs = (n, p) =>
  Array.from({ length: n }, (_, i) => (`${p}${i}-`).padEnd(32, "x").slice(0, 32));

test(">3KB descarta o setup (retorna undefined -> preserva o guardado)", () => {
  const s = sanitizeSetup({
    v: 1,
    skills: distinctSlugs(40, "sk"),
    mcp: distinctSlugs(20, "mc"),
    hooks: distinctSlugs(12, "hk"),
    tools: distinctSlugs(10, "tl").map((name, i) => [name, 100000 + i]),
    models: distinctSlugs(6, "md").map((name) => [name, 0.5]),
  });
  assert.equal(s, undefined);
});

// ---------------------------------------------------------------------------
// TRI-ESTADO — ausente/inválido = undefined (PRESERVE); null = CLEAR
// ---------------------------------------------------------------------------
test("ausente/inválido -> undefined (PRESERVE)", () => {
  assert.equal(sanitizeSetup(undefined), undefined);
  assert.equal(sanitizeSetup("nope"), undefined);
  assert.equal(sanitizeSetup(123), undefined);
  assert.equal(sanitizeSetup([1, 2, 3]), undefined);
  assert.equal(sanitizeSetup({}), undefined); // sem v:1
  assert.equal(sanitizeSetup({ v: 2, skills: ["x"] }), undefined); // versão errada
  assert.equal(sanitizeSetup({ v: "1", skills: ["x"] }), undefined); // v tem que ser 1 numérico
});

test("setup:null explícito -> null (CLEAR)", () => {
  assert.equal(sanitizeSetup(null), null);
});

// ---------------------------------------------------------------------------
// STORE round-trip — persiste, preserva quando ausente, limpa com null, aplica
// sem crescimento de tokens, descarta >3KB mas aceita o report.
// ---------------------------------------------------------------------------
function clearRate(u) {
  const m = globalThis.__ttpMem;
  if (m) {
    m.hashes.delete(`rl:${u}`);
    m.expires.delete(`rl:${u}`);
  }
}

test("store: persiste, report SEM setup PRESERVA, setup novo sem crescer tokens aplica, null LIMPA", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const u = "setuptest";
  const base = { username: u, key: "k".repeat(16), seasonId: s, cost: 1, residents: 1, buildings: 1 };

  // 1) primeiro report COM setup
  let r = await submitReport({
    ...base,
    tokens: 1000,
    setup: { v: 1, skills: ["superpowers", "roborev"], mcp: ["palmier"], tools: [["Bash", 4200]], models: [["opus-4-8", 1]] },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry.setup.skills, ["superpowers", "roborev"]);
  assert.deepEqual(r.entry.setup.tools, [["bash", 4200]]);
  assert.deepEqual(r.entry.setup.models, [["opus-4-8", 1]]);

  // 2) report SEM setup (tokens maiores) -> PRESERVA o guardado
  clearRate(u);
  r = await submitReport({ ...base, tokens: 2000 });
  assert.equal(r.updated, true);
  assert.deepEqual(r.entry.setup.mcp, ["palmier"]);
  let got = await getUserWithRank(s, u);
  assert.deepEqual(got.setup.skills, ["superpowers", "roborev"]);

  // 3) setup NOVO sem crescer tokens (mesmos 2000) -> aplica mesmo assim (SET substitui tudo)
  clearRate(u);
  r = await submitReport({ ...base, tokens: 2000, setup: { v: 1, skills: ["agentsview"] } });
  assert.equal(r.updated, false);
  assert.deepEqual(r.entry.setup.skills, ["agentsview"]);
  assert.deepEqual(r.entry.setup.mcp, []); // SET é blob inteiro -> mcp velho sai
  got = await getUserWithRank(s, u);
  assert.deepEqual(got.setup.skills, ["agentsview"]);

  // 4) setup:null explícito -> LIMPA (mesmo sem crescer)
  clearRate(u);
  r = await submitReport({ ...base, tokens: 2000, setup: null });
  assert.equal(r.updated, false);
  assert.equal(r.entry.setup, null);
  got = await getUserWithRank(s, u);
  assert.equal(got.setup, null);
});

test("store: user novo sem setup -> setup null (não inventa)", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const r = await submitReport({
    username: "nosetup",
    key: "k".repeat(16),
    seasonId: s,
    tokens: 500,
    cost: 1,
    residents: 1,
    buildings: 1,
  });
  assert.equal(r.entry.setup, null);
  const got = await getUserWithRank(s, "nosetup");
  assert.equal(got.setup, null);
});

test("store: setup >3KB é descartado mas o report é ACEITO e preserva o guardado", async () => {
  __resetStoreForTests();
  const s = currentSeasonId();
  const u = "bigsetup";
  const base = { username: u, key: "k".repeat(16), seasonId: s, cost: 1, residents: 1, buildings: 1 };
  let r = await submitReport({ ...base, tokens: 1000, setup: { v: 1, skills: ["superpowers"] } });
  assert.deepEqual(r.entry.setup.skills, ["superpowers"]);
  clearRate(u);
  r = await submitReport({
    ...base,
    tokens: 2000,
    setup: {
      v: 1,
      skills: distinctSlugs(40, "sk"),
      mcp: distinctSlugs(20, "mc"),
      hooks: distinctSlugs(12, "hk"),
      tools: distinctSlugs(10, "tl").map((n, i) => [n, 100000 + i]),
      models: distinctSlugs(6, "md").map((n) => [n, 0.5]),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.updated, true); // números cresceram -> report aceito
  assert.deepEqual(r.entry.setup.skills, ["superpowers"]); // setup gigante ignorado -> preserva
});
