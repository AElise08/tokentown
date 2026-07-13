// Testes do game.js (renderer) rodando em node com DOM/canvas STUBADOS à mão
// (ZERO deps). Carrega o IIFE do game.js sob stubs e dirige alguns quadros pra
// checar o HUD — foco na ÉPOCA NOVA (01/07/2026): "temporada 0 · faltam Nd",
// na POPULAÇÃO derivada da cidade, na drenagem do backlog de auto-builds e no
// shape do retrato da cidade (city blob) enviado por window.tt.sendCity.
//   node test-game.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");

// época idêntica à do game.js — pra calcular o esperado do HUD sem hardcode frágil.
const EPOCH = Date.UTC(2026, 6, 1), MS = 28 * 86400000;
const refSeasonId = Math.floor((Date.now() - EPOCH) / MS);
const refDaysLeft = Math.max(0, Math.ceil((EPOCH + (refSeasonId + 1) * MS - Date.now()) / 86400000));
const refSeasonStr = "temporada " + refSeasonId + " · faltam " + refDaysLeft + "d";

// ---- stubs -------------------------------------------------------------
// ctx STUBADO que grava fillRect/fillText -> deixa os testes do RECREIO checarem
// a posição do jogador (retângulo do corpo) e o placar (texto do HUD) sem DOM real.
function ctxStub(rec) {
  const base = { fillStyle: "" };
  return new Proxy(base, {
    get: (t, p) => {
      if (p === "fillRect") return (x, y, w, h) => rec.rects.push({ c: t.fillStyle, x, y, w, h });
      if (p === "fillText") return (str) => rec.texts.push(String(str));
      return (p in t ? t[p] : function () {});
    },
    set: (t, p, v) => { t[p] = v; return true; }
  });
}
// elemento com captura de listeners (click/pointerdown/mousedown) p/ simular a Mel clicando.
function makeEl(id, rec) {
  const L = {};
  const t = { id: id, textContent: "", innerHTML: "", hidden: false, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll() { return []; },
    addEventListener(ev, cb) { (L[ev] = L[ev] || []).push(cb); }, _L: L,
    focus() { this._focused = true; }, getContext() { return ctxStub(rec); } };
  return new Proxy(t, { get: (o, p) => (p in o ? o[p] : function () {}), set: (o, p, v) => { o[p] = v; return true; } });
}
// Math.random determinístico (opts.seed) só durante o LOAD -> semente/BACKPAT reprodutíveis.
function seededRandom(seed) { let s = seed >>> 0; return function () {
  s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function loadGame(opts) {
  opts = opts || {};
  const rec = { rects: [], texts: [] }, docL = {};
  const ids = ["scene", "tok", "builds", "pop", "live", "liveTxt", "cost", "season", "wish", "note", "recreio", "card", "close"];
  const els = {}; ids.forEach((id) => (els[id] = makeEl(id, rec)));
  let usageCb = null, setupCb = null, clock = 1000, stored = null, lastCity = null, winFocused = false;
  const g = global;
  g.matchMedia = () => ({ matches: !!opts.reduce }); // opts.reduce -> prefers-reduced-motion
  g.document = { getElementById: (id) => els[id] || null,
    addEventListener(ev, cb) { (docL[ev] = docL[ev] || []).push(cb); } };
  g.performance = { now: () => clock };
  g.requestAnimationFrame = (cb) => { stored = cb; return 1; };
  const mem = new Map();
  g.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  g.window = opts.real
    ? { tt: { onUsage: (cb) => { usageCb = cb; }, onSetup: (cb) => { setupCb = cb; }, sendCity: (c) => { lastCity = c; } }, focus() { winFocused = true; } }
    : { focus() { winFocused = true; } };
  const oldRandom = Math.random; if (opts.seed != null) Math.random = seededRandom(opts.seed);
  try { vm.runInThisContext(SRC, { filename: "game.js" }); } finally { Math.random = oldRandom; }
  const gwin = g.window;                                                      // janela DESTA instância
  const fire = (list, ev) => { (list || []).forEach((cb) => cb(ev)); };
  const reset = () => { rec.rects = []; rec.texts = []; };
  return {
    els,
    hook: () => gwin.__rc,                                                    // geração determinística + estado do recreio
    env: () => gwin.__env,                                                    // hook do MODO CIDADE (relógio/clima/janelas/CAP)
    setClock: (fn) => gwin.__env.setClock(fn),                               // injeta a HORA LOCAL nos testes
    state: () => gwin.__rc.state(),                                           // rc vivo (arrays de entidades) p/ cenários
    pump(n) { for (let i = 0; i < (n || 1); i++) { if (!stored) break; clock += 200; reset(); stored(clock); } },
    frame(dt) { if (!stored) return; clock += (dt || 16); reset(); stored(clock); }, // 1 quadro (dt fino p/ física do recreio)
    emit(d) { if (usageCb) usageCb(d); },
    emitSetup(d) { if (setupCb) setupCb(d); },                                  // IPC 'setup' (Fase 3/A4)
    city() { return lastCity; },
    click(id) { fire(els[id]._L.click, {}); },                                 // clique num elemento
    keydown(key) { fire(docL.keydown, { key: key, preventDefault() {} }); },   // tecla PRESSIONADA (no document)
    keyup(key) { fire(docL.keyup, { key: key, preventDefault() {} }); },        // tecla SOLTA (no document)
    canvasDown() { fire(els.scene._L.pointerdown, { preventDefault() {} }); },  // clique/tap na cena
    hasCanvasJump() { return !!(els.scene._L.pointerdown || els.scene._L.mousedown); },
    winFocused() { return winFocused; },
    // bonequinha do recreio (sprite EFETIVO 10x16 na tela, zoom RZ=2): a CAMISA
    // '#f2a63c' segue sendo a cor-âncora ÚNICA na cena, agora em pixels 1x1 nas
    // linhas 6-10 do sprite (linha de baixo da camisa = pés-6 na tela). pés em
    // MUNDO = (maxY(camisa)+6)/2 — thresholds de Y dos testes em unidades de
    // MUNDO; playerX devolve o centro em px de TELA (comparações relativas).
    playerY() { let m = null; for (const r of rec.rects) if (r.c === "#f2a63c" && r.w === 1 && r.h === 1) { if (m == null || r.y > m) m = r.y; } return m == null ? null : (m + 6) / 2; },
    playerX() { let lo = null, hi = null; for (const r of rec.rects) if (r.c === "#f2a63c" && r.w === 1 && r.h === 1) { if (lo == null || r.x < lo) lo = r.x; if (hi == null || r.x > hi) hi = r.x; } return lo == null ? null : (lo + hi + 1) / 2; },
    // pixels do sprite por cor exata (1x1) — p/ medir contorno/tamanho do bonequinho.
    pixels(color) { const a = []; for (const r of rec.rects) if (r.c === color && r.w === 1 && r.h === 1) a.push(r); return a; },
    rects() { return rec.rects.slice(); },
    score() { for (const s of rec.texts) { const m = /recreio · (\d+) tokens/.exec(s); if (m) return +m[1]; } return null; },
    texts() { return rec.texts.slice(); },
    // cor RGB do topo do céu (1º rect largo do quadro: R(0,0,W,...)) -> [r,g,b] p/ medir claro/escuro.
    topSky() { for (const r of rec.rects) if (r.x === 0 && r.y === 0 && r.w === 256) { const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(r.c); return m ? [+m[1], +m[2], +m[3]] : null; } return null; },
    // nº de partículas de FOGOS no céu neste quadro (rects 2x2, y<60, cor da paleta de fogos).
    fw() { let c = 0; for (const r of rec.rects) if (r.w === 2 && r.h === 2 && r.y < 60 && /^#(ffd479|ff9ec4|8ad8ff)$/.test(r.c)) c++; return c; },
  };
}
function warm(g, k) { for (let i = 0; i < (k || 10); i++) g.frame(16); } // deixa o setLive/HUD (a cada ~120ms) rodar

let total = 0, fails = 0;
function t(name, fn) { total++; try { fn(); process.stdout.write("."); } catch (e) { fails++; console.log("\nFAIL: " + name + "\n  " + (e && e.message)); } }

// ---- PREVIEW (sem window.tt): temporada local ------------------------------
t("preview: HUD mostra temporada 0 (época nova)", () => {
  const g = loadGame(); g.pump(4);
  assert.ok(/^temporada 0 · faltam \d+d$/.test(g.els.season.textContent), "season=" + g.els.season.textContent);
});
t("preview: dias restantes batem com a fórmula da época", () => {
  const g = loadGame(); g.pump(4);
  assert.strictEqual(g.els.season.textContent, refSeasonStr);
});
t("preview: seasonId corrente = 0", () => { assert.strictEqual(refSeasonId, 0); });
t("preview: 'ao vivo' no navegador", () => {
  const g = loadGame(); g.pump(4);
  assert.strictEqual(g.els.liveTxt.textContent, "ao vivo");
});
t("preview: mostra 'tokens' e custo em US$", () => {
  const g = loadGame(); g.pump(4);
  assert.ok(/tokens/.test(g.els.tok.innerHTML));
  assert.ok(/US\$/.test(g.els.cost.textContent));
});
t("preview: prédios é um número >= 2", () => {
  const g = loadGame(); g.pump(4);
  const b = parseInt(g.els.builds.textContent, 10);
  assert.ok(Number.isFinite(b) && b >= 2, "builds=" + g.els.builds.textContent);
});

// ---- REAL (com window.tt): dados vindos do main via IPC --------------------
const sumTypes = (o) => Object.keys(o || {}).reduce((a, k) => a + o[k], 0);

t("real: evento de uso mostra temporada 0 · faltam 17d", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 20895848, residents: 21, cost: 731.6, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  assert.strictEqual(g.els.season.textContent, "temporada 0 · faltam 17d");
});
t("real: população derivada da cidade aparece formatada (não é residents)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 3000000, residents: 21, cost: 10, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(6);
  const p = String(g.els.pop.textContent);
  assert.ok(/^[0-9][0-9.,]*[kMBT]?$/.test(p), "pop=" + p);
  assert.notStrictEqual(p, "0");     // com 3M tokens a cidade tem milhares de habitantes
  assert.notStrictEqual(p, "21");    // NÃO é mais o número de subagentes
});
t("real: custo real renderizado (US$ 731,60)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 20895848, residents: 21, cost: 731.6, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  assert.ok(/731/.test(g.els.cost.textContent), "cost=" + g.els.cost.textContent);
});
t("real: live=true -> 'ao vivo'", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 5000, residents: 1, cost: 0.5, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  assert.strictEqual(g.els.liveTxt.textContent, "ao vivo");
});
t("real: live=false -> 'ocioso'", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 5000, residents: 1, cost: 0.5, live: false, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  assert.strictEqual(g.els.liveTxt.textContent, "ocioso");
});
t("real: daysLeft do evento manda no HUD", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 5000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 15 });
  g.pump(4);
  assert.strictEqual(g.els.season.textContent, "temporada 0 · faltam 15d");
});
t("real: prédios crescem com os tokens (>=2)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 600000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(6);
  const b = parseInt(g.els.builds.textContent, 10);
  assert.ok(b > 2, "builds=" + g.els.builds.textContent);
});
t("real: novo evento com mais subagentes não quebra o display", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 100000, residents: 21, cost: 5, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(3);
  g.emit({ total: 120000, residents: 25, cost: 6, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(3);
  assert.ok(/\d/.test(String(g.els.pop.textContent)), "pop=" + g.els.pop.textContent);
});
t("real: virada de temporada em runtime não quebra (despedida)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 100000, residents: 3, cost: 5, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(3);
  g.emit({ total: 120000, residents: 3, cost: 6, live: true, seasonId: 1, daysLeft: 28 });
  g.pump(4); // fade de despedida começou; seasonId ainda 0 (só troca ao fim do fade)
  assert.ok(/^temporada 0 · /.test(g.els.season.textContent), "season=" + g.els.season.textContent);
});

// ---- CONSTRUÇÃO: só ergue com TOKEN REAL (regra da Mel) ----------------------
// (a) BOOT/salto grande: a cidade nasce INSTANTÂNEA no tamanho da temporada (rebuild) —
//     sem gotejo gradual enquanto ociosa.
t("real: boot ergue a cidade INTEIRA de uma vez (sem gotejo)", () => {
  const g = loadGame({ real: true });
  // 3M tokens => owed = floor(3M/150k) = 20 especiais; ~502 prédios normais (6k tok/prédio).
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(6);                        // poucos quadros -> já deve estar no tamanho certo
  const c1 = g.city();
  const n1 = c1 ? sumTypes(c1.types) : 0;
  assert.strictEqual(n1, 20, "cidade não nasceu no tamanho da temporada de uma vez (n1=" + n1 + ", owed=20)");
  assert.ok(c1.buildings >= 500, "prédios normais não nasceram instantâneos (buildings=" + c1.buildings + ")");
});
// (b) OCIOSA (token delta 0): NENHUMA construção nova — nem especial, nem prédio.
t("real: ociosa (token delta 0) => contagem de prédios NÃO muda", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(10);
  const b0 = parseInt(g.els.builds.textContent, 10);
  const s0 = sumTypes(g.city().types);
  g.pump(400);                      // ~80s ociosa (nenhum emit novo) -> tempo de sobra p/ um gotejo antigo
  const b1 = parseInt(g.els.builds.textContent, 10);
  const s1 = sumTypes(g.city().types);
  assert.strictEqual(b1, b0, "prédios cresceram ociosa (b0=" + b0 + " b1=" + b1 + ")");
  assert.strictEqual(s1, s0, "especiais surgiram ociosa sem queimar token (s0=" + s0 + " s1=" + s1 + ")");
});
// (c) DEPOIS: token REAL entra (delta>0) => a cidade cresce (na medida do delta).
t("real: token novo (delta>0) => nova construção aparece", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(10);
  const s0 = sumTypes(g.city().types);           // 20
  g.emit({ total: 3300000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 }); // +300k => +2 owed
  g.pump(10);
  const s1 = sumTypes(g.city().types);
  assert.ok(s1 > s0, "especial não apareceu com token novo (s0=" + s0 + " s1=" + s1 + ")");
  assert.ok(s1 <= 22, "cresceu além do devido (s1=" + s1 + ", owed=22)");
});

// ---- CITY BLOB: shape do contrato enviado por tt.sendCity -------------------
t("real: city blob segue o contrato e cabe em 2KB", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 3000000, residents: 5, cost: 12, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(30);
  const c = g.city();
  assert.ok(c, "nenhuma cidade enviada ao main");
  assert.strictEqual(c.v, 1);
  assert.strictEqual(typeof c.seed, "number");
  assert.ok(c.buildings >= 2, "buildings=" + c.buildings);
  assert.ok(c.pop >= 0 && Number.isFinite(c.pop), "pop=" + c.pop);
  assert.strictEqual(typeof c.types, "object");
  assert.ok(Array.isArray(c.marcos), "marcos não é array");
  assert.strictEqual(typeof c.era, "number");
  assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 2048, "blob > 2KB");
});

// ---- FORMATO pt-BR do número (BUG 2): 27,2M em vez de 27M, vírgula, 1 casa em >=1M ----
// (mesma régua do site em tokentown-placar/lib/format.ts: 1 casa decimal, some ",0", vírgula)
t("real: token >=1M mostra 1 casa decimal com vírgula (ex.: 27,3M)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 27279132, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  const s = String(g.els.tok.innerHTML);
  assert.ok(/27,3M/.test(s), "tok=" + s);       // 27,3M (arredonda como o site), NÃO "27M"
  assert.ok(!/27M/.test(s.replace("27,3M", "")), "ainda mostra 27M cru");
});
t("real: 1,3M formatado com vírgula", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 1300000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  assert.ok(/1,3M/.test(String(g.els.tok.innerHTML)), "tok=" + g.els.tok.innerHTML);
});
t("preview: milhão redondo some o ',0' (2M, não 2,0M)", () => {
  // sem window.tt o preview simula tokens; aqui checo a fmt via um valor real perto de 2M
  const g = loadGame({ real: true });
  g.emit({ total: 2000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.pump(4);
  const s = String(g.els.tok.innerHTML);
  assert.ok(/(^|[^\d,])2M/.test(s) && !/2,0M/.test(s), "tok=" + s);
});

// ============================================================================
// RECREIO — "Mario na nossa cidade": platformer de CONTROLE TOTAL (só AO VIVO).
// A jogadora ANDA ←→ e PULA sobre os telhados; os vãos são buracos reais (cair =
// perde e volta suave pro início). Física clássica: aceleração/atrito, pulo de
// altura variável, coyote time, input buffer; bloco ? solta token; plataforma
// sólida por cima e vazada por baixo (EXCETO o bloco ?). Os testes DIRIGEM o jogo
// por teclado/clique e leem a cena desenhada (corpo da jogadora + placar), sem
// afrouxar. ZOOM 2x: o mundo é 128×72 (cada px de mundo = 2x2 na tela); o INTRO
// determinístico agora é: berço largo P0 em top=40 (mundo); sacada one-way em
// top=30 sobre o berço; bloco ? em x36..48 (y20..28); vão real em 64..78; pulo
// cheio com ápice ~15 de mundo.
// ============================================================================
const LIVE = { total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 };
function enter(seed) { const g = loadGame({ real: true, seed: seed });
  g.emit(LIVE); g.frame(16); g.click("recreio"); return g; }   // fica ao vivo e entra no recreio

t("recreio: botão some ocioso e aparece ao vivo", () => {
  const g = loadGame({ real: true, seed: 1 });
  g.emit({ total: 3000000, residents: 0, cost: 0, live: false, seasonId: 0, daysLeft: 17 }); warm(g);
  assert.ok(g.els.recreio.hidden, "botão devia sumir ocioso");
  g.emit(LIVE); warm(g);
  assert.ok(!g.els.recreio.hidden, "botão devia aparecer ao vivo");
});
t("recreio: clicar ▶ entra no modo e foca a janela", () => {
  const g = enter(2);
  assert.strictEqual(g.els.recreio.textContent, "◼ sair");
  assert.ok(g.winFocused(), "window.focus() não foi chamado ao entrar");
});
t("recreio: NÃO entra se o agente está ocioso", () => {
  const g = loadGame({ real: true, seed: 3 });
  g.emit({ total: 3000000, residents: 0, cost: 0, live: false, seasonId: 0, daysLeft: 17 }); g.frame(16);
  g.click("recreio");
  assert.notStrictEqual(g.els.recreio.textContent, "◼ sair");
});
t("recreio: nasce sobre o telhado-berço e NÃO cai no 1º frame", () => {
  const g = enter(6);
  for (let i = 0; i < 6; i++) g.frame(16);
  const y = g.playerY();
  assert.ok(y != null && y >= 34 && y <= 46, "não está sobre o berço (caiu?): " + y);   // P0 top=40 (mundo)
});
t("recreio: espaço faz a jogadora pular (sobe)", () => {
  const g = enter(4); g.frame(16); const y0 = g.playerY();
  g.keydown(" "); g.frame(16); const y1 = g.playerY();
  assert.ok(y0 != null && y1 != null && y1 < y0, "não pulou com espaço: " + y0 + "->" + y1);
});
t("recreio: clique/tap no canvas também pula (rede do mouse p/ o foco)", () => {
  const g = loadGame({ real: true, seed: 5 });
  assert.ok(g.hasCanvasJump(), "canvas sem handler de pulo por clique");
  g.emit(LIVE); g.frame(16); g.click("recreio"); g.frame(16); const y0 = g.playerY();
  g.canvasDown(); g.frame(16); const y1 = g.playerY();
  assert.ok(y0 != null && y1 != null && y1 < y0, "não pulou com clique: " + y0 + "->" + y1);
});

// ---- CONTROLE TOTAL: andar com física de plataforma ------------------------
t("recreio: segurar → anda pra direita COM ACELERAÇÃO (ganha velocidade)", () => {
  const g = enter(11); g.frame(16);
  const xs = [g.playerX()];
  g.keydown("ArrowRight");
  for (let i = 0; i < 8; i++) { g.frame(16); xs.push(g.playerX()); }
  assert.ok(xs[xs.length - 1] > xs[0] + 3, "não andou pra direita: " + xs.join(","));
  const d1 = xs[1] - xs[0], d5 = xs[5] - xs[4];        // deslocamento por quadro CRESCE = acelerou
  assert.ok(d5 > d1, "não acelerou (d1=" + d1.toFixed(2) + " d5=" + d5.toFixed(2) + ")");
});
t("recreio: segurar seta é ESTADO (anda contínuo; soltar para)", () => {
  const g = enter(12); g.frame(16); const x0 = g.playerX();
  g.keydown("ArrowRight");                              // UM só keydown
  for (let i = 0; i < 10; i++) g.frame(16);             // sem novos eventos -> segue andando
  assert.ok(g.playerX() > x0 + 6, "seta segurada não andou contínuo: " + x0 + "->" + g.playerX());
  g.keyup("ArrowRight");
  for (let i = 0; i < 12; i++) g.frame(16);             // soltou -> atrito para (velocidade -> 0)
  const a = g.playerX(); g.frame(16); const b = g.playerX();
  assert.ok(Math.abs(b - a) < 0.3, "não parou de andar após soltar a seta (Δ=" + (b - a).toFixed(3) + ")");
});
t("recreio: pulo VARIÁVEL — segurar sobe mais alto que um toque", () => {
  let g = enter(13); g.frame(16);
  g.keydown(" "); g.keyup(" ");                         // toque: corta o pulo cedo
  let apexTap = g.playerY(); for (let i = 0; i < 20; i++) { g.frame(16); apexTap = Math.min(apexTap, g.playerY()); }
  g = enter(14); g.frame(16);
  g.keydown(" ");                                        // segurar: pulo cheio (sem soltar)
  let apexHold = g.playerY(); for (let i = 0; i < 20; i++) { g.frame(16); apexHold = Math.min(apexHold, g.playerY()); }
  assert.ok(apexHold < apexTap - 6, "segurar não pulou mais alto (tap=" + apexTap + " hold=" + apexHold + ")");
});
t("recreio: COYOTE TIME — pular logo após sair da beirada ainda funciona", () => {
  const g = enter(15); g.keydown("ArrowRight");
  let left = false, jumped = false;
  for (let i = 0; i < 120 && !jumped; i++) {
    g.frame(16); const y = g.playerY();
    if (!left && y > 40.5) {          // acabou de sair do berço (top=40, começou a cair) -> coyote
      left = true; const yb = g.playerY();
      g.keydown(" "); g.frame(16); g.frame(16);
      jumped = g.playerY() < yb;      // subiu no ar (só é possível com o coyote time)
    }
  }
  assert.ok(left, "a jogadora nunca saiu da beirada");
  assert.ok(jumped, "coyote falhou: pular logo após a beirada não subiu");
});

// ---- VÃOS: cair perde e volta suave pro início -----------------------------
t("recreio: cair no vão PERDE e reseta pro início (recorde salvo)", () => {
  const g = enter(16); g.keydown("ArrowRight");         // anda e NÃO pula -> cai no vão 64..78
  let sawDeath = false, reset = false;
  for (let i = 0; i < 240 && !reset; i++) {
    g.frame(16);
    if (g.texts().some((s) => /você caiu/.test(s))) sawDeath = true;
    if (sawDeath && g.playerY() != null && g.playerY() <= 40.5 && g.score() === 0) reset = true;
  }
  assert.ok(sawDeath, "não mostrou o recado de queda 'você caiu'");
  assert.ok(reset, "não voltou suave pro início (berço + placar 0) depois de cair");
});

// ---- BLOCO ? e COLISÃO de plataforma ---------------------------------------
t("recreio: bloco ? solta token quando batido POR BAIXO (placar sobe)", () => {
  const g = enter(17); const st = g.state();
  const q = st.blocks.find((b) => !b.used);             // 1º bloco ? da abertura (posição SORTEADA pelo runSeed)
  assert.ok(q, "abertura sem bloco ?");
  st.px = q.x + q.w / 2; st.vx = 0;                      // posiciona sob o CENTRO do bloco, no berço (topo 40)
  st.py = st.plats[0].top; st.onGround = true;
  const s0 = st.score;
  g.keydown(" ");                                        // pula reto -> a cabeça bate embaixo do bloco
  for (let i = 0; i < 16; i++) g.frame(16);
  assert.ok(q.used, "o bloco ? não foi batido por baixo (x=" + q.x + ")");
  assert.ok(st.score > s0, "bloco ? não soltou token ao bater por baixo (s0=" + s0 + " -> " + st.score + ")");
});
t("recreio: plataforma SÓLIDA por cima e VAZADA por baixo (sacada one-way)", () => {
  // pulo cheio reto sob a sacada suspensa (top=30, sobre o berço em top=40):
  // subindo ATRAVESSA (vazada por baixo) e, caindo, POUSA em cima (sólida por cima).
  const g = enter(18); g.frame(16);
  g.keydown(" ");
  let minY = g.playerY(); for (let i = 0; i < 16; i++) { g.frame(16); minY = Math.min(minY, g.playerY()); }
  assert.ok(minY < 30, "não atravessou a sacada por baixo (não subiu além do topo dela): minY=" + minY);
  g.keyup(" ");
  for (let i = 0; i < 22; i++) g.frame(16);
  const yf = g.playerY();
  assert.ok(yf < 36, "não pousou EM CIMA da sacada (ficaria no berço 40): yf=" + yf);
});

// ---- COLETA / PAUSA / SAÍDA ------------------------------------------------
t("recreio: coleta token dourado andando -> placar sobe", () => {
  const g = enter(7); g.keydown("ArrowRight");
  let best = 0;
  for (let i = 0; i < 60; i++) { g.frame(16); const s = g.score(); if (s != null && s > best) best = s; }
  assert.ok(best >= 1, "nunca coletou um token andando (best=" + best + ")");
});
t("recreio: live=false PAUSA com recado LEGÍVEL (jogadora congela)", () => {
  const g = enter(8); for (let i = 0; i < 3; i++) g.frame(16);
  g.emit({ total: 3000000, residents: 0, cost: 0, live: false, seasonId: 0, daysLeft: 17 }); // agente terminou
  const ys = []; for (let i = 0; i < 5; i++) { g.frame(16); ys.push(g.playerY()); }
  assert.ok(ys.every((y) => y === ys[0]), "jogadora não congelou na pausa: " + ys.join(","));
  assert.ok(g.texts().some((s) => /o agente terminou/.test(s)), "faltou o recado da pausa");
  assert.ok(g.texts().some((s) => /sua vez de trabalhar/.test(s)), "faltou a 2ª linha do recado");
});
t("recreio: ESC volta pra cidade", () => {
  const g = enter(9); assert.strictEqual(g.els.recreio.textContent, "◼ sair");
  g.keydown("Escape"); assert.strictEqual(g.els.recreio.textContent, "▶ recreio");
});
t("recreio: clicar ◼ de novo sai do jogo", () => {
  const g = enter(10); assert.strictEqual(g.els.recreio.textContent, "◼ sair");
  g.click("recreio"); assert.strictEqual(g.els.recreio.textContent, "▶ recreio");
});

// ============================================================================
// TAREFA 1 — BUG DA BEIRADA: o pouso é por SOBREPOSIÇÃO DA CAIXA DOS PÉS (largura
// real do corpo) e, no pouso AÉREO, ganha PERDÃO DE BEIRADA (LEDGE=2 de mundo) +
// snap gentil pra borda. Prova pura via window.__rc.land(px,prevFeet,feet,ledge):
// pousar com só a pontinha do pé na borda -> POUSA; totalmente fora -> CAI.
// ANDANDO (ledge=0) segue estrito (senão flutuaria além da beirada).
// ============================================================================
t("recreio: BEIRADA — pousar com a pontinha do pé na borda POUSA (perdão de beirada)", () => {
  const g = enter(31); const RC = g.hook(); const st = g.state();
  st.plats = [{ x: 50, w: 30, top: 36, thin: false }]; st.blocks = []; st.obst = []; st.movers = [];
  const toe = RC.land(47.5, 35, 37, 2);   // pé = px+PW/2 = 50 = EXATAMENTE a borda esquerda
  assert.ok(toe && toe.top === 36, "a pontinha do pé na borda devia pousar (antes caía injustamente)");
  const off = RC.land(43, 35, 37, 2);     // caixa dos pés 4.5 de mundo aquém do telhado
  assert.ok(off == null, "totalmente fora do telhado devia CAIR");
});
t("recreio: BEIRADA — andando (sem perdão) NÃO flutua além da caixa dos pés", () => {
  const g = enter(32); const RC = g.hook(); const st = g.state();
  st.plats = [{ x: 50, w: 30, top: 36, thin: false }]; st.blocks = []; st.obst = []; st.movers = [];
  assert.ok(RC.land(47.5, 35, 37, 0) == null, "andando, a pontinha na borda NÃO segura (senão flutuaria)");
  assert.ok(RC.land(48, 35, 37, 0), "andando, com a caixa dos pés sobre o telhado, pousa");
});

// ============================================================================
// TAREFA 2 — MAIS DESAFIOS (perder = reset suave, igual à queda). Cenários
// DETERMINÍSTICOS montados via window.__rc.state() (limpa os arrays e posiciona a
// jogadora/entidade), depois DIRIGE o jogo e lê o estado/os recados.
// ============================================================================
function rcScene(seed) { const g = enter(seed); for (let i = 0; i < 8; i++) g.frame(16); return g; } // aquece p/ 'live'
function rcBlank(st) {   // um telhado largo, arrays vazios, jogadora no berço
  st.plats = [{ x: 0, w: 60, top: 40, thin: false }]; st.blocks = []; st.obst = []; st.bugs = [];
  st.drones = []; st.movers = []; st.toks = []; st.fx = []; st.frontierX = 300; st.camX = 0;
  st.flags = []; st.items = []; st.cp = null; st.shield = false; st.iframes = 0; st.squashT = 0; st.glitchT = 0;
  st.px = 12; st.py = 40; st.vx = 0; st.vy = 0; st.onGround = true; st.onMover = null;
  st.dead = false; st.deadMsg = ""; st.score = 0; return st;
}

t("recreio: DIFICULDADE cresce com a distância (determinístico pela seed)", () => {
  const spec = enter(33).hook().spec;
  const band = (seedn, a, b) => { let o = { bug: 0, mover: 0, drone: 0, wide: 0, n: 0 };
    for (let bi = a; bi < b; bi++) { const s = spec(seedn, bi); o.n++;
      if (s.bug) o.bug++; if (s.mover) o.mover++; if (s.drone) o.drone++; if (s.wide) o.wide++; } return o; };
  // ESTRUTURAL (qualquer seed): os ~10 primeiros telhados são suaves — 0 móveis (di<8), 0 drones (di<10).
  for (let seed = 1; seed <= 30; seed++) { const e = band(seed, 40, 48);
    assert.strictEqual(e.mover, 0, "telhado inicial não deveria ter plataforma móvel (seed=" + seed + ")");
    assert.strictEqual(e.drone, 0, "telhado inicial não deveria ter drone (seed=" + seed + ")"); }
  // AGREGADO: a faixa distante tem MAIS de tudo (vãos largos, móveis, bugs, drones).
  let E = { bug: 0, mover: 0, drone: 0, wide: 0, n: 0 }, L = { bug: 0, mover: 0, drone: 0, wide: 0, n: 0 };
  for (let seed = 1; seed <= 40; seed++) { const e = band(seed, 40, 48), l = band(seed, 70, 90);
    for (const k in E) { E[k] += e[k]; L[k] += l[k]; } }
  assert.ok(L.drone > 0, "faixa distante devia ter drones (L.drone=" + L.drone + ")");
  assert.ok(L.mover > 0, "faixa distante devia ter plataformas móveis (L.mover=" + L.mover + ")");
  assert.ok(L.wide / L.n > E.wide / E.n + 0.15, "vãos largos deviam crescer (" + (E.wide / E.n).toFixed(2) + " -> " + (L.wide / L.n).toFixed(2) + ")");
  assert.ok(L.bug / L.n > E.bug / E.n, "bugs deviam ficar mais frequentes com a distância");
});

t("recreio: PLATAFORMA MÓVEL carrega a jogadora (posição acompanha)", () => {
  const g = rcScene(34); const st = g.state(); rcBlank(st);
  st.plats = [{ x: -10, w: 8, top: 40, thin: false }];             // telhado só à esquerda; o resto é vão
  st.movers = [{ kind: "h", x: 10, y: 40, w: 8, dx: 0, dy: 0, a: 6, b: 60, dir: 1, spd: 0.8 }];
  st.px = 14; st.py = 40; st.onGround = true; st.onMover = st.movers[0];  // em cima da plataforma
  const x0 = st.px;
  for (let i = 0; i < 8; i++) g.frame(16);
  const dPlayer = st.px - x0, dMover = st.movers[0].x - 10;
  assert.ok(dPlayer > 3, "a jogadora não foi carregada (Δ=" + dPlayer.toFixed(2) + ")");
  assert.ok(Math.abs(dPlayer - dMover) < 0.5, "não acompanhou a plataforma (jog Δ=" + dPlayer.toFixed(2) + " plat Δ=" + dMover.toFixed(2) + ")");
  assert.ok(!st.dead, "não deveria morrer em cima da plataforma");
});

t("recreio: BUG machuca no toque de LADO (perde, igual cair)", () => {
  const g = rcScene(35); const st = g.state(); rcBlank(st);
  st.bugs = [{ x0: 16, x1: 44, x: 22, dir: 1, top: 40, dead: false }];
  g.keydown("ArrowRight");
  let died = false;
  for (let i = 0; i < 40 && !died; i++) { g.frame(16); if (st.dead) died = true; }
  assert.ok(died, "encostar de lado no bug não puniu");
  assert.ok(g.texts().some((s) => /o bug te pegou/.test(s)), "faltou o recado do bug");
});
t("recreio: BUG continua STOMPÁVEL por cima (+token, não mata)", () => {
  const g = rcScene(36); const st = g.state(); rcBlank(st);
  st.bugs = [{ x0: 14, x1: 26, x: 20, dir: 0, top: 40, dead: false }];
  st.px = 20; st.py = 28; st.vy = 1.0; st.onGround = false;         // logo acima do bug, caindo reto
  const s0 = st.score;
  for (let i = 0; i < 12; i++) g.frame(16);
  assert.ok(st.bugs[0].dead, "não pisou no bug");
  assert.ok(st.score > s0, "stomp não deu +token (s0=" + s0 + " -> " + st.score + ")");
  assert.ok(!st.dead, "stomp não deveria matar a jogadora");
});

t("recreio: DRONE mata ao toque e NÃO é stompável (perigo aéreo)", () => {
  const g = rcScene(37); const st = g.state(); rcBlank(st);
  st.drones = [{ x0: 18, x1: 22, x: 20, dir: 0, baseY: 30, y: 30, amp: 0, ph: 0, spd: 0 }];
  st.px = 20; st.py = 34; st.vy = 1.0; st.onGround = false;         // CAINDO sobre o drone
  let died = false;
  for (let i = 0; i < 10 && !died; i++) { g.frame(16); if (st.dead) died = true; }
  assert.ok(died, "cair sobre o drone deveria matar (não é stompável)");
  assert.ok(g.texts().some((s) => /drone te pegou/.test(s)), "faltou o recado do drone");
});

t("recreio: OBSTÁCULO bloqueia de lado mas NÃO mata (e dá pra pular por cima)", () => {
  const g = rcScene(38); const st = g.state(); rcBlank(st);
  st.obst = [{ x: 30, w: 3, y: 35, h: 5, kind: "duct" }];
  g.keydown("ArrowRight");
  for (let i = 0; i < 40; i++) g.frame(16);
  assert.ok(!st.dead, "tropeçar no obstáculo NÃO deveria matar");
  assert.ok(st.px < 30 && st.px > 24, "obstáculo não bloqueou de lado (px=" + st.px.toFixed(2) + ", esperado ~27.5)");
  g.keydown(" ");                                                    // pula por cima e segue
  for (let i = 0; i < 26; i++) g.frame(16);
  assert.ok(st.px > 33 && !st.dead, "não passou POR CIMA do obstáculo (px=" + st.px.toFixed(2) + ", dead=" + st.dead + ")");
});

// ============================================================================
// ESTADO 'decision' (FIX: "precisa da sua decisão") — quando o Claude Code pede
// autorização (permissão de ferramenta / AskUserQuestion), o main manda
// state:'decision'. O LED vira âmbar "sua decisão"; se estiver jogando, PAUSA NA
// HORA com painel âmbar próprio (não o "terminou"); voltar a live despausa.
// payload.live continua aceito sozinho (compat) — coberto pelos testes acima.
// ============================================================================
const DECIDE = { total: 3000000, residents: 0, cost: 0, live: false, state: "decision", seasonId: 0, daysLeft: 17 };

t("decision: LED/texto do topo vira 'sua decisão' (e volta)", () => {
  const g = loadGame({ real: true, seed: 21 });
  g.emit(DECIDE); warm(g);
  assert.strictEqual(g.els.liveTxt.textContent, "sua decisão");
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, state: "live", seasonId: 0, daysLeft: 17 }); warm(g);
  assert.strictEqual(g.els.liveTxt.textContent, "ao vivo");
  g.emit({ total: 3000000, residents: 0, cost: 0, live: false, state: "idle", seasonId: 0, daysLeft: 17 }); warm(g);
  assert.strictEqual(g.els.liveTxt.textContent, "ocioso");
});
t("decision: jogando -> PAUSA NA HORA com painel âmbar próprio", () => {
  const g = enter(22); for (let i = 0; i < 3; i++) g.frame(16);
  g.emit(DECIDE);                                        // decisão pendente chega via IPC
  const ys = []; for (let i = 0; i < 5; i++) { g.frame(16); ys.push(g.playerY()); }
  assert.ok(ys.every((y) => y === ys[0]), "jogadora não congelou na decisão: " + ys.join(","));
  assert.ok(g.texts().some((s) => /precisa da sua decisão/.test(s)), "faltou o recado da decisão");
  assert.ok(g.texts().some((s) => /o agente está te esperando/.test(s)), "faltou a 2ª linha do recado");
  assert.ok(!g.texts().some((s) => /o agente terminou/.test(s)), "mostrou o painel de 'terminou' na decisão");
});
t("decision: voltar a live DESPAUSA (a jogadora volta a se mexer)", () => {
  const g = enter(23); for (let i = 0; i < 3; i++) g.frame(16);
  g.emit(DECIDE); g.frame(16);
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, state: "live", seasonId: 0, daysLeft: 17 });
  g.keydown(" ");                                         // pulo pra provar que voltou a física
  g.frame(16); const y0 = g.playerY(); g.frame(16); const y1 = g.playerY();
  assert.ok(y1 < y0, "não despausou ao voltar a live: " + y0 + "->" + y1);
  assert.ok(!g.texts().some((s) => /precisa da sua decisão/.test(s)), "painel de decisão não sumiu");
});
t("decision: NÃO entra no recreio esperando decisão (botão não vira sair)", () => {
  const g = loadGame({ real: true, seed: 24 });
  g.emit(DECIDE); g.frame(16);
  g.click("recreio");
  assert.notStrictEqual(g.els.recreio.textContent, "◼ sair");
});

// ============================================================================
// SEAM: virada de temporada DURANTE o recreio aberto. A despedida (fade) e o
// initSeason vivem só em draw(), que NÃO roda no modo recreio (drawRecreio é
// separado). Sem tratamento, a temporada fica PRESA — o HUD mostra o número da
// temporada VELHA com o daysLeft NOVO ("temporada 0 · faltam 28d") e a troca só
// acontece quando a pessoa sai do recreio na mão. A virada tem de sair do
// recreio e rodar a despedida sozinha (a cidade inteira está sendo trocada).
// ============================================================================
t("recreio×temporada: virada DURANTE o recreio troca a temporada (não fica presa)", () => {
  const g = enter(41);                                   // ao vivo, temporada 0, dentro do recreio
  for (let i = 0; i < 4; i++) g.frame(16);
  assert.strictEqual(g.els.recreio.textContent, "◼ sair", "não estava no recreio pra começar");
  // a temporada vira (o main manda seasonId novo + contadores zerados)
  g.emit({ total: 0, residents: 0, cost: 0, live: true, state: "live", seasonId: 1, daysLeft: 28 });
  let flipped = false;
  for (let i = 0; i < 90 && !flipped; i++) { g.frame(70); if (/^temporada 1 · /.test(g.els.season.textContent)) flipped = true; }
  assert.ok(flipped, "temporada ficou presa em '" + g.els.season.textContent + "' — a despedida não roda dentro do recreio");
  assert.strictEqual(g.els.recreio.textContent, "▶ recreio", "não saiu do recreio na virada de temporada");
});

// ============================================================================
// ZOOM 2x + SPRITE 10x16 (FIX: "o personagem é um borrão") — o mundo do recreio
// é desenhado com câmera 2x (berço 64 de mundo = 128px na tela) e a bonequinha
// tem 10x16 px EFETIVOS com contorno escuro de 1px (leitura estilo NES).
// ============================================================================
t("zoom: o telhado-berço é desenhado em 2x (largura de mundo * RZ; altura RBASE-topo)", () => {
  const g = enter(25); g.frame(16);
  const p0 = g.state().plats[0];                          // berço P0: topo 40 FIXO, largura SORTEADA pelo runSeed
  const hit = g.rects().some((r) => r.x === 0 && r.y === p0.top * 2 && r.w === p0.w * 2 && r.h === (60 - p0.top) * 2); // WR(0,top,w,RBASE-top)
  assert.ok(hit, "berço P0 não apareceu como coluna " + (p0.w * 2) + "x" + ((60 - p0.top) * 2) + " na tela (x0,y" + (p0.top * 2) + ")");
});
t("sprite: bonequinha tem ~10x16 px efetivos com CONTORNO escuro", () => {
  const g = enter(26); g.frame(16);
  const shirt = g.pixels("#f2a63c");
  assert.ok(shirt.length >= 10, "camisa âmbar sumiu (px=" + shirt.length + ")");
  const out = g.pixels("#1a1420");                        // contorno K
  assert.ok(out.length >= 24, "contorno de 1px insuficiente (px=" + out.length + ")");
  const xs = out.map((r) => r.x), ys = out.map((r) => r.y);
  const wSpan = Math.max(...xs) - Math.min(...xs) + 1, hSpan = Math.max(...ys) - Math.min(...ys) + 1;
  assert.ok(wSpan >= 8 && wSpan <= 12, "largura efetiva fora de ~10 (w=" + wSpan + ")");
  assert.ok(hSpan >= 14 && hSpan <= 18, "altura efetiva fora de ~16 (h=" + hSpan + ")");
  // cabelo, pele (rosto), calça e sapato presentes = bonequinha legível, não um borrão
  assert.ok(g.pixels("#5a3a2e").length >= 6, "sem cabelo");
  assert.ok(g.pixels("#f0c39a").length >= 6, "sem rosto/pele");
  assert.ok(g.pixels("#4a5a8a").length >= 4, "sem calça");
  assert.ok(g.pixels("#3a2a26").length >= 2, "sem sapatinhos");
});
t("sprite: pulo recolhe as pernas (sapatos sobem em relação aos pés)", () => {
  const g = enter(27); g.frame(16);
  const shoeFloor = Math.max(...g.pixels("#3a2a26").map((r) => r.y)); // no chão: sapato na linha 15
  g.keydown(" "); g.frame(16); g.frame(16);
  const shirtMax = Math.max(...g.pixels("#f2a63c").map((r) => r.y));
  const shoeAir = Math.max(...g.pixels("#3a2a26").map((r) => r.y));
  // no ar o sapato fica logo abaixo da camisa (pernas recolhidas), não 5 linhas abaixo
  assert.ok(shoeAir - shirtMax <= 3, "pernas não recolheram no pulo (sapato-camisa=" + (shoeAir - shirtMax) + ")");
  assert.ok(shoeFloor > 0, "sapato não apareceu no chão");
});
t("sprite: andar alterna frames de passada (pernas mudam de pose)", () => {
  const g = enter(28);
  g.keydown("ArrowRight");
  const poses = new Set();
  for (let i = 0; i < 24; i++) { g.frame(16);
    const legs = g.pixels("#4a5a8a").map((r) => r.x + ":" + r.y).sort().join(",");
    const feet = g.playerY();
    poses.add(legs.split(",").length + "|" + g.pixels("#3a2a26").length); // assinatura da pose
    if (feet == null) break;
  }
  assert.ok(poses.size >= 2, "pernas não alternaram pose ao andar (poses=" + poses.size + ")");
});

// ============================================================================
// VIDA NA CIDADE — RELÓGIO REAL: o céu segue a HORA LOCAL (relógio INJETADO nos testes,
// via window.__env.setClock). meio-dia = céu claro; 2h/3h = noite; e "a cidade dorme com
// você": as janelas apagam aos poucos e de madrugada sobram só as corujas (~8%).
// ============================================================================
t("relógio: meio-dia = céu claro, 2h = noite cheia (hora injetada)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.setClock(() => new Date(2026, 6, 1, 12, 0, 0)); g.frame(16);
  const day = g.topSky(); assert.ok(day && day[0] + day[1] + day[2] > 430, "meio-dia não ficou claro: " + day);
  g.setClock(() => new Date(2026, 6, 1, 2, 0, 0)); g.frame(16);
  const night = g.topSky(); assert.ok(night && night[0] + night[1] + night[2] < 130, "2h não ficou noite cheia: " + night);
});
t("relógio: a curva do céu é CONTÍNUA (amanhecer/entardecer sem degrau)", () => {
  const E = loadGame({ real: true }).env();
  let prev = E.nightAtHour(0), maxStep = 0;
  for (let h = 0.05; h <= 24.0001; h += 0.05) { const v = E.nightAtHour(h); maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; }
  assert.ok(maxStep < 0.05, "a curva do céu deu um degrau (maxStep=" + maxStep.toFixed(3) + ")");
  assert.strictEqual(E.nightAtHour(12), 0, "meio-dia devia ser dia pleno (n=0)");
  assert.strictEqual(E.nightAtHour(3), 1, "3h devia ser noite plena (n=1)");
});
t("janelas: a cidade dorme com você (dia 0, 21h maioria, 23h30 apagando, 3h só corujas)", () => {
  const E = loadGame({ real: true }).env();
  assert.strictEqual(E.litFraction(12), 0, "de dia as janelas deviam estar TODAS apagadas");
  assert.ok(E.litFraction(21) > 0.9, "19-23h a maioria devia estar acesa (" + E.litFraction(21).toFixed(2) + ")");
  const a21 = E.litFraction(21), a2330 = E.litFraction(23.5);
  assert.ok(a2330 < a21, "23h30 devia ter MENOS janelas acesas que 21h (apagando aos poucos)");
  assert.ok(a2330 > 0.5, "23h30 ainda é maioria acesa (" + a2330.toFixed(2) + ")");
  const owls = E.litFraction(3);
  assert.ok(owls > 0.04 && owls < 0.14, "de madrugada devia sobrar só ~8% (corujas): " + owls.toFixed(3));
});

// ---- FOGOS agora seguem a NOITE REAL (marco pop >= 120k): hora injetada ----
t("fogos: pop >= 120k dispara 2-3 rajadas VISÍVEIS ao entrar a noite", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 50000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 });
  g.setClock(() => new Date(2026, 6, 1, 21, 0, 0));   // noite (n=1): "entra a noite" já no 1º frame
  let bursts = 0, prev = 0, maxParticles = 0;
  for (let i = 0; i < 320; i++) { g.frame(70); const c = g.fw(); maxParticles = Math.max(maxParticles, c);
    if (prev === 0 && c > 0) bursts++; prev = c; }
  assert.ok(bursts >= 2, "esperava 2-3 rajadas na noite, vi " + bursts);
  assert.ok(maxParticles >= 6, "as rajadas estão fracas demais (max " + maxParticles + " partículas)");
});
t("fogos: NÃO aparecem quando o marco está travado (pop baixa)", () => {
  const g = loadGame({ real: true });
  g.emit({ total: 300000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 }); // pop << 120k
  g.setClock(() => new Date(2026, 6, 1, 21, 0, 0));
  let any = 0; for (let i = 0; i < 320; i++) { g.frame(70); any += g.fw(); }
  assert.strictEqual(any, 0, "fogos apareceram com o marco travado (any=" + any + ")");
});

// ============================================================================
// CLIMA determinístico por janela de tempo real + HABITANTES pooled com CAP.
// chuva ~25% das janelas de 2h (molha a cena) · neve só em dezembro · varal recolhe na
// chuva · pedestres/gatos/flocos/gotas nunca estouram o cap (o app roda o dia inteiro).
// ============================================================================
const rainStreaks = (g) => g.rects().filter((r) => r.w === 1 && r.h === 3 && r.c === "#a9c4e0").length;
const snowFlakes  = (g) => g.rects().filter((r) => r.w === 1 && r.h === 1 && r.c === "#eaf2fb").length;
const CITY = { total: 3000000, residents: 0, cost: 0, live: true, seasonId: 0, daysLeft: 17 };

t("clima: chuva numa janela conhecida MOLHA a cena (traços diagonais)", () => {
  const g = loadGame({ real: true }); g.emit(CITY);
  const E = g.env();
  let ms = null; const start = Date.UTC(2026, 6, 1, 0, 0, 0);   // varre ~27 dias de 2 em 2 min
  for (let k = 0; k < 20000 && ms === null; k++) { const cand = start + k * 120000; if (E.weatherAt(cand).rain > 0.6) ms = cand; }
  assert.ok(ms !== null, "não achei nenhuma janela de chuva (gatilho determinístico quebrou?)");
  g.setClock(() => new Date(ms)); g.frame(16); g.frame(16);
  assert.ok(rainStreaks(g) > 5, "a chuva não desenhou os traços diagonais (streaks=" + rainStreaks(g) + ")");
});
t("clima: NEVE só em dezembro (data injetada)", () => {
  const g = loadGame({ real: true }); g.emit(CITY);
  g.setClock(() => new Date(2026, 11, 15, 21, 0, 0)); g.frame(16); g.frame(16);   // dezembro (mês 11)
  assert.ok(snowFlakes(g) > 5, "não nevou em dezembro (flocos=" + snowFlakes(g) + ")");
  g.setClock(() => new Date(2026, 6, 15, 21, 0, 0)); g.frame(16); g.frame(16);    // julho: sem neve
  assert.strictEqual(snowFlakes(g), 0, "nevou fora de dezembro");
});
t("clima: VARAL recolhe na chuva (some) e volta no tempo seco", () => {
  // Agora que a orla nasce com as ÚLTIMAS especiais (cidade instantânea no boot), o
  // enquadramento dos prédios normais vizinhos passou a depender da semente da cidade.
  // Em real-mode a store.seed é sorteada no initSeason (roda no emit) — então semeamos o
  // Math.random EM VOLTA do emit p/ fixá-la e o teste ficar DETERMINÍSTICO (asserção estrita).
  const g = loadGame({ real: true });
  const _rnd = Math.random; Math.random = seededRandom(2);
  g.emit(CITY);
  Math.random = _rnd;
  const E = g.env();
  let dry = null, wet = null; const start = Date.UTC(2026, 6, 1, 0, 0, 0);
  for (let k = 0; k < 20000 && (dry === null || wet === null); k++) { const cand = start + k * 120000, r = E.weatherAt(cand).rain;
    if (dry === null && r === 0) dry = cand; if (wet === null && r > 0.6) wet = cand; }
  assert.ok(dry !== null && wet !== null, "faltou achar janela seca/chuvosa");
  g.setClock(() => new Date(dry)); for (let i = 0; i < 6; i++) g.frame(16);
  assert.ok(g.env().counts().varais > 0, "o varal não apareceu no tempo seco");
  g.setClock(() => new Date(wet)); for (let i = 0; i < 6; i++) g.frame(16);
  assert.strictEqual(g.env().counts().varais, 0, "o varal não sumiu na chuva (deviam recolher!)");
});
t("habitantes: pedestres/gatos/flocos/gotas respeitam o CAP (arrays não estouram)", () => {
  const g = loadGame({ real: true }); g.emit(CITY);
  g.setClock(() => new Date(2026, 11, 15, 14, 0, 0));   // dezembro 14h: orla movimentada + neve
  const worst = { pedestres: 0, gatos: 0, flocos: 0, gotas: 0 };
  for (let i = 0; i < 500; i++) { g.frame(50); const c = g.env().counts();
    for (const k in worst) worst[k] = Math.max(worst[k], c[k]); }
  assert.ok(worst.pedestres <= 12, "pedestres além do cap: " + worst.pedestres);
  assert.ok(worst.gatos <= 3, "gatos além do cap: " + worst.gatos);
  assert.ok(worst.flocos <= 48, "flocos de neve além do cap: " + worst.flocos);
  assert.ok(worst.gotas <= 64, "gotas de chuva além do cap: " + worst.gotas);
  assert.ok(worst.pedestres >= 1, "de dia a orla devia ter pedestres");
});

// ============================================================================
// LEVA NOVA — CHECKPOINTS, ESCUDO DE CACHE, JANELAS COM PERSONALIDADE, PESO.
// ============================================================================

// ---- CHECKPOINTS (bandeirinhas): morrer volta pra ÚLTIMA bandeira, mantendo os tokens ----
t("checkpoint: morrer volta pra ÚLTIMA bandeira e MANTÉM os tokens", () => {
  const g = rcScene(60); const RC = g.hook(); const st = g.state(); rcBlank(st);
  const s = RC.spec(st.runSeed, 50);
  st.cp = { bi: 50, platX: 400, top: s.top };   // bandeira já alcançada lá atrás (topo REAL da spec)
  st.score = 7; st.py = 999;                     // cai na água -> morre
  let respawned = false, sawMsg = false;
  for (let i = 0; i < 140 && !respawned; i++) { g.frame(16);
    if (st.dead && g.texts().some((x) => /voltando pra bandeira · tokens mantidos/.test(x))) sawMsg = true;
    if (!st.dead && st.px > 300) respawned = true; }
  assert.ok(sawMsg, "painel de morte não avisou 'voltando pra bandeira · tokens mantidos'");
  assert.ok(respawned, "não ressurgiu no checkpoint (px=" + st.px.toFixed(1) + ", dead=" + st.dead + ")");
  assert.strictEqual(st.score, 7, "perdeu os tokens ao voltar pra bandeira (score=" + st.score + ")");
  assert.ok(Math.abs(st.px - 406) < 30, "não ressurgiu perto da bandeira (px=" + st.px.toFixed(1) + ")");
});
t("checkpoint: bandeiras são determinísticas pela seed (~a cada 15 telhados)", () => {
  const spec = enter(59).hook().spec;
  for (let seed = 1; seed <= 8; seed++) {
    let flags = 0, first = -1;
    for (let bi = 40; bi < 40 + 90; bi++) { const s = spec(seed, bi);
      assert.strictEqual(s.flag, spec(seed, bi).flag, "flag não é determinística");
      if (s.flag) { flags++; if (first < 0) first = bi - 40; } }
    assert.ok(flags >= 4 && flags <= 8, "densidade de bandeiras fora de ~1/15 (seed=" + seed + " flags=" + flags + ")");
    assert.ok(first >= 15, "primeira bandeira cedo demais (di=" + first + ")");
  }
});
// ZONA SEGURA: onde tem bandeira o bug/drone é PROIBIDO — no telhado da bandeira (a jogadora
// RENASCE ali) e no imediatamente seguinte (o 1º passo do respawn). Senão reaparece em cima de
// um inimigo e morre na hora. Determinístico pela seed; prova varrendo muitas seeds/telhados.
t("bandeira = ZONA SEGURA: o telhado da bandeira e o SEGUINTE não têm bug nem drone", () => {
  const spec = enter(71).hook().spec;
  let flagRoofs = 0, sawBugSomewhere = false, sawDroneSomewhere = false;
  for (let seed = 1; seed <= 30; seed++) for (let bi = 40; bi < 40 + 130; bi++) {
    const s = spec(seed, bi);
    if (s.bug) sawBugSomewhere = true;                       // (controle: perigos ainda existem fora da zona)
    if (s.drone) sawDroneSomewhere = true;
    if (!s.flag) continue;
    flagRoofs++;
    assert.ok(!s.bug, "telhado da BANDEIRA tem bug (renasceria em cima do inimigo) seed=" + seed + " bi=" + bi);
    assert.strictEqual(s.drone, null, "telhado da BANDEIRA tem drone seed=" + seed + " bi=" + bi);
    const n = spec(seed, bi + 1);                            // telhado do 1º passo do respawn
    assert.ok(!n.bug, "telhado LOGO APÓS a bandeira tem bug (1º passo perigoso) seed=" + seed + " bi=" + (bi + 1));
    assert.strictEqual(n.drone, null, "telhado LOGO APÓS a bandeira tem drone seed=" + seed + " bi=" + (bi + 1));
  }
  assert.ok(flagRoofs > 20, "poucas bandeiras amostradas p/ a prova (flagRoofs=" + flagRoofs + ")");
  assert.ok(sawBugSomewhere && sawDroneSomewhere, "a supressão zerou TODOS os perigos (não era pra isso)");
});

// ============================================================================
// CLEARABILITY — "todo pulo alcançável COM MARGEM, não frame-perfect" (ethos da Mel:
// desafio sim, frustração não). SIMULA a física REAL do recreio (o mesmo loop de
// rcUpdate roda no motor: vx com ACC/atrito/MAXRUN, vy com GRAV/JUMP/JUMPCUT, coyote/
// buffer) e, pra CADA transição de telhado GERADA (muitas seeds × muitos telhados),
// verifica se a jogadora consegue SAIR de um telhado e POUSAR no próximo com uma jogada
// IMPERFEITA (não input perfeito): ~85% da velocidade (ainda acelerando), pulo SEGURADO
// moderado (~5 quadros, longe do full-hold) e disparado ~2 de mundo ANTES da beirada
// (timing não-frame-perfect). Uma transição que só passa com velocidade cheia + pulo
// 100% segurado é marcada como FALHA. O BUG original era subida-alta + vão-largo ficar
// no limite da parábola; o conserto encolhe o vão em função da subida (rcRiseCap).
// ============================================================================
const RC_MAXRUN = 1.4;   // = MAXRUN do game.js (a física roda no MOTOR real; isto é só o teto de velocidade da jogadora imperfeita)
// entra no recreio com runSeed FIXO (fase determinística) e aquece pra 'live'.
function rcRun(seed) { const g = loadGame({ real: true }); g.emit(LIVE); g.frame(16);
  g.hook().setRunSeed(seed); g.click("recreio"); for (let i = 0; i < 6; i++) g.frame(16); return g; }
// Simula UM pulo isolado no motor real: mundo de 2 telhados, jogadora imperfeita (85% + hold
// moderado + disparo 2 antes da beirada). Devolve true se POUSA no telhado de destino.
function rcCanClear(g, top0, w0, gap, top1) {
  const st = g.state();
  g.keyup("ArrowRight"); g.keyup("ArrowLeft"); g.keyup(" ");            // zera input vazado entre simulações
  st.jumpHeld = false; st.buffer = 0; st.coyote = 0;
  st.plats = [{ x: 0, w: w0, top: top0, thin: false }, { x: w0 + gap, w: 60, top: top1, thin: false }]; // destino largo: testa ALCANÇAR, não frear
  st.blocks = []; st.obst = []; st.bugs = []; st.drones = []; st.movers = []; st.toks = []; st.fx = [];
  st.flags = []; st.items = []; st.cp = null; st.shield = false; st.iframes = 0; st.squashT = 0; st.glitchT = 0;
  st.frontierX = 99999; st.camX = 0; st.bi = 99990;                     // trava a geração (não nasce telhado novo perto)
  st.px = 0.5; st.py = top0; st.vx = 0; st.vy = 0; st.onGround = true; st.onMover = null;
  st.dead = false; st.deadMsg = ""; st.score = 0; st.introT = 99999;
  g.keydown("ArrowRight");
  let jumped = false, held = 0, released = false;
  for (let f = 0; f < 140; f++) {
    if (st.vx > RC_MAXRUN * 0.85) st.vx = RC_MAXRUN * 0.85;             // jogadora ainda acelerando / abaixo do pico
    if (st.dead) { g.keyup("ArrowRight"); return false; }              // caiu no vão
    if (jumped && Math.abs(st.py - top1) < 0.6 && st.px > w0 + gap - 0.5) { g.keyup("ArrowRight"); return true; } // pousou no destino
    if (st.onGround && !jumped && st.px + 2.5 >= w0 - 2) { g.keydown(" "); jumped = true; held = 0; } // pula ~2 de mundo ANTES da beirada
    if (jumped && !released) { held++; if (held >= 5) { g.keyup(" "); released = true; } }          // segura só ~5 quadros (NÃO full-hold)
    g.frame(16);
  }
  g.keyup("ArrowRight"); return false;
}
// enumera a sequência de telhados de UMA partida: intro (P0,P1,P2 lidos do estado real),
// a EMENDA P2->1º gerado (adjacente, vão 0) e os telhados gerados via spec (vão que cada
// um contribui leva ao SEGUINTE). Devolve as transições {top0,w0,gap,top1}.
function rcTransitions(g, seed, nGen) {
  const st = g.state(), spec = g.hook().spec;
  const intro = st.plats.filter((p) => !p.thin).sort((a, b) => a.x - b.x).slice(0, 3); // P0,P1,P2
  const roofs = intro.map((p) => ({ top: p.top, w: p.w, gap: 0, x: p.x }));
  for (let i = 0; i < roofs.length - 1; i++) roofs[i].gap = Math.round(intro[i + 1].x - (intro[i].x + intro[i].w));
  roofs[roofs.length - 1].gap = 0;                                     // P2 -> 1º gerado: adjacentes (emenda)
  for (let bi = 40; bi < 40 + nGen; bi++) { const s = spec(seed, bi); roofs.push({ top: s.top, w: s.w, gap: s.gap }); }
  const tr = [];
  for (let i = 0; i < roofs.length - 1; i++) tr.push({ top0: roofs[i].top, w0: roofs[i].w, gap: roofs[i].gap, top1: roofs[i + 1].top });
  return tr;
}

t("clearability: TODA transição de telhado é alcançável COM MARGEM (não frame-perfect)", () => {
  let total = 0, fails = 0; const worst = [];
  for (let seed = 1; seed <= 24; seed++) {
    const g = rcRun(seed);
    const tr = rcTransitions(g, seed, 55);
    for (const t of tr) {
      if (t.gap < 0) continue;
      total++;
      if (!rcCanClear(g, t.top0, t.w0, t.gap, t.top1)) {
        fails++; const up = t.top0 - t.top1;
        if (worst.length < 10) worst.push("seed" + seed + " sobe" + up + " vão" + t.gap + " (" + t.top0 + "->" + t.top1 + " w" + t.w0 + ")");
      }
    }
  }
  assert.ok(total > 1000, "amostra pequena demais p/ a prova (total=" + total + ")");
  assert.strictEqual(fails, 0, "há transições INJUSTAS (só passam com input perfeito): " + fails + "/" + total + " — ex.: " + worst.join(" | "));
});

// GATE NÃO-OCO: o harness tem de REPROVAR pulos injustos (senão o teste acima é vazio).
// Reproduz o BUG antigo (subida alta + vão largo) e confirma que os justos passam.
t("clearability: o harness NÃO é oco — reprova o pulo injusto do bug antigo, aprova os justos", () => {
  const g = rcRun(1);
  assert.ok(rcCanClear(g, 40, 30, 17, 40), "plano com vão 17 (máx) devia PASSAR");
  assert.ok(rcCanClear(g, 32, 30, 17, 41), "descida de 9 com vão 17 devia PASSAR (descer é fácil)");
  assert.ok(rcCanClear(g, 41, 30, 11, 32), "subida de 9 com vão já clampado (11) devia PASSAR");
  assert.ok(!rcCanClear(g, 41, 30, 17, 32), "subida de 9 + vão 17 (bug antigo) TINHA de falhar no harness");
  assert.ok(!rcCanClear(g, 41, 30, 16, 33), "subida de 8 + vão 16 (bug antigo) TINHA de falhar no harness");
});

// A GERAÇÃO em si nunca solta a combinação perigosa (clamp ativo, não código morto).
// Guarda FROUXA (não fixa a tabela exata do rcRiseCap): subida grande => vão nunca largo.
t("clearability: a geração NUNCA solta subida-grande com vão-largo (clamp ativo, determinístico)", () => {
  const spec = enter(2).hook().spec;
  let ups = 0, tallUps = 0;
  for (let seed = 1; seed <= 40; seed++) for (let bi = 40; bi < 40 + 130; bi++) {
    const a = spec(seed, bi), b = spec(seed, bi + 1);
    const rise = a.top - b.top;                                        // >0 => bi+1 é mais alto (subida)
    assert.strictEqual(a.gap, spec(seed, bi).gap, "gap não é determinístico (seed=" + seed + " bi=" + bi + ")");
    if (rise > 0) { ups++;
      if (rise >= 7) { tallUps++; assert.ok(a.gap <= 14, "subida " + rise + " saiu com vão largo " + a.gap + " (clamp inativo? seed=" + seed + " bi=" + bi + ")"); } }
  }
  assert.ok(ups > 800, "poucas subidas amostradas (ups=" + ups + ")");
  assert.ok(tallUps > 20, "poucas subidas GRANDES amostradas p/ provar o clamp (tallUps=" + tallUps + ")");
});

// ============================================================================
// MAPA ALEATÓRIO POR PARTIDA (runSeed) — cada ENTRADA no recreio = fase nova;
// DENTRO da partida (respawn no checkpoint / restart pós-queda) = MESMO trecho.
// A cidade calma segue determinística pela temporada (store.seed), não regride.
// ============================================================================
// assinatura do LAYOUT gerado a partir de um runSeed (sequência de vãos/alturas/desafios).
function rcLayoutSig(spec, seed) { let a = [];
  for (let bi = 40; bi < 90; bi++) { const s = spec(seed, bi);
    a.push(s.gap + ":" + s.top + ":" + s.w + ":" + (s.wide ? 1 : 0) + ":" + (s.bug ? 1 : 0) + ":" + (s.mover ? 1 : 0)); }
  return a.join(","); }

t("recreio: runSeeds DIFERENTES geram layouts DIFERENTES (mapa novo por partida)", () => {
  const spec = enter(101).hook().spec;
  let diffs = 0, pairs = 0;                         // a sequência de vãos/alturas/desafios muda entre runs
  for (let a = 1; a <= 12; a++) {
    const sa = rcLayoutSig(spec, (a * 2654435761) >>> 0);
    const sb = rcLayoutSig(spec, (a * 2654435761 + 0x9e3779b9) >>> 0); pairs++;
    if (sa !== sb) diffs++; }
  assert.strictEqual(diffs, pairs, "runs com seeds diferentes deviam gerar layouts diferentes (" + diffs + "/" + pairs + ")");
});

// ---- ABERTURA SORTEADA: o COMEÇO (berço + 1os telhados + TEMA visual) muda a cada
// partida (antes era hardcoded -> "parecia sempre a mesma fase"). Assinatura dos 6
// PRIMEIROS telhados + itens + tema — o alvo é diferir JÁ no começo, não só lá na frente.
function rcOpeningSig(st) {
  return JSON.stringify({
    plats: st.plats.slice(0, 6).map((p) => [Math.round(p.x), p.w, p.top, p.thin ? 1 : 0]),
    toks:  st.toks.slice(0, 5).map((k) => [Math.round(k.x), Math.round(k.y)]),
    blks:  st.blocks.slice(0, 2).map((b) => [Math.round(b.x), b.y]),
    theme: st.theme ? st.theme.idx : -1 });
}
t("recreio: ABERTURA difere entre runSeeds (tema/alturas/larguras/itens nos 1os 6 telhados)", () => {
  const g = loadGame({ real: true, seed: 301 }); g.emit(LIVE); g.frame(16);
  const RC = g.hook();
  const seeds = [1, 2, 3, 4, 5];                          // residues distintos -> tema idx distinto
  const sigs = new Set(), themes = new Set();
  for (const s of seeds) {
    RC.setRunSeed(s >>> 0); g.click("recreio");           // entra na partida
    const st = g.state();
    sigs.add(rcOpeningSig(st)); themes.add(st.theme.idx);
    g.click("recreio");                                   // sai (toggle)
  }
  assert.ok(sigs.size >= 4, "aberturas quase iguais entre runs (distintas=" + sigs.size + "/5)");
  assert.ok(themes.size >= 3, "tema visual quase sempre igual (distintos=" + themes.size + "/5)");
});
t("recreio: dois runs CONSECUTIVOS diferem já nos 6 primeiros telhados (não só longe)", () => {
  const g = loadGame({ real: true, seed: 302 }); g.emit(LIVE); g.frame(16);
  const RC = g.hook();
  RC.setRunSeed(0xA1A10001); g.click("recreio");
  const A = JSON.parse(rcOpeningSig(g.state())); g.click("recreio");
  RC.setRunSeed(0xB2B20002); g.click("recreio");
  const B = JSON.parse(rcOpeningSig(g.state()));
  const platsDiffer = JSON.stringify(A.plats) !== JSON.stringify(B.plats);
  const toksDiffer  = JSON.stringify(A.toks)  !== JSON.stringify(B.toks);
  assert.ok(platsDiffer || toksDiffer, "os 6 primeiros telhados/itens são IDÊNTICOS entre 2 runs (abertura não sorteada)");
  assert.ok(A.theme !== B.theme || platsDiffer, "nem tema nem telhados mudaram entre 2 runs");
});
t("recreio: reset pós-queda (sem checkpoint) regenera a MESMA abertura (determinismo na partida)", () => {
  const g = loadGame({ real: true, seed: 303 }); g.emit(LIVE); g.frame(16);
  const RC = g.hook(); RC.setRunSeed(0xC0FFEE01); g.click("recreio");
  const st = g.state(); const before = rcOpeningSig(st);
  st.cp = null; st.py = 999;                              // cai sem bandeira -> rcBuild reconstrói a abertura
  let died = false, rebuilt = false;
  for (let i = 0; i < 220 && !rebuilt; i++) { g.frame(16);
    if (st.dead) died = true;
    if (died && !st.dead) rebuilt = true; }               // morreu e o rcBuild() limpou o dead
  assert.ok(rebuilt, "não resetou pro início após cair sem checkpoint (dead=" + st.dead + ")");
  assert.strictEqual(rcOpeningSig(g.state()), before, "a abertura MUDOU no reset (deveria ser idêntica na mesma partida)");
});

t("recreio: ENTRAR sorteia um runSeed FRESCO (injeção reprodutível; não vem da seed da cidade)", () => {
  const g = loadGame({ real: true, seed: 202 }); g.emit(LIVE); g.frame(16);
  const RC = g.hook(), citySeed = g.env().seed();
  RC.setRunSeed(0x11111111); g.click("recreio");                   // entra na partida A
  const seedA = g.state().runSeed, sigA = rcLayoutSig(RC.spec, seedA);
  g.click("recreio");                                              // sai (toggle)
  RC.setRunSeed(0x22222222); g.click("recreio");                   // entra na partida B
  const seedB = g.state().runSeed, sigB = rcLayoutSig(RC.spec, seedB);
  assert.strictEqual(seedA >>> 0, 0x11111111, "runSeed injetado não foi aplicado (A)");
  assert.strictEqual(seedB >>> 0, 0x22222222, "runSeed injetado não foi aplicado (B)");
  assert.notStrictEqual(seedA, seedB, "duas partidas deviam ter runSeeds diferentes");
  assert.notStrictEqual(sigA, sigB, "duas partidas deviam ter layouts diferentes");
  assert.strictEqual(g.env().seed(), citySeed, "a seed da CIDADE mudou ao jogar o recreio (calma deveria ficar intocada)");
});

t("recreio: SEM injeção, entradas repetidas sorteiam runSeeds diferentes (Math.random real)", () => {
  const g = loadGame({ real: true, seed: 203 }); g.emit(LIVE); g.frame(16);
  const seen = new Set();
  for (let i = 0; i < 6; i++) { g.click("recreio"); seen.add(g.state().runSeed >>> 0); g.click("recreio"); }
  assert.ok(seen.size >= 5, "entradas repetidas deviam variar o runSeed (distintos=" + seen.size + "/6)");
});

t("recreio: DENTRO da partida o respawn no checkpoint regenera o MESMO trecho (idêntico)", () => {
  const g = loadGame({ real: true, seed: 204 }); g.emit(LIVE); g.frame(16);
  const RC = g.hook(); RC.setRunSeed(0x0badf00d); g.click("recreio");
  const st = g.state(), seed0 = st.runSeed >>> 0;
  const cpBi = 55, cs = RC.spec(seed0, cpBi);
  const worldSig = (s) => JSON.stringify({
    plats:  s.plats.map((p) => [Math.round(p.x), p.w, p.top, p.thin ? 1 : 0]),
    toks:   s.toks.map((k) => [Math.round(k.x), k.y]),
    blocks: s.blocks.map((b) => [Math.round(b.x), b.y, b.shield ? 1 : 0]),
    bugs:   s.bugs.map((b) => [Math.round(b.x0), Math.round(b.x1)]),
    flags:  s.flags.map((f) => f.bi) });
  const mkCp = () => { st.cp = { bi: cpBi, platX: 900, top: cs.top }; st.py = 999; }; // bandeira lá atrás; cai -> volta
  mkCp(); let ok1 = false;
  for (let i = 0; i < 140 && !ok1; i++) { g.frame(16); if (!st.dead && st.px > 800) ok1 = true; }
  assert.ok(ok1, "não ressurgiu no checkpoint (1a vez, px=" + st.px.toFixed(1) + ")");
  const sig1 = worldSig(st), seed1 = st.runSeed >>> 0;
  mkCp(); let ok2 = false;
  for (let i = 0; i < 140 && !ok2; i++) { g.frame(16); if (!st.dead && st.px > 800) ok2 = true; }
  assert.ok(ok2, "não ressurgiu no checkpoint (2a vez, px=" + st.px.toFixed(1) + ")");
  const sig2 = worldSig(st), seed2 = st.runSeed >>> 0;
  assert.strictEqual(seed1, seed0, "runSeed mudou no 1o respawn (devia ser fixo na partida)");
  assert.strictEqual(seed2, seed0, "runSeed mudou no 2o respawn");
  assert.strictEqual(sig1, sig2, "o trecho do checkpoint não é idêntico ao retentar (respawn não-determinístico)");
});

// ---- ESCUDO DE CACHE (computadorzinho): sai de ~metade dos blocos ?, absorve 1 hit e quebra ----
t("escudo: ~metade dos blocos ? soltam o computadorzinho (frequente, mas nem todo bloco)", () => {
  const spec = enter(63).hook().spec;
  let blocks = 0, shields = 0;
  for (let seed = 1; seed <= 20; seed++) for (let bi = 40; bi < 130; bi++) {
    const s = spec(seed, bi);
    assert.strictEqual(s.shield, spec(seed, bi).shield, "shield não é determinístico");
    if (s.block) { blocks++; if (s.shield) shields++; } }
  assert.ok(shields > 0, "nenhum bloco solta escudo (shields=" + shields + ")");
  assert.ok(shields < blocks, "TODO bloco virou escudo (devia ser frequente, não certo)");
  const frac = shields / blocks;                            // alvo ~50% -> computador de fato pegável numa partida típica
  assert.ok(frac > 0.38 && frac < 0.62, "proporção de escudos fora de ~metade (" + frac.toFixed(2) + ")");
});
t("escudo: bater no bloco ? de escudo SOLTA o computadorzinho e pegá-lo ATIVA o escudo", () => {
  const g = rcScene(64); const st = g.state(); rcBlank(st);
  st.blocks = [{ x: 14, w: 12, y: 20, h: 8, used: false, shield: true }];
  st.px = 20; st.py = 40; st.onGround = true;
  g.keydown(" ");                                     // pula reto -> a cabeça bate embaixo do bloco
  let spawned = false;
  for (let i = 0; i < 16; i++) { g.frame(16); if (st.items.length > 0) spawned = true; }
  assert.ok(spawned, "o bloco de escudo não soltou o computadorzinho");
  assert.ok(st.blocks[0].used, "o bloco de escudo não marcou usado");
  assert.strictEqual(st.score, 0, "bloco de escudo NÃO deveria dar token (dá o computador)");
  const it = st.items[0]; st.px = it.x; st.py = it.y + 4;   // encosta no computadorzinho
  for (let i = 0; i < 6 && !st.shield; i++) g.frame(16);
  assert.ok(st.shield, "pegar o computadorzinho não ativou o escudo");
});
t("escudo: absorve 1 toque de bug e QUEBRA (segue viva); sem escudo, o mesmo toque mata", () => {
  const g = rcScene(61); const st = g.state(); rcBlank(st);
  st.shield = true;
  st.bugs = [{ x0: 16, x1: 44, x: 22, dir: 1, top: 40, dead: false }];
  g.keydown("ArrowRight");
  let broke = false;
  for (let i = 0; i < 40; i++) { g.frame(16); if (!st.shield) broke = true; }
  assert.ok(broke, "o escudo não quebrou ao toque do bug");
  assert.ok(!st.dead, "com escudo, o toque do bug NÃO deveria matar");
  const g2 = rcScene(62); const st2 = g2.state(); rcBlank(st2);      // baseline sem escudo
  st2.bugs = [{ x0: 16, x1: 44, x: 22, dir: 1, top: 40, dead: false }];
  g2.keydown("ArrowRight");
  let died = false;
  for (let i = 0; i < 40 && !died; i++) { g2.frame(16); if (st2.dead) died = true; }
  assert.ok(died, "sem escudo, o toque do bug deveria matar (prova de que foi o escudo que salvou)");
});
// ---- COMPUTADOR DE FATO PEGÁVEL (a Mel: "é possível de fato pegar o computador?") ----
t("escudo: um computador aparece CEDO e num ponto ALCANÇÁVEL na abertura", () => {
  const g = enter(72); const st = g.state();
  const sh = st.blocks.slice(0, 3).find((b) => b.shield);   // logo nos 1os blocos ? da partida (P1 garantido)
  assert.ok(sh, "nenhum bloco de escudo cedo na abertura (o computador não aparece cedo)");
  // ALCANÇÁVEL: o bloco fica 20 de mundo acima de um telhado REAL (item pousa a q.y-4, dentro
  // do ápice do pulo ~13-15). Confere a geometria: existe um telhado 20 abaixo do bloco.
  const plat = st.plats.find((p) => Math.abs((sh.y + 20) - p.top) < 1 && sh.x + 6 >= p.x && sh.x + 6 <= p.x + p.w);
  assert.ok(plat, "o bloco de escudo não está 20 acima de um telhado (não seria alcançável): y=" + sh.y);
});
t("escudo: PULAR de fato PEGA o computador (arco pulável, física real — não só sorte)", () => {
  const g = rcScene(73); const st = g.state(); rcBlank(st);
  // um telhado + bloco ? de escudo idêntico aos gerados (bloco 20 acima do telhado top=40)
  st.plats = [{ x: 0, w: 60, top: 40, thin: false }];
  st.blocks = [{ x: 20, w: 12, y: 20, h: 8, used: false, shield: true }];
  st.px = 26; st.py = 40; st.onGround = true;                // sob o CENTRO do bloco
  g.keydown(" ");                                            // 1º pulo: bate por baixo -> solta o computador
  let spawned = false;
  for (let i = 0; i < 20; i++) { g.frame(16); if (st.items.length > 0) spawned = true; } g.keyup(" ");
  assert.ok(spawned, "o bloco de escudo não soltou o computador");
  for (let i = 0; i < 26; i++) g.frame(16);                  // deixa o item ASSENTAR no arco (restY) e a jogadora pousar
  assert.ok(st.items.length > 0 && !st.shield, "o item sumiu antes de dar pra pegar");
  st.px = st.items[0].x; st.vx = 0;                          // fica sob o item (reachability é VERTICAL, não navegação)
  const itemY = st.items[0].y;
  g.keydown(" ");                                            // 2º pulo reto: no ápice deve PEGAR o computador
  let got = false, apex = st.py, closest = 999;
  for (let i = 0; i < 22 && !got; i++) { g.frame(16); apex = Math.min(apex, st.py);
    if (st.items[0]) closest = Math.min(closest, Math.abs(st.items[0].y - (st.py - 4)));
    if (st.shield) got = true; }
  assert.ok(got, "não deu pra PEGAR o computador pulando reto (itemY=" + itemY.toFixed(1) + " apexPy=" + apex.toFixed(1) + " closestDy=" + closest.toFixed(1) + ")");
});

// ---- PESO (recreio): squash&stretch de 1px + poeirinha no pouso; stretch no pico do pulo ----
t("peso: aterrissar aplica SQUASH (1px mais baixa/larga) e levanta poeirinha", () => {
  const g = rcScene(65); const st = g.state(); rcBlank(st);
  st.px = 20; st.py = 25; st.vy = 1.2; st.onGround = false;   // caindo em direção ao telhado (top=40)
  let landed = false, squashSeen = false, dust = 0;
  for (let i = 0; i < 30 && !landed; i++) { g.frame(16);
    if (st.onGround) { landed = true; squashSeen = st.squashT > 0 && st.sqDW === 1 && st.sqDH === -1; }
    dust += g.rects().filter((r) => r.c === "#9a94a0").length; }
  assert.ok(landed, "não aterrissou no telhado");
  assert.ok(squashSeen, "não aplicou o squash no pouso (squashT=" + st.squashT + " dw=" + st.sqDW + " dh=" + st.sqDH + ")");
  assert.ok(dust > 0, "não levantou poeirinha ao pousar");
  const g2 = rcScene(66); const st2 = g2.state(); rcBlank(st2);      // stretch no pico do pulo
  g2.keydown(" ");
  let stretched = false;
  for (let i = 0; i < 20; i++) { g2.frame(16); if (st2.sqDH === 1 && !st2.onGround) stretched = true; }
  assert.ok(stretched, "não esticou no pico do pulo (stretch de 1px)");
});

// ---- JANELAS COM PERSONALIDADE (modo cidade): biblioteca arqueada, mercado com vitrine, comum varia ----
t("janelas: personalidade por prédio — biblioteca arqueada, mercado com vitrine, comum varia por seed", () => {
  const g = loadGame({ seed: 77 });                 // preview: seed determinística p/ genNormal
  const E = g.env();
  const near = (b, sx) => { g.frame(16); E.drawNormalAt(b, sx, 0.5);   // desenha LONGE (isola os rects)
    return g.rects().filter((r) => r.x >= sx - 1 && r.x <= sx + b.w + 6); };
  let biblio = null, mercado = null, narrow = null, std = null;
  for (let i = 0; i < 1500 && !(biblio && mercado && narrow && std); i++) {
    const b = E.makeNormal(i);
    if (!biblio && b.persona === "biblioteca") biblio = b;
    if (!mercado && b.persona === "mercado") mercado = b;
    if (!narrow && !b.detailed && !b.landmark && b.winShape === "narrow") narrow = b;
    if (!std && !b.detailed && !b.landmark && b.winShape === "std") std = b;
  }
  assert.ok(biblio && mercado && narrow && std,
    "não achei todas as classes (bib=" + !!biblio + " merc=" + !!mercado + " narrow=" + !!narrow + " std=" + !!std + ")");
  assert.strictEqual(biblio.winShape, "arch", "biblioteca não virou janela arqueada");
  assert.ok(near(biblio, 400).some((r) => r.w === 3 && r.h === 3), "biblioteca sem janelas ARQUEADAS (3x3)");
  assert.ok(near(mercado, 400).some((r) => r.w === mercado.w - 4 && r.h === 3), "mercado sem VITRINE larga no térreo");
  assert.ok(near(narrow, 400).some((r) => r.w === 1 && r.h === 3), "prédio estreito sem janelas 1x2");
  assert.ok(near(std, 400).some((r) => r.w === 2 && r.h === 3), "prédio comum sem janelas 2x3");
});

// ---- FASE 3 / A4: SETUP -> CIDADE agora fica LIMPA -------------------------
// Feedback da Mel ("sem nome no app"): as placas de skill (COPY-MEL/…) e as
// estações MCP com letreiro POLUÍAM a cidade e apareciam SEMPRE. O DESENHO saiu:
// a cidade volta a ser só a movida por tokens (como antes do A4). O setup segue
// chegando por IPC (onSetup) e o MAIN o coleta/manda pro SITE via collectSetup —
// só a RENDERIZAÇÃO na cidade saiu. Aqui asseveramos: nenhuma placa/estação na
// cena (nem com setup), e crescimento por tokens IDÊNTICO com ou sem setup. As
// placas/letreiros eram texto de canvas (fillText) -> apareceriam em g.texts().
const bigUsage = { total: 400000, cost: 20, state: "idle" }; // ~66 prédios (6k tok/prédio)
const SETUP_FULL = { v: 1, skills: ["copy-mel", "superpowers", "flow-broll-palmier"],
  mcp: ["palmier-pro"], hooks: [], tools: [], models: [] };
// labels que as placas/estações do A4 desenhariam (abrev do código antigo) — não
// podem mais aparecer na cena. (o dirigível ainda escreve "TOKENTOWN"; nada disso.)
const SETUP_PLAQUES = /COPY-MEL|SUPERPOWE|FLOW-BROL|PALMIER-/;

t("fase3: COM setup a cidade fica LIMPA (nenhuma placa de skill nem estação MCP)", () => {
  const g = loadGame({ real: true, seed: 7 });
  g.emit(bigUsage);
  g.emitSetup(SETUP_FULL);
  g.pump(6);
  const txt = g.texts().join("|");
  assert.ok(!SETUP_PLAQUES.test(txt), "a cidade desenhou placa/estação de setup (deveria estar LIMPA): " + txt);
});

t("fase3: SEM setup, cidade calma IGUAL (nenhuma placa de skill/MCP)", () => {
  const g = loadGame({ real: true, seed: 7 });
  g.emit(bigUsage); g.pump(6);
  assert.ok(!SETUP_PLAQUES.test(g.texts().join("|")), "placas apareceram sem setup");
});

t("fase3: MUITAS skills + vários MCP também NÃO desenham nada (segue limpa)", () => {
  const g = loadGame({ real: true, seed: 3 });
  g.emit(bigUsage);
  g.emitSetup({ v: 1, skills: ["zzskill0", "zzskill1", "zzskill2", "zzskill3", "zzskill4", "zzskill5", "zzskill6", "zzskill7"],
    mcp: ["qqmcp-a", "qqmcp-b"], hooks: [], tools: [], models: [] });
  g.pump(6);
  assert.ok(!/ZZSKILL|QQMC/.test(g.texts().join("|")), "placa/estação apareceu com muitas skills/MCP");
});

t("fase3: setup:null é aceito e a cidade segue limpa (sem crash)", () => {
  const g = loadGame({ real: true, seed: 3 });
  g.emit(bigUsage);
  g.emitSetup({ v: 1, skills: ["x-one"], mcp: ["y-two"], hooks: [], tools: [], models: [] });
  g.emitSetup(null);
  g.pump(6);
  assert.ok(!/X-ONE|Y-TWO/.test(g.texts().join("|")), "placa apareceu (setup deveria ser inócuo no desenho)");
});

t("fase3: reduced-motion — cidade limpa, sem placa e sem crash", () => {
  const g = loadGame({ real: true, seed: 5, reduce: true });
  g.emit(bigUsage);
  g.emitSetup({ v: 1, skills: ["calm-skill"], mcp: [], hooks: [], tools: [], models: [] });
  g.pump(6);
  assert.ok(!/CALM-SKIL/.test(g.texts().join("|")), "placa desenhou sob reduced-motion (deveria estar limpa)");
});

t("fase3: setup NÃO altera o crescimento por tokens (mesmos prédios com/sem setup)", () => {
  const a = loadGame({ real: true, seed: 9 }); a.emit(bigUsage); a.pump(6);
  const b = loadGame({ real: true, seed: 9 }); b.emit(bigUsage);
  b.emitSetup(SETUP_FULL);
  b.pump(6);
  assert.strictEqual(a.els.builds.textContent, b.els.builds.textContent, "nº de prédios mudou com o setup");
});

console.log("\n" + (total - fails) + "/" + total + " passaram" + (fails ? " — " + fails + " FALHARAM" : ""));
process.exit(fails ? 1 : 0);
