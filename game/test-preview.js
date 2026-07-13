// Testes do caminho de PREVIEW do game.js (index.html no navegador, SEM window.tt):
// a cidade simula um fluxo calmo e a temporada é calculada localmente. Confirma que
// a época NOVA (01/07/2026) faz o preview nascer na temporada 0. ZERO deps.
//   node test-preview.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");
const EPOCH = Date.UTC(2026, 6, 1), MS = 28 * 86400000;
const refSeasonId = Math.floor((Date.now() - EPOCH) / MS);
const refDaysLeft = Math.max(0, Math.ceil((EPOCH + (refSeasonId + 1) * MS - Date.now()) / 86400000));

function ctxStub() { return new Proxy({}, { get: (t, p) => (p in t ? t[p] : function () {}), set: (t, p, v) => { t[p] = v; return true; } }); }
function makeEl(id) {
  const t = { id: id, textContent: "", innerHTML: "", hidden: false, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll() { return []; }, addEventListener() {}, getContext() { return ctxStub(); } };
  return new Proxy(t, { get: (o, p) => (p in o ? o[p] : function () {}), set: (o, p, v) => { o[p] = v; return true; } });
}
// index.html (preview) só tem estes ids — season/wish/note NÃO existem lá.
function loadPreview(indexOnly) {
  const full = ["scene", "tok", "builds", "pop", "live", "liveTxt", "cost", "season", "wish", "note"];
  const indexIds = ["scene", "tok", "builds", "pop", "live", "liveTxt", "cost"];
  const ids = indexOnly ? indexIds : full;
  const els = {}; ids.forEach((id) => (els[id] = makeEl(id)));
  let clock = 1000, stored = null;
  const g = global;
  g.matchMedia = () => ({ matches: false });
  g.document = { getElementById: (id) => els[id] || null };
  g.performance = { now: () => clock };
  g.requestAnimationFrame = (cb) => { stored = cb; return 1; };
  const mem = new Map();
  g.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  g.window = {}; // SEM tt -> modo preview simulado
  vm.runInThisContext(SRC, { filename: "game.js" });
  return { els, pump(n) { for (let i = 0; i < (n || 1); i++) { if (!stored) break; clock += 200; stored(clock); } } };
}

let total = 0, fails = 0;
function t(name, fn) { total++; try { fn(); process.stdout.write("."); } catch (e) { fails++; console.log("\nFAIL: " + name + "\n  " + (e && e.message)); } }

t("preview nasce na temporada 0 (época nova)", () => {
  const g = loadPreview(); g.pump(4);
  assert.strictEqual(g.els.season.textContent, "temporada " + refSeasonId + " · faltam " + refDaysLeft + "d");
  assert.strictEqual(refSeasonId, 0);
});
t("preview sempre 'ao vivo' no navegador", () => {
  const g = loadPreview(); g.pump(4);
  assert.strictEqual(g.els.liveTxt.textContent, "ao vivo");
});
t("preview simula tokens: HUD popula tokens/custo/prédios", () => {
  const g = loadPreview(); g.pump(6);
  assert.ok(/tokens/.test(g.els.tok.innerHTML), "tok=" + g.els.tok.innerHTML);
  assert.ok(/≈ US\$/.test(g.els.cost.textContent), "cost=" + g.els.cost.textContent);
  assert.ok(parseInt(g.els.builds.textContent, 10) >= 2, "builds=" + g.els.builds.textContent);
});
t("preview roda no index.html (sem season/wish/verba) sem quebrar", () => {
  const g = loadPreview(true); // só os ids do index.html
  g.pump(6);
  assert.ok(/tokens/.test(g.els.tok.innerHTML));
  assert.strictEqual(g.els.liveTxt.textContent, "ao vivo");
});

console.log("\n" + (total - fails) + "/" + total + " passaram" + (fails ? " — " + fails + " FALHARAM" : ""));
process.exit(fails ? 1 : 0);
