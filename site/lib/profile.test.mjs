// Testes da personalização leve (nome da cidade, lema, cor de destaque).
// Roda com Node 22+/24 (strip de tipos nativo):  node lib/profile.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeProfile,
  mergeProfile,
  accentHex,
  cityTitle,
  isAccent,
  ACCENTS,
  DEFAULT_ACCENT,
  PROFILE_CAPS,
} from "./profile.ts";

// ---------------------------------------------------------------------------
// sanitizeProfile — aceita válido, normaliza, e ignora campo inválido
// ---------------------------------------------------------------------------
test("aceita perfil completo válido", () => {
  const p = sanitizeProfile({ cityName: "Meltown", motto: "feita de tokens e teimosia", accent: "dourado" });
  assert.deepEqual(p, { cityName: "Meltown", motto: "feita de tokens e teimosia", accent: "dourado" });
});

test("aceita letras acentuadas, hífen e apóstrofo (pt-BR)", () => {
  assert.equal(sanitizeProfile({ cityName: "São Paulo-2" }).cityName, "São Paulo-2");
  assert.equal(sanitizeProfile({ cityName: "Ju's Town" }).cityName, "Ju's Town");
  assert.equal(sanitizeProfile({ cityName: "Porto Verde" }).cityName, "Porto Verde");
});

test("TAMANHO: cityName <= 24, motto <= 48 (corta o excesso)", () => {
  const longCity = "a".repeat(40);
  const longMotto = "b".repeat(80);
  const p = sanitizeProfile({ cityName: longCity, motto: longMotto });
  assert.equal(p.cityName.length, PROFILE_CAPS.cityName);
  assert.equal(p.cityName.length, 24);
  assert.equal(p.motto.length, PROFILE_CAPS.motto);
  assert.equal(p.motto.length, 48);
});

test("ACCENT fora da lista é ignorado; da lista é aceito (case-sensitive slug)", () => {
  assert.equal(sanitizeProfile({ accent: "teal" }).accent, "teal");
  assert.equal(sanitizeProfile({ accent: "verde" }).accent, "verde");
  // fora da lista -> accent some (mas o resto do perfil sobrevive)
  assert.equal(sanitizeProfile({ cityName: "X", accent: "neon" }).accent, undefined);
  assert.equal(sanitizeProfile({ cityName: "X", accent: "rgb(1,2,3)" }).accent, undefined);
  assert.equal(sanitizeProfile({ cityName: "X", accent: "#ff0000" }).accent, undefined);
  assert.equal(sanitizeProfile({ cityName: "X", accent: "DOURADO" }).accent, undefined); // slug exato
  assert.equal(sanitizeProfile({ accent: 123 }), null);
});

test("MARKUP: nunca passa < > \" nem tags (vira texto inerte ou some)", () => {
  const p = sanitizeProfile({ cityName: '<script>alert(1)</script>', motto: 'a"><img src=x onerror=y>' });
  // sobra texto, mas sem NENHUM caractere de markup
  for (const v of [p.cityName, p.motto]) {
    if (v == null) continue;
    assert.ok(!v.includes("<"), `sobrou "<": ${v}`);
    assert.ok(!v.includes(">"), `sobrou ">": ${v}`);
    assert.ok(!v.includes('"'), `sobrou aspas: ${v}`);
    assert.ok(!/\bon\w+=/.test(v), `sobrou handler: ${v}`);
  }
  // cityName só de markup -> vira vazio -> campo some -> perfil todo vazio -> null
  assert.equal(sanitizeProfile({ cityName: "<<<>>>" }), null);
});

test("perfil todo inválido/ausente -> null (o store PRESERVA o existente)", () => {
  assert.equal(sanitizeProfile(null), null);
  assert.equal(sanitizeProfile(undefined), null);
  assert.equal(sanitizeProfile("nope"), null);
  assert.equal(sanitizeProfile([1, 2, 3]), null);
  assert.equal(sanitizeProfile({}), null);
  assert.equal(sanitizeProfile({ accent: "neon", cityName: "   " }), null);
  assert.equal(sanitizeProfile({ cityName: 123, motto: {} }), null);
});

test("campos parciais são aceitos isoladamente", () => {
  assert.deepEqual(sanitizeProfile({ accent: "rosa" }), { accent: "rosa" });
  assert.deepEqual(sanitizeProfile({ cityName: "Só Nome" }), { cityName: "Só Nome" });
  assert.deepEqual(sanitizeProfile({ motto: "só lema" }), { motto: "só lema" });
});

// ---------------------------------------------------------------------------
// accentHex / isAccent — mapeamento slug -> hex da paleta
// ---------------------------------------------------------------------------
test("accentHex mapeia os 6 slugs e cai no dourado quando inválido", () => {
  assert.equal(accentHex("teal"), "#7fc7bf");
  assert.equal(accentHex("dourado"), ACCENTS.dourado);
  assert.equal(accentHex("verde"), ACCENTS.verde);
  assert.equal(accentHex("neon"), ACCENTS[DEFAULT_ACCENT]); // default
  assert.equal(accentHex(undefined), ACCENTS[DEFAULT_ACCENT]);
  assert.equal(accentHex(null), ACCENTS[DEFAULT_ACCENT]);
  // exatamente 6 slugs
  assert.equal(Object.keys(ACCENTS).length, 6);
  for (const slug of Object.keys(ACCENTS)) assert.ok(isAccent(slug));
  assert.ok(!isAccent("laranja"));
});

// ---------------------------------------------------------------------------
// cityTitle — cityName ou fallback "cidade de {username}"
// ---------------------------------------------------------------------------
test("cityTitle usa cityName, senão cai no fallback", () => {
  assert.equal(cityTitle({ cityName: "Meltown" }, "mel"), "Meltown");
  assert.equal(cityTitle({ motto: "x" }, "mel"), "city of mel"); // sem cityName
  assert.equal(cityTitle(null, "rafa-dev"), "city of rafa-dev");
  assert.equal(cityTitle(undefined, "ju-ships"), "city of ju-ships");
});

// ---------------------------------------------------------------------------
// CLEAR semantics — "" explícito é um sinal de LIMPEZA (null no patch), campo
// ausente/inválido é PRESERVE (fica de fora do patch), e nunca vira "".
// ---------------------------------------------------------------------------
test('"" explícito em cityName/motto vira CLEAR (null no patch)', () => {
  assert.deepEqual(sanitizeProfile({ motto: "" }), { motto: null });
  assert.deepEqual(sanitizeProfile({ cityName: "" }), { cityName: null });
  assert.deepEqual(sanitizeProfile({ cityName: "Meltown", motto: "" }), {
    cityName: "Meltown",
    motto: null,
  });
});

test("campo AUSENTE fica de fora do patch (preserva); só-markup e whitespace NÃO limpam", () => {
  // ausente -> nem aparece no patch
  assert.equal("motto" in (sanitizeProfile({ cityName: "X" }) ?? {}), false);
  // whitespace não é "" -> limpa pra vazio -> tratado como inválido -> fora do patch (preserva)
  assert.equal("cityName" in (sanitizeProfile({ cityName: "   ", motto: "ok" }) ?? {}), false);
  // só-markup vira vazio -> inválido -> fora do patch (preserva), NÃO limpa
  assert.equal("cityName" in (sanitizeProfile({ cityName: "<<<>>>", motto: "ok" }) ?? {}), false);
});

// ---------------------------------------------------------------------------
// mergeProfile — SET / CLEAR / PRESERVE por campo, aplicado ao prev guardado
// ---------------------------------------------------------------------------
test("mergeProfile: null de patch preserva o prev inteiro", () => {
  const prev = { cityName: "Meltown", motto: "x", accent: "teal" };
  assert.deepEqual(mergeProfile(prev, null), prev);
  assert.equal(mergeProfile(null, null), null);
});

test("mergeProfile: CLEAR apaga só o campo, PRESERVE mantém os outros", () => {
  const prev = { cityName: "Meltown", motto: "old motto", accent: "dourado" };
  // limpa só o motto (patch de "" -> null); cityName/accent ausentes -> preservados
  assert.deepEqual(mergeProfile(prev, sanitizeProfile({ motto: "" })), {
    cityName: "Meltown",
    accent: "dourado",
  });
  // seta um novo motto, preserva o resto
  assert.deepEqual(mergeProfile(prev, sanitizeProfile({ motto: "new" })), {
    cityName: "Meltown",
    motto: "new",
    accent: "dourado",
  });
});

test("mergeProfile: limpar o último campo -> null (store apaga o profile)", () => {
  assert.equal(mergeProfile({ motto: "só isso" }, sanitizeProfile({ motto: "" })), null);
});
