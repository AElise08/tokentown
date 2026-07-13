// Testes rápidos do gerador de cidade. Roda com Node 22+/24 (strip de tipos
// nativo pra importar o .ts):  node lib/city.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  citySvg,
  cityFeatures,
  sanitizeCity,
  cityComposition,
  cityMarcoLabels,
  accentedWindow,
  CITY_CAPS,
  TOKEN_GARDEN,
  TOKEN_FERRY,
  TOKEN_LIGHTHOUSE,
  TOKEN_TOWERS,
  LH_TOWER,
  LH_STRIPE,
} from "./city.ts";

const base = { username: "mel", tokens: 0, residents: 0, buildings: 0 };

test("determinístico: mesma seed -> mesmo SVG", () => {
  const a = citySvg({ username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "mini");
  const b = citySvg({ username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "mini");
  assert.equal(a, b);
  const c = citySvg({ username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "full");
  const d = citySvg({ username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "full");
  assert.equal(c, d);
});

test("usernames diferentes -> SVGs diferentes (layout muda com a seed)", () => {
  const a = citySvg({ username: "mel", tokens: 500_000, residents: 10, buildings: 100 }, "mini");
  const b = citySvg({ username: "rafa-dev", tokens: 500_000, residents: 10, buildings: 100 }, "mini");
  assert.notEqual(a, b);
});

test("SVG bem formado (abre/fecha, tem viewBox)", () => {
  const s = citySvg({ username: "mel", tokens: 1_500_000, residents: 20, buildings: 300 }, "full");
  assert.match(s, /^<svg /);
  assert.match(s, /<\/svg>$/);
  assert.match(s, /viewBox="0 0 640 144"/);
});

test("marco JARDIM aparece em >= 100k e some logo abaixo", () => {
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_GARDEN }).garden, true);
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_GARDEN - 1 }).garden, false);
  assert.match(citySvg({ ...base, tokens: TOKEN_GARDEN }, "mini"), /tt-garden/);
  assert.doesNotMatch(citySvg({ ...base, tokens: TOKEN_GARDEN - 1 }, "mini"), /tt-garden/);
});

test("marco BALSA aparece em >= 300k", () => {
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_FERRY }).ferry, true);
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_FERRY - 1 }).ferry, false);
  assert.match(citySvg({ ...base, tokens: TOKEN_FERRY }, "mini"), /tt-ferry/);
  assert.doesNotMatch(citySvg({ ...base, tokens: TOKEN_FERRY - 1 }, "mini"), /tt-ferry/);
});

test("marco FAROL + feixe aparece em >= 1M", () => {
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_LIGHTHOUSE }).lighthouse, true);
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_LIGHTHOUSE - 1 }).lighthouse, false);
  const s = citySvg({ ...base, tokens: TOKEN_LIGHTHOUSE }, "full");
  assert.match(s, /tt-lighthouse/);
  assert.match(s, /tt-beam/);
  assert.doesNotMatch(citySvg({ ...base, tokens: TOKEN_LIGHTHOUSE - 1 }, "full"), /tt-lighthouse/);
});

test("marco TORRES em >= 3M deixa a cidade mais alta (SVG muda vs 1M)", () => {
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_TOWERS }).towers, true);
  assert.equal(cityFeatures({ ...base, tokens: TOKEN_TOWERS - 1 }).towers, false);
  const low = citySvg({ username: "mel", tokens: TOKEN_TOWERS - 1, residents: 5, buildings: 500 }, "full");
  const high = citySvg({ username: "mel", tokens: TOKEN_TOWERS, residents: 5, buildings: 500 }, "full");
  assert.notEqual(low, high);
});

test("residents controlam janelas acesas (litRatio cresce, monotônico e limitado)", () => {
  const f0 = cityFeatures({ ...base, residents: 0 });
  const f1 = cityFeatures({ ...base, residents: 40 });
  const f2 = cityFeatures({ ...base, residents: 400 });
  assert.ok(f0.litRatio >= 0.16);
  assert.ok(f1.litRatio > f0.litRatio);
  assert.ok(f2.litRatio > f1.litRatio);
  assert.ok(f2.litRatio <= 0.94);
});

test("buildings controlam densidade (mais prédios -> densidade maior, 0..1)", () => {
  const d0 = cityFeatures({ ...base, buildings: 0 }).density;
  const d1 = cityFeatures({ ...base, buildings: 100 }).density;
  const d2 = cityFeatures({ ...base, buildings: 1402 }).density;
  assert.ok(d0 >= 0 && d2 <= 1);
  assert.ok(d1 > d0);
  assert.ok(d2 > d1);
});

// ===========================================================================
// CIDADE REAL — render pela city (não pelo username) + sanitização
// ===========================================================================
const inp = (city) => ({ username: "x", tokens: 0, residents: 0, buildings: 0, city });
const countStr = (s, sub) => s.split(sub).length - 1;

// cidades bem distintas entre si (as mesmas ideias da demo T0)
const CITY_MEL = {
  v: 1, seed: 12345, buildings: 1402, pop: 45000,
  types: { torre: 6, parque: 3, cais: 2, biblioteca: 2, mirante: 1, praca: 2 },
  marcos: ["garden", "ferry", "lighthouse", "towers", "festival", "fireworks"], era: 3,
};
const CITY_RAFA = {
  v: 1, seed: 99, buildings: 3000, pop: 8000,
  types: { torre: 40 }, marcos: ["towers", "lighthouse"], era: 6,
};
const CITY_JU = {
  v: 1, seed: 7, buildings: 500, pop: 1200,
  types: { parque: 10, cais: 8 }, marcos: ["garden", "ferry", "festival"], era: 2,
};

test("CIDADE REAL: mesma city -> mesmo SVG (mini e full)", () => {
  assert.equal(citySvg(inp(CITY_MEL), "mini"), citySvg(inp(CITY_MEL), "mini"));
  assert.equal(citySvg(inp(CITY_MEL), "full"), citySvg(inp(CITY_MEL), "full"));
  // a seed manda: o username só aparece no aria-label; o DESENHO é idêntico.
  const strip = (s) => s.replace(/aria-label="[^"]*"/g, "");
  const a = citySvg({ username: "aaa", tokens: 9, residents: 9, buildings: 9, city: CITY_MEL }, "full");
  const b = citySvg({ username: "zzz", tokens: 1, residents: 1, buildings: 1, city: CITY_MEL }, "full");
  assert.equal(strip(a), strip(b));
});

test("CIDADE REAL: cities diferentes -> SVGs BEM diferentes (classes tt-* distintas)", () => {
  const mel = citySvg(inp(CITY_MEL), "full");
  const rafa = citySvg(inp(CITY_RAFA), "full");
  const ju = citySvg(inp(CITY_JU), "full");
  assert.notEqual(mel, rafa);
  assert.notEqual(rafa, ju);
  assert.notEqual(mel, ju);

  // marca de origem: cidade real (não fallback por username)
  assert.match(mel, /tt-city-real/);

  // rafa é pesada em torres; ju é cheia de parques/cais.
  assert.ok(countStr(rafa, "tt-b-torre") > countStr(ju, "tt-b-torre"));
  assert.ok(countStr(ju, "tt-b-parque") > countStr(rafa, "tt-b-parque"));
  assert.ok(countStr(ju, "tt-b-cais") > 0);
  assert.equal(countStr(ju, "tt-b-torre"), 0);

  // marcos ambientais distintos por usuário
  assert.match(mel, /tt-fogos/); // mel tem fireworks
  assert.doesNotMatch(rafa, /tt-fogos/);
  assert.match(mel, /tt-lighthouse/);
  assert.match(rafa, /tt-towers/);
  assert.doesNotMatch(ju, /tt-lighthouse/);
  assert.match(ju, /tt-festival/);
  assert.doesNotMatch(rafa, /tt-festival/);
});

test("CIDADE REAL: aceita tipo desconhecido com genérico bonito (tt-b-<slug>)", () => {
  const c = { v: 1, seed: 3, buildings: 400, pop: 300, types: { catedral: 3, torre: 2 }, marcos: [], era: 4 };
  const s = citySvg(inp(c), "full");
  assert.ok(countStr(s, "tt-b-catedral") > 0); // tipo aberto desenhado
  assert.ok(countStr(s, "tt-b-torre") > 0);
});

test("CIDADE REAL: sem city -> fallback pela seed do username (tt-city-seeded)", () => {
  const s = citySvg({ username: "nick-agents", tokens: 500000, residents: 12, buildings: 300 }, "mini");
  assert.match(s, /tt-city-seeded/);
  assert.doesNotMatch(s, /tt-city-real/);
});

test("sanitizeCity: aceita e NORMALIZA (praça->praca, string->int, dedup marcos)", () => {
  const c = sanitizeCity({
    v: 1, seed: 42, buildings: 10, pop: 20,
    types: { "Praça": 3, torre: "5", vazio: 0 },
    marcos: ["garden", "Garden", "bad!name", "lighthouse"], era: 3,
  });
  assert.ok(c);
  assert.equal(c.v, 1);
  assert.equal(c.seed, 42);
  assert.equal(c.types.praca, 3); // acento removido + minúsculo
  assert.equal(c.types.torre, 5); // "5" -> 5
  assert.ok(!("vazio" in c.types)); // contagem 0 descartada
  assert.deepEqual(c.marcos, ["garden", "lighthouse"]); // dup + inválido fora
});

test("sanitizeCity: DERRUBA payload malicioso/ inválido", () => {
  assert.equal(sanitizeCity(null), null);
  assert.equal(sanitizeCity("nope"), null);
  assert.equal(sanitizeCity([1, 2, 3]), null);
  assert.equal(sanitizeCity({ v: 2, seed: 1 }), null); // versão errada
  assert.equal(sanitizeCity({ v: 1 }), null); // sem seed
  assert.equal(sanitizeCity({ v: 1, seed: -5 }), null); // seed negativo
  assert.equal(sanitizeCity({ v: 1, seed: 1.5 }), null); // seed não-inteiro
  assert.equal(sanitizeCity({ v: 1, seed: 4294967296 }), null); // > uint32

  // injeção em chave de type é neutralizada (sem <, >, aspas)
  const inj = sanitizeCity({ v: 1, seed: 1, types: { "<script>x</script>": 3, 'a"b': 2 } });
  assert.ok(inj);
  const injJson = JSON.stringify(inj);
  assert.ok(!injJson.includes("<") && !injJson.includes(">"));
  assert.ok("scriptxscript" in inj.types && "ab" in inj.types);

  // > 24 chaves truncadas
  const many = {};
  for (let i = 0; i < 100; i++) many["t" + i] = 5;
  const s = sanitizeCity({ v: 1, seed: 1, types: many });
  assert.ok(Object.keys(s.types).length <= CITY_CAPS.typeKeys);

  // valor de type clampado no teto
  const capped = sanitizeCity({ v: 1, seed: 1, types: { torre: 9_999_999_999 } });
  assert.equal(capped.types.torre, CITY_CAPS.typeValue);

  // payload BRUTO > 2KB -> descarta a city inteira
  const big = { v: 1, seed: 1, note: "x".repeat(3000) };
  assert.equal(sanitizeCity(big), null);

  // um city malicioso sanitizado NUNCA injeta markup no SVG
  const svg = citySvg(inp(inj), "mini");
  assert.doesNotMatch(svg, /<script/);
});

test("CIDADE REAL: cidade degenerada (types {}, marcos [], zeros) não quebra e gera SVG bem formado", () => {
  const deg = { v: 1, seed: 1, buildings: 0, pop: 0, types: {}, marcos: [], era: 0 };
  const mini = citySvg(inp(deg), "mini");
  const full = citySvg(inp(deg), "full");
  assert.match(mini, /^<svg /);
  assert.match(mini, /<\/svg>$/);
  assert.match(full, /viewBox="0 0 640 144"/);
  assert.match(full, /<\/svg>$/);
  // ainda desenha prédios comuns (skyline não fica vazia)
  assert.ok(countStr(full, "<rect") > 10);
  // era acima do teto é clampada e não explode o render
  const capped = sanitizeCity({ v: 1, seed: 2, buildings: 0, pop: 0, types: {}, marcos: [], era: 9999 });
  assert.equal(capped.era, CITY_CAPS.era);
  assert.doesNotThrow(() => citySvg(inp(capped), "full"));
});

test("ESCAPE fim-a-fim: type/marco maliciosos NUNCA injetam markup no SVG (mini e full)", () => {
  const evil = sanitizeCity({
    v: 1,
    seed: 5,
    buildings: 40,
    pop: 40,
    types: { 'x"><script>alert(1)</script>': 3, 'a" onload="x': 2, legit: 1, catedral: 2 },
    marcos: ['x"><g', "<img src=x>", "garden", 'a"b', "catedral"],
  });
  assert.ok(evil);
  for (const variant of ["mini", "full"]) {
    const svg = citySvg(inp(evil), variant);
    // nada de tag/handler injetado a partir do payload
    assert.doesNotMatch(svg, /<script/i);
    assert.doesNotMatch(svg, /<img/i);
    assert.doesNotMatch(svg, /\son\w+=/i); // sem ` onload=`/` onerror=` etc.
    assert.doesNotMatch(svg, /javascript:/i);
    // TODO valor de class derivado do payload é só [a-z0-9 -] — sem aspas/sinais
    // que quebrem o atributo (o "onload" que sobra dentro de um slug é inerte).
    for (const [, val] of svg.matchAll(/class="([^"]*)"/g)) {
      assert.match(val, /^[a-z0-9 -]+$/i, `classe insegura: ${val}`);
    }
  }
  // username com markup só aparece no aria-label, escapado por escapeAttr
  const withMarkupName = citySvg(
    { username: 'mel"><script>', tokens: 0, residents: 0, buildings: 0, city: evil },
    "full"
  );
  assert.doesNotMatch(withMarkupName, /<script/i);
  assert.match(withMarkupName, /aria-label="city of mel&quot;&gt;&lt;script&gt;"/);
});

// ===========================================================================
// FINALE — fogos em TODAS as cidades na última noite (finale=true), ausentes fora
// ===========================================================================
test("FINALE: fogos determinísticos presentes só quando finale=true (seeded)", () => {
  const seeded = { username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 };
  const off = citySvg(seeded, "full", false);
  const on = citySvg(seeded, "full", true);
  // fora do finale: nenhum fogo (cidade seeded não tem marco de fireworks)
  assert.doesNotMatch(off, /tt-finale-fogos/);
  assert.doesNotMatch(off, /tt-burst/);
  assert.doesNotMatch(off, /class="[^"]*\btt-finale\b/);
  // no finale: grupo de fogos + rajadas + classe tt-finale na raiz
  assert.match(on, /tt-finale-fogos/);
  assert.match(on, /tt-burst/);
  assert.match(on, /class="tt-city tt-city-full tt-city-seeded tt-finale"/);
  // determinístico com finale ligado
  assert.equal(citySvg(seeded, "full", true), citySvg(seeded, "full", true));
});

test("FINALE: fogos em TODAS as cidades — mini e grande, com e sem marco fireworks", () => {
  const seeded = { username: "rafa-dev", tokens: 500_000, residents: 10, buildings: 100 };
  // mini também solta fogos no finale (evento do site inteiro)
  assert.match(citySvg(seeded, "mini", true), /tt-finale-fogos/);
  assert.doesNotMatch(citySvg(seeded, "mini", false), /tt-finale-fogos/);
  // cidade REAL sem o marco "fireworks" (rafa): sem fogos fora, com fogos no finale
  const noFw = { v: 1, seed: 99, buildings: 3000, pop: 8000, types: { torre: 40 }, marcos: ["towers", "lighthouse"], era: 6 };
  assert.doesNotMatch(citySvg(inp(noFw), "full", false), /tt-fogos/);
  assert.match(citySvg(inp(noFw), "full", true), /tt-finale-fogos/);
});

test("FINALE: fora do finale o SVG é idêntico ao default (rng dos fogos não perturba o layout)", () => {
  const seeded = { username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 };
  assert.equal(citySvg(seeded, "full"), citySvg(seeded, "full", false));
  assert.equal(citySvg(inp(CITY_MEL), "full"), citySvg(inp(CITY_MEL), "full", false));
});

// ===========================================================================
// A CIDADE RESPIRA — classes de janela que piscam (tt-w1/tt-w2/tt-w3)
// ===========================================================================
test("RESPIRA: janelas acesas recebem classes tt-w1/tt-w2/tt-w3 no gerador", () => {
  const full = citySvg({ username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "full");
  assert.match(full, /class="tt-w1"/);
  assert.match(full, /tt-w[123]/);
  // cidade real também
  assert.match(citySvg(inp(CITY_MEL), "full"), /tt-w[123]/);
  // presentes em ambas as variantes (a diferença é só o CSS, que só anima a grande)
  assert.match(citySvg(inp(CITY_MEL), "mini"), /tt-w[123]/);
});

// ===========================================================================
// COR DE DESTAQUE — accent tinge de leve o dourado das janelas (sutil, não neon)
// ===========================================================================
test("TINT: sem accent -> janelas no dourado padrão (SVG byte-idêntico)", () => {
  assert.deepEqual(accentedWindow(), { warm: "#ffcf7a", bright: "#fff0c0" });
  assert.deepEqual(accentedWindow(null), { warm: "#ffcf7a", bright: "#fff0c0" });
  const seeded = { username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 };
  // input.accent ausente/null == mesmo SVG do default
  assert.equal(citySvg(seeded, "full"), citySvg({ ...seeded, accent: null }, "full"));
});

test("TINT: accent muda o SVG e a cor tingida aparece (seeded e cidade real)", () => {
  const w = accentedWindow("#7fc7bf"); // teal
  assert.notEqual(w.warm, "#ffcf7a"); // de fato tingiu o dourado
  // fallback por username (seeded)
  const seeded = { username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 };
  const plain = citySvg(seeded, "full");
  const teal = citySvg({ ...seeded, accent: "#7fc7bf" }, "full");
  assert.notEqual(plain, teal);
  assert.ok(teal.includes(w.warm), "cor tingida presente no SVG com accent");
  assert.ok(!plain.includes(w.warm), "sem accent, a cor tingida não aparece");
  assert.ok(plain.includes("#ffcf7a"), "sem accent, o dourado padrão está lá");
  // determinístico com accent
  assert.equal(teal, citySvg({ ...seeded, accent: "#7fc7bf" }, "full"));
  // cidade REAL também tinge
  const realPlain = citySvg(inp(CITY_MEL), "full");
  const realTeal = citySvg({ username: "x", tokens: 0, residents: 0, buildings: 0, city: CITY_MEL, accent: "#7fc7bf" }, "full");
  assert.notEqual(realPlain, realTeal);
  assert.ok(realTeal.includes(w.warm));
});

test("cityComposition + cityMarcoLabels: chips ordenados e rótulos en-US", () => {
  const comp = cityComposition(CITY_MEL);
  assert.equal(comp[0].count, 6); // ordenado desc por count (torre=6)
  assert.equal(comp[0].label, "tower");
  assert.ok(comp.find((c) => c.slug === "praca").label === "plaza"); // rótulo bonito
  const marcos = cityMarcoLabels(CITY_MEL);
  assert.ok(marcos.includes("lighthouse with a beam"));
  assert.ok(marcos.includes("fireworks"));
});

// ===========================================================================
// APROXIMAR DO APP — FAROL listrado vermelho/branco (marco `lighthouse`)
// ===========================================================================
test("FAROL: listrado vermelho/branco (fuste claro + faixa vermelha) só com o marco", () => {
  // seeded: farol a partir de >= 1M tokens -> fuste BRANCO (LH_TOWER) + FAIXA VERMELHA (LH_STRIPE)
  const withLH = citySvg({ username: "mel", tokens: TOKEN_LIGHTHOUSE, residents: 20, buildings: 300 }, "full");
  assert.match(withLH, /tt-lighthouse/);
  assert.match(withLH, /tt-beam/);
  assert.ok(withLH.includes(LH_TOWER), "fuste branco do farol presente");
  assert.ok(withLH.includes(LH_STRIPE), "faixa vermelha do farol presente");
  // sem farol (abaixo do limiar): nada de fuste/faixa
  const noLH = citySvg({ username: "mel", tokens: TOKEN_LIGHTHOUSE - 1, residents: 20, buildings: 300 }, "full");
  assert.doesNotMatch(noLH, /tt-lighthouse/);
  assert.ok(!noLH.includes(LH_TOWER));
  assert.ok(!noLH.includes(LH_STRIPE));
  // determinístico com o farol listrado
  assert.equal(withLH, citySvg({ username: "mel", tokens: TOKEN_LIGHTHOUSE, residents: 20, buildings: 300 }, "full"));
});

test("FAROL: cidade REAL com o marco lighthouse também fica listrada (mesmo estilo)", () => {
  const rafa = citySvg(inp(CITY_RAFA), "full"); // rafa tem marco "lighthouse"
  assert.match(rafa, /tt-lighthouse/);
  assert.ok(rafa.includes(LH_TOWER) && rafa.includes(LH_STRIPE));
  // cidade real SEM o marco (ju) não tem farol nem as cores do fuste/faixa
  const ju = citySvg(inp(CITY_JU), "full");
  assert.doesNotMatch(ju, /tt-lighthouse/);
  assert.ok(!ju.includes(LH_STRIPE));
});

// ===========================================================================
// A CIDADE NÃO TEM NOMES — nenhum texto/placa de skill é desenhado na cidade.
// (Os nomes de skill vivem só no painel de texto "How this city was built".)
// ===========================================================================
test("SEM NOMES: a cidade não desenha texto/placa de skill (mini e full, seeded e real)", () => {
  const svgs = [
    citySvg({ username: "copy-mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "full"),
    citySvg({ username: "copy-mel", tokens: 8_400_000, residents: 41, buildings: 1402 }, "mini"),
    citySvg(inp(CITY_MEL), "full"),
    citySvg(inp(CITY_MEL), "mini"),
  ];
  for (const s of svgs) {
    assert.doesNotMatch(s, /<text/i); // sem elementos de texto (nenhuma placa)
    assert.doesNotMatch(s, /COPY-MEL/); // sem nome de skill em maiúsculas na arte
  }
});

// ===========================================================================
// MAIS DETALHE/TEXTURA nos prédios (aproxima o LOOK do app: telhados com
// personalidade, janelas variadas, cornija, dithering). Determinístico.
// ===========================================================================
test("DETALHE: telhados com personalidade (antena com luz) desenhados na skyline", () => {
  // tokens < 300k => SEM balsa e SEM farol, então a luz de antena (#ff8a6a) só
  // pode vir do telhado-antena NOVO -> prova que a variedade de telhado foi desenhada.
  const inpLow = { username: "mel", tokens: 120_000, residents: 40, buildings: 1402 };
  const full = citySvg(inpLow, "full");
  const mini = citySvg(inpLow, "mini");
  assert.doesNotMatch(full, /tt-ferry/);
  assert.doesNotMatch(full, /tt-lighthouse/);
  assert.ok(full.includes("#ff8a6a"), "luz de antena no telhado (detalhe novo) presente na grande");
  assert.ok(mini.includes("#ff8a6a"), "detalhe de telhado também na mini");
  // determinístico com o detalhe extra
  assert.equal(full, citySvg(inpLow, "full"));
  assert.equal(mini, citySvg(inpLow, "mini"));
});

test("DETALHE: a cidade grande é mais rica (mais retângulos) que a mini; real idem", () => {
  const cnt = (s) => s.split("<rect").length - 1;
  const seeded = { username: "mel", tokens: 8_400_000, residents: 41, buildings: 1402 };
  assert.ok(cnt(citySvg(seeded, "full")) > cnt(citySvg(seeded, "mini")));
  assert.ok(cnt(citySvg(inp(CITY_MEL), "full")) > cnt(citySvg(inp(CITY_MEL), "mini")));
  // e a cidade real segue determinística com toda a textura nova
  assert.equal(citySvg(inp(CITY_MEL), "full"), citySvg(inp(CITY_MEL), "full"));
});
