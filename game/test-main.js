// Testes puros do main.js (node puro, sem Electron, ZERO deps).
//   node test-main.js
// Cobrem: preços, tokens/custo por usage, dedupe, subagentes, temporadas (época
// NOVA 01/07/2026), computeBoot (retomar / arquivar / DESCARTAR época incompatível),
// leitura incremental (readNew), o BACKFILL da temporada a partir dos transcripts,
// o estado 3-vias do tail (tailShape: 'decision' quando o Claude Code espera a Mel
// autorizar; 'live' pensando; 'idle' só com turno fechado) e a sanitização do
// retrato da cidade (city blob) que vai no POST do placar.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const m = require("./main.js");
const placar = require("./placar.js");

let total = 0, fails = 0;
function t(name, fn) {
  total++;
  try { fn(); process.stdout.write("."); }
  catch (e) { fails++; console.log("\nFAIL: " + name + "\n  " + (e && e.message)); }
}

// ---------------------------------------------------------------- priceFor
t("priceFor opus-4-8", () => assert.deepStrictEqual(m.priceFor("claude-opus-4-8"), { in: 5, out: 25 }));
t("priceFor sufixo [1m]", () => assert.deepStrictEqual(m.priceFor("claude-opus-4-8[1m]"), { in: 5, out: 25 }));
t("priceFor sufixo de data", () => assert.deepStrictEqual(m.priceFor("claude-sonnet-4-5-20251001"), { in: 3, out: 15 }));
t("priceFor <synthetic> = grátis", () => assert.deepStrictEqual(m.priceFor("<synthetic>"), { in: 0, out: 0 }));
t("priceFor desconhecido -> sonnet", () => assert.deepStrictEqual(m.priceFor("modelo-que-nao-existe"), { in: 3, out: 15 }));
t("priceFor null -> sonnet", () => assert.deepStrictEqual(m.priceFor(null), { in: 3, out: 15 }));
t("priceFor 'opus' cru", () => assert.deepStrictEqual(m.priceFor("opus"), { in: 5, out: 25 }));
t("priceFor fable", () => assert.deepStrictEqual(m.priceFor("fable"), { in: 10, out: 50 }));
t("priceFor mythos-5", () => assert.deepStrictEqual(m.priceFor("claude-mythos-5"), { in: 10, out: 50 }));
t("priceFor haiku cru", () => assert.deepStrictEqual(m.priceFor("haiku"), { in: 1, out: 5 }));
t("priceFor haiku-4-5", () => assert.deepStrictEqual(m.priceFor("claude-haiku-4-5"), { in: 1, out: 5 }));
t("priceFor sonnet cru", () => assert.deepStrictEqual(m.priceFor("sonnet"), { in: 3, out: 15 }));
t("priceFor case-insensitive", () => assert.deepStrictEqual(m.priceFor("CLAUDE-OPUS-4-8"), { in: 5, out: 25 }));

// ---------------------------------------------------------------- tokensFromUsage
t("tokensFromUsage soma in+out+cache_creation, ignora cache_read", () =>
  assert.strictEqual(m.tokensFromUsage({ input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 9999 }), 350));
t("tokensFromUsage null -> 0", () => assert.strictEqual(m.tokensFromUsage(null), 0));
t("tokensFromUsage vazio -> 0", () => assert.strictEqual(m.tokensFromUsage({}), 0));

// ---------------------------------------------------------------- costFromUsage
t("costFromUsage synthetic -> 0", () => assert.strictEqual(m.costFromUsage({ input_tokens: 1e6 }, "<synthetic>"), 0));
t("costFromUsage in/out opus", () => assert.strictEqual(m.costFromUsage({ input_tokens: 1e6, output_tokens: 1e6 }, "claude-opus-4-8"), 30));
t("costFromUsage cache_read = 0,10x", () => assert.strictEqual(m.costFromUsage({ cache_read_input_tokens: 1e6 }, "claude-opus-4-8"), 0.5));
t("costFromUsage cache_creation sem detalhe = 1,25x", () => assert.strictEqual(m.costFromUsage({ cache_creation_input_tokens: 1e6 }, "claude-opus-4-8"), 6.25));
t("costFromUsage 1h=2x + 5m=1,25x", () => assert.strictEqual(
  m.costFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 } }, "claude-opus-4-8"), 16.25));
t("costFromUsage null -> 0", () => assert.strictEqual(m.costFromUsage(null, "claude-opus-4-8"), 0));

// ---------------------------------------------------------------- remember (dedupe + cap)
t("remember: chave nova true, repetida false", () => {
  const s = new Set();
  assert.strictEqual(m.remember(s, "a", 10), true);
  assert.strictEqual(m.remember(s, "a", 10), false);
});
t("remember: evicção FIFO ao passar do cap", () => {
  const s = new Set();
  m.remember(s, "k1", 2); m.remember(s, "k2", 2); m.remember(s, "k3", 2); // k1 evictado
  assert.strictEqual(s.has("k1"), false);
  assert.strictEqual(m.remember(s, "k1", 2), true); // reaparece como nova
});

// ---------------------------------------------------------------- countNewSubagents
function agentLine(name, id) { return { message: { content: [{ type: "tool_use", name: name, id: id }] } }; }
t("countNewSubagents Agent conta 1", () => { m.seenAgents.clear(); assert.strictEqual(m.countNewSubagents(agentLine("Agent", "x1")), 1); });
t("countNewSubagents Task conta 1", () => { m.seenAgents.clear(); assert.strictEqual(m.countNewSubagents(agentLine("Task", "x2")), 1); });
t("countNewSubagents mesmo id nao reconta", () => {
  m.seenAgents.clear();
  assert.strictEqual(m.countNewSubagents(agentLine("Agent", "dup")), 1);
  assert.strictEqual(m.countNewSubagents(agentLine("Agent", "dup")), 0);
});
t("countNewSubagents sem id conta sempre", () => {
  m.seenAgents.clear();
  assert.strictEqual(m.countNewSubagents(agentLine("Agent", undefined)), 1);
  assert.strictEqual(m.countNewSubagents(agentLine("Agent", undefined)), 1);
});
t("countNewSubagents ignora outras tools", () => { m.seenAgents.clear(); assert.strictEqual(m.countNewSubagents(agentLine("Bash", "b1")), 0); });
t("countNewSubagents sem content -> 0", () => assert.strictEqual(m.countNewSubagents({ message: {} }), 0));

// ---------------------------------------------------------------- temporadas (época NOVA)
const NOW = Date.parse("2026-07-12T19:00:00Z"); // hoje, per enunciado
t("SEASON_EPOCH = 01/07/2026 UTC", () => assert.strictEqual(m.SEASON_EPOCH, Date.UTC(2026, 6, 1)));
t("SEASON_MS = 28 dias", () => assert.strictEqual(m.SEASON_MS, 28 * 86400000));
t("currentSeasonId hoje = 0", () => assert.strictEqual(m.currentSeasonId(NOW), 0));
t("daysLeftIn hoje = 17", () => assert.strictEqual(m.daysLeftIn(NOW), 17));
t("currentSeasonId na própria época = 0", () => assert.strictEqual(m.currentSeasonId(m.SEASON_EPOCH), 0));
t("currentSeasonId em 03/08/2026 = 1", () => assert.strictEqual(m.currentSeasonId(Date.parse("2026-08-03T00:00:00Z")), 1));

// ---------------------------------------------------------------- computeBoot
t("computeBoot retoma mesma temporada", () => {
  const b = m.computeBoot({ seasonId: 0, tokens: 500, costUSD: 1.2, residents: 3, history: [] }, NOW);
  assert.strictEqual(b.seasonId, 0); assert.strictEqual(b.tokens, 500);
  assert.strictEqual(b.costUSD, 1.2); assert.strictEqual(b.residents, 3); assert.strictEqual(b.archived, false);
});
t("computeBoot DESCARTA época incompatível (seasonId 6 > atual)", () => {
  const b = m.computeBoot({ seasonId: 6, tokens: 104267, costUSD: 4.83, residents: 0, history: [] }, NOW);
  assert.strictEqual(b.seasonId, 0);
  assert.strictEqual(b.tokens, 0); assert.strictEqual(b.costUSD, 0); assert.strictEqual(b.residents, 0);
  assert.strictEqual(b.archived, false); assert.strictEqual(b.discarded, true);
});
t("computeBoot descarte também zera o history antigo", () => {
  const b = m.computeBoot({ seasonId: 6, tokens: 10, costUSD: 1, residents: 1, history: [{ seasonId: 5, tokens: 9 }] }, NOW);
  assert.deepStrictEqual(b.history, []);
});
t("computeBoot arquiva temporada mais antiga (< atual)", () => {
  const later = Date.parse("2026-08-20T00:00:00Z"); // temporada 1
  const b = m.computeBoot({ seasonId: 0, tokens: 12000, costUSD: 2, residents: 4, history: [] }, later);
  assert.strictEqual(b.seasonId, 1); assert.strictEqual(b.tokens, 0);
  assert.strictEqual(b.archived, true); assert.strictEqual(b.history.length, 1);
  assert.strictEqual(b.history[0].seasonId, 0); assert.strictEqual(b.history[0].residents, 4);
});
t("computeBoot sem disk -> zera limpo", () => {
  const b = m.computeBoot(null, NOW);
  assert.strictEqual(b.tokens, 0); assert.strictEqual(b.residents, 0); assert.deepStrictEqual(b.history, []);
});

// ---------------------------------------------------------------- readNew (incremental)
const TMP = path.join(os.tmpdir(), "tt-test-" + process.pid + ".jsonl");
t("readNew conta usage nova e avança offset; 2ª leitura = 0", () => {
  m.seenUsage.clear(); m.seenAgents.clear(); m.offsets.delete(TMP);
  const L1 = JSON.stringify({ timestamp: "2026-07-10T00:00:00Z", requestId: "req_A",
    message: { id: "msg_A", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000 } } });
  const Ldup = L1; // mesma msg_A:req_A -> deve deduplicar
  const L3 = JSON.stringify({ timestamp: "2026-07-10T00:01:00Z", message: { content: [{ type: "tool_use", name: "Agent", id: "toolu_1" }] } });
  fs.writeFileSync(TMP, L1 + "\n" + Ldup + "\n" + L3 + "\n");
  const r = m.readNew(TMP);
  assert.strictEqual(r.tokens, 350);          // só L1 (dup deduplicada)
  assert.strictEqual(r.agents, 1);            // um subagente
  assert.ok(Math.abs(r.cost - 0.0063125) < 1e-9); // 500+5000+500+312.5 / 1e6
  const r2 = m.readNew(TMP);                   // offset no fim -> nada novo
  assert.strictEqual(r2.tokens, 0); assert.strictEqual(r2.agents, 0);
  fs.unlinkSync(TMP);
});

// ---------------------------------------------------------------- liveness (FIX: falso "terminou")
// Uma linha SEM usage (ex.: tool_result de um Bash longo ao terminar) não gera tokens,
// mas AINDA é atividade: readNew.grew tem de ficar true. E crescer de novo -> false.
t("readNew.grew: linha sem usage (tool_result) conta como atividade", () => {
  const F = path.join(os.tmpdir(), "tt-grew-" + process.pid + ".jsonl");
  m.seenUsage.clear(); m.offsets.delete(F);
  const L = JSON.stringify({ timestamp: "2026-07-10T00:00:00Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
  fs.writeFileSync(F, L + "\n");
  const r = m.readNew(F);
  assert.strictEqual(r.tokens, 0);            // sem usage -> zero token
  assert.strictEqual(r.grew, true);           // mas ganhou bytes -> ATIVIDADE
  const r2 = m.readNew(F);                     // nada novo
  assert.strictEqual(r2.grew, false);
  fs.appendFileSync(F, JSON.stringify({ message: {} }) + "\n");
  assert.strictEqual(m.readNew(F).grew, true); // cresceu de novo -> atividade
  fs.unlinkSync(F);
});
// anyFileGrew (tasks/*.output): 1ª vez = baseline (não conta); crescer = conta; estável = não.
t("anyFileGrew: baseline não marca, crescimento marca, estável não", () => {
  m.taskSizes.clear();
  const F = path.join(os.tmpdir(), "tt-live-" + process.pid + ".output");
  fs.writeFileSync(F, "aaa");
  assert.strictEqual(m.anyFileGrew([F]), false); // 1ª vez = baseline (pré-existente não marca live)
  fs.appendFileSync(F, "bbbb");
  assert.strictEqual(m.anyFileGrew([F]), true);  // cresceu -> ao vivo
  assert.strictEqual(m.anyFileGrew([F]), false); // estável -> ocioso
  fs.unlinkSync(F);
});
t("anyFileGrew: arquivo sumido não quebra", () => {
  m.taskSizes.clear();
  assert.strictEqual(m.anyFileGrew(["/caminho/que/nao/existe.output"]), false);
});
t("listTaskOutputs devolve um array (sem quebrar mesmo sem base)", () => {
  assert.ok(Array.isArray(m.listTaskOutputs()));
});
t("IDLE_MS reduziu p/ 15s (era 45s) — turno fechado real; thinking segura live até THINK_MS", () => {
  assert.strictEqual(m.IDLE_MS, 15000);
});

// ---------------------------------------------------------------- tailShape ('decision'/'live'/'idle')
// Shapes copiados dos transcripts REAIS desta máquina (ver evidência no main.js):
// tool_use pendente sem tool_result = esperando a Mel; assistant end_turn = turno
// fechado; user text/tool_result no fim = modelo pensando; "[Request interrupted]"
// = turno abortado; Agent/Task pendente = subagente rodando (não é decisão).
function asstTool(name, id, rid) {
  return { requestId: rid || "req_1", timestamp: "2026-07-12T19:00:00Z",
    message: { role: "assistant", stop_reason: "tool_use", model: "claude-opus-4-8",
      content: [{ type: "tool_use", name: name, id: id, input: {} }] } };
}
function asstText(sr, rid) {
  return { requestId: rid || "req_1", timestamp: "2026-07-12T19:00:00Z",
    message: { role: "assistant", stop_reason: sr, content: [{ type: "text", text: "ok, fiz" }] } };
}
function toolRes(id, txt) {
  return { timestamp: "2026-07-12T19:00:05Z", toolUseResult: true,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: txt || "ok" }] } };
}
function userMsg(txt) { return { timestamp: "2026-07-12T19:00:01Z", message: { role: "user", content: txt } }; }
const METAS = [{ type: "last-prompt" }, { type: "permission-mode" }, { type: "ai-title" }]; // linhas reais sem message

t("tailShape: tool_use (Bash) SEM tool_result -> decision", () => {
  assert.strictEqual(m.tailShape([asstText("tool_use"), asstTool("Bash", "t1")]), "decision");
});
t("tailShape: AskUserQuestion pendente também é decision", () => {
  assert.strictEqual(m.tailShape([asstTool("AskUserQuestion", "q1")]), "decision");
});
t("tailShape: metadados no fim (last-prompt etc.) não escondem a decisão", () => {
  assert.strictEqual(m.tailShape([asstTool("Bash", "t1")].concat(METAS)), "decision");
});
t("tailShape: tool_use respondido + tool_result no fim -> live (pensando)", () => {
  assert.strictEqual(m.tailShape([asstTool("Bash", "t1"), toolRes("t1")]), "live");
});
t("tailShape: rejeição real ('user doesn't want to proceed') -> live (modelo deve resposta)", () => {
  assert.strictEqual(m.tailShape([asstTool("Bash", "t1"),
    toolRes("t1", "The user doesn't want to proceed with this tool use.")]), "live");
});
t("tailShape: turno fechado (assistant end_turn) -> idle", () => {
  assert.strictEqual(m.tailShape([asstTool("Bash", "t1"), toolRes("t1"), asstText("end_turn", "req_2")]), "idle");
});
t("tailShape: end_turn seguido de metadados -> idle", () => {
  assert.strictEqual(m.tailShape([asstText("end_turn")].concat(METAS)), "idle");
});
t("tailShape: prompt novo da Mel no fim -> live (pensando)", () => {
  assert.strictEqual(m.tailShape([asstText("end_turn"), userMsg("faz um site pra mim")]), "live");
});
t("tailShape: '[Request interrupted by user]' -> idle (ESC aborta o turno)", () => {
  assert.strictEqual(m.tailShape([asstTool("Bash", "t1"), toolRes("t1"),
    userMsg([{ type: "text", text: "[Request interrupted by user]" }])]), "idle");
});
t("tailShape: Agent/Task pendente = subagente rodando -> live (não é decisão)", () => {
  assert.strictEqual(m.tailShape([asstTool("Agent", "a1")]), "live");
  assert.strictEqual(m.tailShape([asstTool("Task", "a2")]), "live");
});
t("tailShape: paralelo — Agent respondido, Bash pendente -> decision", () => {
  const turn = [asstTool("Agent", "a1", "req_9"), asstTool("Bash", "b1", "req_9"), toolRes("a1")];
  assert.strictEqual(m.tailShape(turn), "decision");
});
t("tailShape: turno em VÁRIAS linhas (mesmo requestId): texto + tool_use pendente -> decision", () => {
  assert.strictEqual(m.tailShape([asstText("tool_use", "req_5"), asstTool("Bash", "t9", "req_5")]), "decision");
});
t("tailShape: assistant stop_reason null (turno ainda sendo gravado) -> live", () => {
  assert.strictEqual(m.tailShape([asstText(null)]), "live");
});
t("tailShape: vazio/só metadados -> idle", () => {
  assert.strictEqual(m.tailShape([]), "idle");
  assert.strictEqual(m.tailShape(METAS.slice()), "idle");
});
t("readTailLines: lê o fim do arquivo e ignora linha parcial sem \\n", () => {
  const F = path.join(os.tmpdir(), "tt-tail-" + process.pid + ".jsonl");
  fs.writeFileSync(F, JSON.stringify(asstText("end_turn")) + "\n" +
    JSON.stringify(asstTool("Bash", "tz")) + "\n" + '{"parcial":');
  const lines = m.readTailLines(F);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(m.tailShape(lines), "decision");
  fs.unlinkSync(F);
});
t("readTailLines: arquivo grande -> só os últimos ~64KB (descarta linha cortada)", () => {
  const F = path.join(os.tmpdir(), "tt-tail-big-" + process.pid + ".jsonl");
  const filler = JSON.stringify(userMsg("x".repeat(1000)));
  const many = new Array(120).fill(filler).join("\n"); // ~120KB
  fs.writeFileSync(F, many + "\n" + JSON.stringify(asstText("end_turn")) + "\n");
  const lines = m.readTailLines(F);
  assert.ok(lines.length > 0 && lines.length < 120, "tail não foi limitado: " + lines.length);
  assert.strictEqual(m.tailShape(lines), "idle");
  fs.unlinkSync(F);
});
t("isSubagentPath: espelho de subagente não é o transcript ativo", () => {
  assert.strictEqual(m.isSubagentPath(path.join("a", "subagents", "agent-x.jsonl")), true);
  assert.strictEqual(m.isSubagentPath(path.join("a", "sessao.jsonl")), false);
});
t("constantes do estado: DECISION_MS 4s (era 10s), THINK_MS 30min, RECENT_MS 30min, TAIL_BYTES 64KB", () => {
  assert.strictEqual(m.DECISION_MS, 4000);      // 10s→4s: pausa/decisão do principal mais rápida p/ a Mel
  assert.strictEqual(m.THINK_MS, 30 * 60000);   // FIX H2: subimos de 10min p/ 30min (subagente pensa >10min)
  assert.strictEqual(m.RECENT_MS, 30 * 60000);
  assert.strictEqual(m.TAIL_BYTES, 65536);
});

// -------------------------------------------- AGREGAÇÃO (silêncio POR-TRANSCRIPT)
// combineShapes agora recebe o silêncio PRÓPRIO de cada transcript: main={shape,silence},
// others=[{shape,silence}], onde `silence` = ms desde o último crescimento DAQUELE arquivo
// (não global). Helper `sh` monta os pares.
function sh(shape, silence) { return { shape: shape, silence: silence === undefined ? 0 : silence }; }

// Bug real da Mel (12/07 ~22:01): app disse "o agente terminou" enquanto um subagente
// pensava (Mulling 7m17s xhigh). Principal fecha o turno (idle) mas o espelho do subagente
// segue vivo -> agregado 'live', nunca "terminou".
t("combineShapes: principal 'idle' + subagente 'live' -> live (CENÁRIO Mulling da Mel)", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("live", 0)]), "live");
});
t("combineShapes: principal 'idle' + subagente 'decision' com silêncio PRÓPRIO curto -> live (tool executando)", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 0)]), "live");     // 0 < 22s
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 20000)]), "live"); // 20s < 22s -> ainda cresce
});
t("combineShapes: principal 'idle' sem outros recentes -> idle (turno realmente fechado)", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), []), "idle");
});
t("combineShapes: principal 'idle' + só espelhos velhos 'idle' -> idle", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("idle"), sh("idle")]), "idle");
});
t("combineShapes: 'decision' do PRINCIPAL (silêncio DELE >=4s) manda mesmo com subagente vivo", () => {
  assert.strictEqual(m.combineShapes(sh("decision", m.DECISION_MS), [sh("live", 0)]), "decision");
});
t("combineShapes: principal 'live' (pensando) sozinho -> live", () => {
  assert.strictEqual(m.combineShapes(sh("live", 60000), []), "live");
});
t("combineShapes: um de vários espelhos 'live' basta -> live", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("idle"), sh("idle"), sh("live", 0), sh("idle")]), "live");
});

// -------------------------------------------- FIX MULTI-AGENTE: a decisão NÃO é mascarada
// BUG REAL DA MEL: "se eu tenho mais de um subagente, o aviso de 'sua decisão' NÃO aparece".
// CAUSA: o silêncio era GLOBAL (resetado por crescimento de QUALQUER arquivo); com vários
// subagentes escrevendo, o global nunca acumulava e a 'decisão' (do principal esperando
// permissão, OU de um subagente) ficava mascarada como 'live'. FIX: silêncio POR-TRANSCRIPT
// — a decisão do PRINCIPAL usa o silêncio DELA (prioridade) e a de subagente exige
// >=SUB_DECISION_MS no arquivo DELE; o agregado vira 'decision' MESMO com outros vivos.
t("constantes de decisão: SUB_DECISION_MS=22s, DECISION_MS=4s (silêncios PRÓPRIOS)", () => {
  assert.strictEqual(m.SUB_DECISION_MS, 22000);
  assert.strictEqual(m.DECISION_MS, 4000);
});
t("combineShapes MULTI-AGENTE: PRINCIPAL 'decision' (silêncio dele >=4s) + subagentes BARULHENTOS 'live' -> decision (antes daria 'live')", () => {
  // a Mel está sendo esperada (principal quieto 5s); TRÊS subagentes escrevendo (silêncio ~0)
  assert.strictEqual(
    m.combineShapes(sh("decision", 5000), [sh("live", 0), sh("live", 100), sh("live", 50)]),
    "decision");
});
t("combineShapes MULTI-AGENTE: SUBAGENTE esperando permissão (silêncio dele >=22s) + OUTRO subagente 'live' -> decision", () => {
  assert.strictEqual(
    m.combineShapes(sh("idle"), [sh("decision", 30000), sh("live", 0)]),
    "decision");
});
t("combineShapes: subagente 'decision' MUDO >=SUB_DECISION_MS (22s) -> decision (permissão no terminal da Mel)", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 22000)]), "decision");       // no limiar exato
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", m.SUB_DECISION_MS)]), "decision");
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 300000)]), "decision"); // 5min mudo
});
t("combineShapes: subagente 'decision' logo abaixo de SUB_DECISION_MS (22s) -> ainda live", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", m.SUB_DECISION_MS - 1)]), "live");
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 21999)]), "live");
});
t("combineShapes: subagente 'decision' sustentado vence até com outro subagente 'live'", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("live", 0), sh("decision", 120000)]), "decision");
});
t("combineShapes: PRINCIPAL 'decision' ainda QUENTE (silêncio dele <4s) -> live (tool executando, auto-corrige)", () => {
  assert.strictEqual(m.combineShapes(sh("decision", 0), [sh("idle")]), "live");
  assert.strictEqual(m.combineShapes(sh("decision", 3999), [sh("idle")]), "live");
  assert.strictEqual(m.combineShapes(sh("decision", 4000), [sh("idle")]), "decision"); // no limiar -> decision
});
t("combineShapes: subagente executando (silêncio próprio curto) -> live, nunca decision", () => {
  assert.strictEqual(m.combineShapes(sh("idle"), [sh("decision", 5000)]), "live");
});

// Reprodução ponta-a-ponta do CENÁRIO DE HOJE com ARQUIVOS reais: principal fechou o turno
// (despachou o subagente em background -> end_turn) e o espelho do subagente ficou parado
// num relançamento Bash PENDENTE (sem tool_result). Silêncio global >=22s -> decision;
// silêncio curto (tool ainda executando / outro arquivo crescendo) -> live.
t("cenário HOJE ponta-a-ponta: principal end_turn + espelho subagente c/ Bash relançamento pendente", () => {
  const MAINF = path.join(os.tmpdir(), "tt-perm-main-" + process.pid + ".jsonl");
  const SUBF = path.join(os.tmpdir(), "tt-perm-sub-" + process.pid + ".jsonl");
  fs.writeFileSync(MAINF,
    JSON.stringify(asstTool("Agent", "a1", "req_1")) + "\n" +
    JSON.stringify(toolRes("a1", "Async agent launched successfully. agentId: ab0417")) + "\n" +
    JSON.stringify(asstText("end_turn", "req_2")) + "\n");
  // relançamento pendente: assistant tool_use Bash SEM tool_result depois (aguardando a Mel)
  fs.writeFileSync(SUBF, JSON.stringify(asstTool("Bash", "relaunch1", "req_9")) + "\n");
  const mainShape = m.tailShape(m.readTailLines(MAINF));
  const subShape = m.tailShape(m.readTailLines(SUBF));
  assert.strictEqual(mainShape, "idle");                                        // principal fechou o turno
  assert.strictEqual(subShape, "decision");                                     // espelho parado no Bash pendente
  // silêncio PRÓPRIO do subagente decide: mudo >=22s = permissão; ainda escrevendo (<22s) = execução
  assert.strictEqual(m.combineShapes(sh(mainShape), [sh(subShape, 95000)]), "decision"); // >=22s mudo -> permissão
  assert.strictEqual(m.combineShapes(sh(mainShape), [sh(subShape, 8000)]), "live");      // ainda executando (< 22s) -> live
  fs.unlinkSync(MAINF); fs.unlinkSync(SUBF);
});

// Integração ponta-a-ponta com ARQUIVOS reais (como a Mel viveu): principal termina em
// `assistant end_turn` (despachou o subagente em background) e um espelho de subagente
// termina em `user tool_result` (mid-turn, prestes a pensar). tailShape de cada + combine.
t("cenário Mel ponta-a-ponta: principal end_turn + espelho subagente mid-turn -> live", () => {
  const MAINF = path.join(os.tmpdir(), "tt-agg-main-" + process.pid + ".jsonl");
  const SUBF = path.join(os.tmpdir(), "tt-agg-sub-" + process.pid + ".jsonl");
  // principal: despachou subagente (Agent respondido na hora) e fechou o turno
  fs.writeFileSync(MAINF,
    JSON.stringify(asstTool("Agent", "a1", "req_1")) + "\n" +
    JSON.stringify(toolRes("a1", "Async agent launched successfully. agentId: ab0417")) + "\n" +
    JSON.stringify(asstText("end_turn", "req_2")) + "\n");
  // espelho do subagente: recebeu um tool_result e agora está pensando (nada gravado além)
  fs.writeFileSync(SUBF,
    JSON.stringify(asstTool("Bash", "b1", "req_9")) + "\n" +
    JSON.stringify(toolRes("b1", "output do bash")) + "\n");
  const mainShape = m.tailShape(m.readTailLines(MAINF));
  const subShape = m.tailShape(m.readTailLines(SUBF));
  assert.strictEqual(mainShape, "idle");                 // principal FECHOU o turno (end_turn)
  assert.strictEqual(subShape, "live");                  // subagente mid-turn (pensando)
  assert.strictEqual(m.combineShapes(sh(mainShape), [sh(subShape, 0)]), "live"); // agregado NÃO é "terminou"
  fs.unlinkSync(MAINF); fs.unlinkSync(SUBF);
});
t("aggregateShape/computeState existem e não quebram sem transcripts recentes", () => {
  assert.strictEqual(typeof m.aggregateShape, "function");
  assert.ok(["live", "decision", "idle"].indexOf(m.aggregateShape(Date.now())) !== -1);
});

// -------------------------------------------- silêncio POR-TRANSCRIPT (silenceForFile)
t("silenceForFile: silêncio PRÓPRIO por arquivo; desconhecido/nulo -> Infinity", () => {
  const now = 1000000;
  m.activityByFile.set("/tt/a.jsonl", now - 5000);
  m.activityByFile.set("/tt/b.jsonl", now - 100);
  assert.strictEqual(m.silenceForFile("/tt/a.jsonl", now), 5000);
  assert.strictEqual(m.silenceForFile("/tt/b.jsonl", now), 100);
  assert.strictEqual(m.silenceForFile("/tt/never-seen.jsonl", now), Infinity);
  assert.strictEqual(m.silenceForFile(null, now), Infinity);
  m.activityByFile.delete("/tt/a.jsonl"); m.activityByFile.delete("/tt/b.jsonl");
});

// -------------------------------------------- CENÁRIO EXATO DA MEL (fixtures multi-arquivo)
// "Se eu tenho mais de um subagente, o aviso de 'sua decisão' NÃO aparece." Reproduz com
// ARQUIVOS reais: a sessão PRINCIPAL tem um tool_use pendente (esperando a permissão DELA) e
// seu arquivo está silencioso há >=DECISION_MS, ENQUANTO dois subagentes crescem
// continuamente (silêncio próprio ~0). Silêncio GLOBAL (código antigo) -> 'live' (mascarado);
// silêncio POR-TRANSCRIPT -> 'decision' (APARECE).
t("MULTI-AGENTE ponta-a-ponta (fixtures): PRINCIPAL esperando permissão + 2 subagentes barulhentos -> decision", () => {
  const MAINF = path.join(os.tmpdir(), "tt-ma-main-" + process.pid + ".jsonl");
  const S1 = path.join(os.tmpdir(), "tt-ma-sub1-" + process.pid + ".jsonl");
  const S2 = path.join(os.tmpdir(), "tt-ma-sub2-" + process.pid + ".jsonl");
  fs.writeFileSync(MAINF, JSON.stringify(asstTool("Bash", "perm1", "req_main")) + "\n"); // pediu Bash, parou
  fs.writeFileSync(S1, JSON.stringify(asstTool("Edit", "e1", "req_s1")) + "\n" + JSON.stringify(toolRes("e1")) + "\n");
  fs.writeFileSync(S2, JSON.stringify(asstTool("Bash", "b2", "req_s2")) + "\n" + JSON.stringify(toolRes("b2")) + "\n");
  const mainShape = m.tailShape(m.readTailLines(MAINF));
  const s1 = m.tailShape(m.readTailLines(S1));
  const s2 = m.tailShape(m.readTailLines(S2));
  assert.strictEqual(mainShape, "decision"); // principal esperando a Mel
  assert.strictEqual(s1, "live"); assert.strictEqual(s2, "live"); // subagentes vivos
  const now = Date.now();
  m.activityByFile.set(MAINF, now - 5000); // principal quieto 5s (>=DECISION_MS)
  m.activityByFile.set(S1, now - 100);     // subagentes crescendo
  m.activityByFile.set(S2, now - 50);
  const agg = m.combineShapes(
    { shape: mainShape, silence: m.silenceForFile(MAINF, now) },
    [ { shape: s1, silence: m.silenceForFile(S1, now) },
      { shape: s2, silence: m.silenceForFile(S2, now) } ]);
  assert.strictEqual(agg, "decision"); // APARECE, apesar dos subagentes barulhentos
  // prova do bug antigo: o silêncio GLOBAL (min de todos) seria ~0 -> antigo mascarava como 'live'
  const globalSilence = Math.min(m.silenceForFile(MAINF, now), m.silenceForFile(S1, now), m.silenceForFile(S2, now));
  assert.ok(globalSilence < m.DECISION_MS, "silêncio global ~0 (subagente crescendo): antigo daria 'live'");
  m.activityByFile.delete(MAINF); m.activityByFile.delete(S1); m.activityByFile.delete(S2);
  fs.unlinkSync(MAINF); fs.unlinkSync(S1); fs.unlinkSync(S2);
});
t("MULTI-AGENTE ponta-a-ponta (fixtures): SUBAGENTE esperando permissão + outro subagente barulhento -> decision", () => {
  const MAINF = path.join(os.tmpdir(), "tt-ma2-main-" + process.pid + ".jsonl");
  const SPERM = path.join(os.tmpdir(), "tt-ma2-perm-" + process.pid + ".jsonl");
  const SNOISY = path.join(os.tmpdir(), "tt-ma2-noisy-" + process.pid + ".jsonl");
  fs.writeFileSync(MAINF, JSON.stringify(asstText("end_turn", "req_main")) + "\n"); // despachou subagentes
  fs.writeFileSync(SPERM, JSON.stringify(asstTool("Bash", "relaunch", "req_perm")) + "\n"); // subagente esperando permissão
  fs.writeFileSync(SNOISY, JSON.stringify(asstTool("Edit", "e9", "req_noisy")) + "\n" + JSON.stringify(toolRes("e9")) + "\n");
  const mainShape = m.tailShape(m.readTailLines(MAINF));
  const perm = m.tailShape(m.readTailLines(SPERM));
  const noisy = m.tailShape(m.readTailLines(SNOISY));
  assert.strictEqual(mainShape, "idle");
  assert.strictEqual(perm, "decision");
  assert.strictEqual(noisy, "live");
  const now = Date.now();
  m.activityByFile.set(MAINF, now - 40000);
  m.activityByFile.set(SPERM, now - 30000); // mudo há 30s (>=SUB_DECISION_MS)
  m.activityByFile.set(SNOISY, now - 100);  // crescendo
  const agg = m.combineShapes(
    { shape: mainShape, silence: m.silenceForFile(MAINF, now) },
    [ { shape: perm, silence: m.silenceForFile(SPERM, now) },
      { shape: noisy, silence: m.silenceForFile(SNOISY, now) } ]);
  assert.strictEqual(agg, "decision");
  m.activityByFile.delete(MAINF); m.activityByFile.delete(SPERM); m.activityByFile.delete(SNOISY);
  fs.unlinkSync(MAINF); fs.unlinkSync(SPERM); fs.unlinkSync(SNOISY);
});

// -------------------------------------------- resolveState (silêncio GLOBAL só p/ live<->idle)
// O gating temporal da DECISÃO mudou de lugar: agora mora em combineShapes (silêncio PRÓPRIO
// de cada transcript). Aqui o silêncio GLOBAL só decide live<->idle; um shape 'decision' já
// vem validado e manda SEMPRE — é isso que faz "sua decisão" APARECER durante runs
// multi-agente (silêncio global baixo por causa de subagente barulhento NÃO invalida a
// espera do principal). THINKING LONGO segue segurando 'live'.
t("resolveState: shape 'decision' -> 'decision' mesmo com silêncio GLOBAL baixo (multi-agente)", () => {
  assert.strictEqual(m.resolveState(0, "decision"), "decision");     // subagente acabou de escrever (global ~0)
  assert.strictEqual(m.resolveState(3000, "decision"), "decision");  // não mascara mais
  assert.strictEqual(m.resolveState(9000, "decision"), "decision");
  assert.strictEqual(m.resolveState(25000, "decision"), "decision"); // decisão manda sobre o limiar de idle
});
t("resolveState: shape não-decision com silêncio global < IDLE_MS (15s) -> live", () => {
  assert.strictEqual(m.resolveState(3999, "idle"), "live");
  assert.strictEqual(m.resolveState(10000, "idle"), "live");   // 10s < 15s -> ainda live
});
t("resolveState: 'idle' só depois de IDLE_MS (15s) com shape fechado; antes segura 'live'", () => {
  assert.strictEqual(m.resolveState(15000, "idle"), "idle");   // 15s -> turno fechado = idle
  assert.strictEqual(m.resolveState(20000, "idle"), "idle");
});
t("resolveState: THINKING LONGO (shape 'live') NÃO vira idle com IDLE_MS=15s (caso Mulling)", () => {
  // shape 'live' = tail user/tool_result (pensando) ou subagente vivo: segura 'live' muito
  // além de 15s; só o cap de sessão abandonada (THINK_MS) o converte em idle.
  assert.strictEqual(m.resolveState(15001, "live"), "live");
  assert.strictEqual(m.resolveState(60000, "live"), "live");        // 1min pensando -> AINDA live
  assert.strictEqual(m.resolveState(10 * 60000, "live"), "live");   // 10min pensando -> live
  assert.strictEqual(m.resolveState(m.THINK_MS, "live"), "idle");   // só THINK_MS (abandono) vira idle
});

// -------------------------------------------- AVISO ATIVO (transição -> notificação do sistema)
// A Mel: "o app não me avisa quando preciso decidir/agir". alertForTransition dispara UMA
// vez por transição p/ 'decision'/'idle' (debounce); shouldNotify suprime se a janela do
// overlay está focada (ela já está olhando). Boot (prev==null) = baseline silencioso.
t("alertForTransition: live->decision avisa 'decision'; live->idle avisa 'idle'", () => {
  assert.strictEqual(m.alertForTransition("live", "decision"), "decision");
  assert.strictEqual(m.alertForTransition("live", "idle"), "idle");
});
t("alertForTransition: DEBOUNCE — mesmo estado repetido NÃO reavisa (1x por transição)", () => {
  assert.strictEqual(m.alertForTransition("decision", "decision"), null);
  assert.strictEqual(m.alertForTransition("idle", "idle"), null);
  assert.strictEqual(m.alertForTransition("live", "live"), null);
});
t("alertForTransition: ->live nunca avisa", () => {
  assert.strictEqual(m.alertForTransition("decision", "live"), null);
  assert.strictEqual(m.alertForTransition("idle", "live"), null);
});
t("alertForTransition: boot (prev==null) fixa baseline em SILÊNCIO (sem aviso no relançamento)", () => {
  assert.strictEqual(m.alertForTransition(null, "decision"), null);
  assert.strictEqual(m.alertForTransition(null, "idle"), null);
  assert.strictEqual(m.alertForTransition(null, "live"), null);
});
t("alertForTransition: idle->decision e decision->idle também avisam (mudança p/ estado que pede ação)", () => {
  assert.strictEqual(m.alertForTransition("idle", "decision"), "decision");
  assert.strictEqual(m.alertForTransition("decision", "idle"), "idle");
});
t("shouldNotify: transição com a janela FOCADA é suprimida (a Mel já está olhando)", () => {
  assert.strictEqual(m.shouldNotify("live", "decision", true), false);
  assert.strictEqual(m.shouldNotify("live", "idle", true), false);
});
t("shouldNotify: transição SEM foco notifica", () => {
  assert.strictEqual(m.shouldNotify("live", "decision", false), true);
  assert.strictEqual(m.shouldNotify("live", "idle", false), true);
});
t("shouldNotify: sem transição (mesmo estado / baseline) não notifica, focada ou não", () => {
  assert.strictEqual(m.shouldNotify("decision", "decision", false), false);
  assert.strictEqual(m.shouldNotify(null, "live", false), false);
});

// ---------------------------------------------------------------- backfillSeason (regressão vs varredura de referência)
// Confere que o backfill do app bate com uma varredura INDEPENDENTE dos transcripts
// reais (mesmo gating por timestamp + mesmo dedupe), usando os helpers exportados.
t("backfillSeason bate com varredura independente dos transcripts reais (tolerante a crescimento vivo)", () => {
  const PROJECTS = path.join(os.homedir(), ".claude", "projects");
  const seasonStart = m.SEASON_EPOCH + 0 * m.SEASON_MS; // T0
  function list(dir, acc) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
    for (const e of ents) { const p = path.join(dir, e.name);
      if (e.isDirectory()) list(p, acc); else if (e.name.endsWith(".jsonl")) acc.push(p); }
    return acc;
  }
  // varredura de referência INDEPENDENTE (mesmo gating por timestamp + mesmo dedupe).
  function refScan() {
    const su = new Set(), sa = new Set();
    let tk = 0, ag = 0, cost = 0;
    for (const f of list(PROJECTS, [])) {
      let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
      const nl = buf.lastIndexOf(0x0a); if (nl < 0) continue;
      for (const line of buf.slice(0, nl).toString("utf8").split("\n")) {
        if (!line) continue; let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o.timestamp) continue; if (!(Date.parse(o.timestamp) >= seasonStart)) continue;
        const u = o.message && o.message.usage;
        if (u) { const mid = o.message && o.message.id, rid = o.requestId; let c = true;
          // MESMO dedupe CAPADO do app (USAGE_CAP=5000, evicção FIFO): com >5000 linhas
          // de usage na temporada, a evicção pode recontar duplicata evictada — a referência
          // tem de replicar EXATAMENTE, senão diverge ~0,06% (não é crescimento vivo).
          if (mid != null && rid != null) c = m.remember(su, mid + ":" + rid, 5000);
          if (c) { tk += m.tokensFromUsage(u); cost += m.costFromUsage(u, o.message.model); } }
        const cont = o.message && o.message.content;
        if (Array.isArray(cont)) for (const b of cont)
          if (b && b.type === "tool_use" && (b.name === "Agent" || b.name === "Task"))
            { if (b.id != null) { if (m.remember(sa, b.id, 5000)) ag++; } else ag++; } // MESMO cap do app (AGENT_CAP)
      }
    }
    return { tk: tk, ag: ag, cost: cost };
  }
  // Os transcripts VIVOS crescem DURANTE o teste (a Mel roda o app enquanto testa). Como só
  // APPENDam (monotônico), a varredura ANTES <= o backfill do app <= a varredura DEPOIS.
  // Bracketing (congela o alvo por INTERVALO) em vez de igualdade exata — NÃO afrouxa: o
  // app ainda tem de bater com uma varredura independente, só tolera o append da janela.
  const before = refScan();
  m.seenUsage.clear(); m.seenAgents.clear(); m.offsets.clear();
  m.backfillSeason();
  const s = m.state();
  const after = refScan();
  const inRange = (v, a, b, eps) => v >= Math.min(a, b) - (eps || 0) && v <= Math.max(a, b) + (eps || 0);
  assert.ok(inRange(s.seasonTokens, before.tk, after.tk),
    "tokens fora de [" + before.tk + "," + after.tk + "]: " + s.seasonTokens);
  assert.ok(inRange(s.subagents, before.ag, after.ag),
    "moradores fora de [" + before.ag + "," + after.ag + "]: " + s.subagents);
  assert.ok(inRange(s.costUSD, before.cost, after.cost, 1e-6),
    "custo fora de [" + before.cost + "," + after.cost + "]: " + s.costUSD);
});

// ---------------------------------------------------------------- breakdown diário (heatmap "CITY LIGHTS")
const DAILY_NOW = Date.UTC(2026, 6, 13, 12, 0, 0); // 13/07/2026 12:00 UTC
t("utcDayKeyMs: chave AAAAMMDD em UTC", () => {
  assert.strictEqual(m.utcDayKeyMs(Date.UTC(2026, 6, 13, 23, 59, 59)), "20260713");
  assert.strictEqual(m.utcDayKeyMs(Date.UTC(2026, 6, 1, 0, 0, 0)), "20260701");
});
t("dailyWindowStartMs: 7 dias UTC terminando hoje (inclui hoje) -> 07/07", () => {
  assert.strictEqual(m.dailyWindowStartMs(DAILY_NOW), Date.UTC(2026, 6, 7));
});
t("dailyBucketize: bucketiza por DIA UTC e SOMA várias entradas do mesmo dia", () => {
  const out = m.dailyBucketize([
    { ts: Date.UTC(2026, 6, 13, 1), tokens: 100 },
    { ts: Date.UTC(2026, 6, 13, 20), tokens: 50 },
    { ts: Date.UTC(2026, 6, 11, 12), tokens: 200 },
  ], DAILY_NOW);
  assert.strictEqual(out["20260713"], 150);
  assert.strictEqual(out["20260711"], 200);
});
t("dailyBucketize: respeita a fronteira de meia-noite UTC (dia certo)", () => {
  const out = m.dailyBucketize([
    { ts: Date.UTC(2026, 6, 7, 23, 59, 59), tokens: 9 },   // ainda 07/07
    { ts: Date.UTC(2026, 6, 8, 0, 0, 0), tokens: 11 },     // já 08/07
  ], DAILY_NOW);
  assert.strictEqual(out["20260707"], 9);
  assert.strictEqual(out["20260708"], 11);
});
t("dailyBucketize: descarta entradas FORA da janela de 7 dias (today-7 e antes)", () => {
  const out = m.dailyBucketize([
    { ts: Date.UTC(2026, 6, 6, 23), tokens: 999 }, // 06/07 = today-7, fora
    { ts: Date.UTC(2026, 6, 1, 12), tokens: 999 }, // início da temporada, fora
    { ts: Date.UTC(2026, 6, 7, 0), tokens: 5 },    // 07/07 = today-6, dentro (borda inclui)
  ], DAILY_NOW);
  assert.strictEqual(out["20260706"], undefined);
  assert.strictEqual(out["20260701"], undefined);
  assert.strictEqual(out["20260707"], 5);
  assert.strictEqual(Object.keys(out).length, 1);
});
t("addDailyTokens: soma no bucket de HOJE (UTC) e poda dias fora da janela", () => {
  const map = { "20260706": 500, "20260712": 40 }; // 06/07 já fora da janela de hoje
  m.addDailyTokens(map, DAILY_NOW, 60);
  assert.strictEqual(map["20260713"], 60);        // hoje ganhou 60
  assert.strictEqual(map["20260712"], 40);        // dia dentro preservado
  assert.strictEqual(map["20260706"], undefined); // dia fora podado
});

// backfill: o breakdown diário bate com uma varredura INDEPENDENTE windowed+deduped.
t("backfillSeason: breakdown diário bate com varredura windowed+deduped (bracketing p/ crescimento vivo)", () => {
  const PROJECTS = path.join(os.homedir(), ".claude", "projects");
  const seasonStart = m.SEASON_EPOCH + 0 * m.SEASON_MS; // T0
  const now = Date.now();
  const startMs = m.dailyWindowStartMs(now);
  function list(dir, acc) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
    for (const e of ents) { const p = path.join(dir, e.name);
      if (e.isDirectory()) list(p, acc); else if (e.name.endsWith(".jsonl")) acc.push(p); }
    return acc;
  }
  // MESMO gating por timestamp + MESMO dedupe capado (5000) + bucket por dia UTC na janela.
  function refDaily() {
    const su = new Set(); const daily = {};
    for (const f of list(PROJECTS, [])) {
      let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
      const nl = buf.lastIndexOf(0x0a); if (nl < 0) continue;
      for (const line of buf.slice(0, nl).toString("utf8").split("\n")) {
        if (!line) continue; let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o.timestamp) continue; const ts = Date.parse(o.timestamp);
        if (!(ts >= seasonStart)) continue;
        const u = o.message && o.message.usage;
        if (u) { const mid = o.message && o.message.id, rid = o.requestId; let c = true;
          if (mid != null && rid != null) c = m.remember(su, mid + ":" + rid, 5000);
          if (c && ts >= startMs) { const tkn = m.tokensFromUsage(u); if (tkn > 0) {
            const k = m.utcDayKeyMs(ts); daily[k] = (daily[k] || 0) + tkn; } } }
      }
    }
    return daily;
  }
  const before = refDaily();
  m.seenUsage.clear(); m.seenAgents.clear(); m.offsets.clear();
  m.backfillSeason();
  const got = m.lastDaily();
  const after = refDaily();
  // toda chave do backfill casa AAAAMMDD e está DENTRO da janela de 7 dias.
  const winKeys = new Set();
  for (let i = 0; i < 7; i++) winKeys.add(m.utcDayKeyMs(startMs + i * 86400000));
  for (const k of Object.keys(got)) {
    assert.ok(/^\d{8}$/.test(k), "chave não-AAAAMMDD: " + k);
    assert.ok(winKeys.has(k), "chave fora da janela: " + k);
  }
  // cada dia do backfill fica em [before, after] (append vivo só CRESCE o dia atual).
  const inRange = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);
  for (const k of winKeys) {
    const g = got[k] || 0, a = before[k] || 0, b = after[k] || 0;
    assert.ok(inRange(g, a, b), "dia " + k + " fora de [" + a + "," + b + "]: " + g);
  }
});

// ---------------------------------------------------------------- shapeDailyTokens (placar cliente)
t("shapeDailyTokens: cap 7 chaves (mantém as mais recentes) + descarta lixo", () => {
  const raw = {};
  for (let d = 1; d <= 10; d++) raw["202607" + String(d).padStart(2, "0")] = d * 10;
  raw["bad"] = 5; raw["20260705"] = -3; // chave inválida e valor negativo
  const out = placar.shapeDailyTokens(raw);
  assert.strictEqual(Object.keys(out).length, 7);
  assert.strictEqual(out["20260710"], 100);       // dia mais recente mantido
  assert.strictEqual(out["20260703"], 30);        // 7º mais recente (mantido)
  assert.strictEqual(out["20260702"], undefined); // mais antigos cortados
  assert.strictEqual(out["20260705"], undefined); // negativo descartado (não entra)
  assert.strictEqual(out["bad"], undefined);       // chave não-AAAAMMDD descartada
});
t("shapeDailyTokens: vazio/inválido -> undefined", () => {
  assert.strictEqual(placar.shapeDailyTokens({}), undefined);
  assert.strictEqual(placar.shapeDailyTokens(null), undefined);
  assert.strictEqual(placar.shapeDailyTokens({ "20260713": 0 }), undefined); // só 0 -> nada
});

// ---------------------------------------------------------------- sanitizeCity (city blob p/ o placar)
t("sanitizeCity null -> null", () => assert.strictEqual(placar.sanitizeCity(null), null));
t("sanitizeCity mantém o shape do contrato", () => {
  const c = placar.sanitizeCity({ v: 1, seed: 123456, buildings: 3526, pop: 94210,
    types: { parque: 12, torre: 3, mirante: 7 }, marcos: ["garden", "lighthouse", "towers"], era: 10 });
  assert.strictEqual(c.v, 1);
  assert.strictEqual(c.seed, 123456);
  assert.strictEqual(c.buildings, 3526);
  assert.strictEqual(c.pop, 94210);
  assert.strictEqual(c.era, 10);
  assert.deepStrictEqual(c.types, { parque: 12, torre: 3, mirante: 7 });
  assert.deepStrictEqual(c.marcos, ["garden", "lighthouse", "towers"]);
});
t("sanitizeCity coage negativos/inválidos p/ inteiros não-negativos", () => {
  const c = placar.sanitizeCity({ seed: -5, buildings: 2.9, pop: "94210", types: { torre: -3 }, era: null });
  assert.strictEqual(c.seed, 0);
  assert.strictEqual(c.buildings, 2);
  assert.strictEqual(c.pop, 94210);
  assert.strictEqual(c.types.torre, 0);
  assert.strictEqual(c.era, 0);
});
t("sanitizeCity descarta chaves/marcos fora de [a-z0-9-]", () => {
  const c = placar.sanitizeCity({ seed: 1, types: { "praça": 2, mercado: 4, "DROP TABLE": 9 },
    marcos: ["ferry", "x;rm", 42, "festival"] });
  assert.deepStrictEqual(Object.keys(c.types).sort(), ["mercado"]);
  assert.deepStrictEqual(c.marcos, ["ferry", "festival"]);
});
t("sanitizeCity garante JSON <= 2KB (poda types/marcos)", () => {
  const types = {}; for (let i = 0; i < 400; i++) types["t" + i] = i;
  const marcos = []; for (let i = 0; i < 400; i++) marcos.push("m" + i);
  const c = placar.sanitizeCity({ seed: 1, buildings: 9, pop: 9, types, marcos, era: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 2048, "bytes=" + Buffer.byteLength(JSON.stringify(c)));
});

// ---------------------------------------------------------------- collectSetup (setup → cidade, Fase 1)
// Monta o blob { v:1, skills, mcp, hooks, tools, models }. FEEDBACK DA MEL: skills e mcp
// agora vêm do USO REAL na temporada, não do que está instalado/configurado:
//   skills = frequência de invocações da tool `Skill` (skillTally);
//   mcp    = servidores das ferramentas mcp__<server>__* chamadas (derivado do toolTally);
//   hooks  = chaves de settings.hooks (best-effort); tools/models = tallies da temporada.
// Tudo injetável no teste. Slugs [a-z0-9-]; caps 40/20/12/10/6; degrada gracioso pra [].
const SETUP_TMP = path.join(os.tmpdir(), "tt-setup-" + process.pid);
// skills/mcp agora vêm dos TALLIES (uso real), então a fixture só precisa do settings.json
// (hooks). Devolve { settingsJson }.
function mkSetupFixture(spec) {
  fs.rmSync(SETUP_TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(SETUP_TMP, ".claude"), { recursive: true });
  const settingsJson = path.join(SETUP_TMP, ".claude", "settings.json");
  const sj = {};
  if (spec.hooks) { sj.hooks = {}; for (const h of spec.hooks) sj.hooks[h] = [{}]; }
  fs.writeFileSync(settingsJson, JSON.stringify(sj));
  return { settingsJson: settingsJson };
}

t("collectSetup monta o shape do contrato (skills/mcp de USO REAL; hooks/tools/models)", () => {
  const f = mkSetupFixture({ hooks: ["Stop", "PostToolUse"] });
  const skillTally = new Map([["copy-mel", 6], ["flow-broll-palmier", 2]]); // usadas (freq)
  const toolTally = new Map([["Bash", 316], ["Edit", 388], ["Agent", 2],
    ["mcp__palmier-pro__list", 40], ["mcp__claude-in-chrome__computer", 207]]); // mcp por uso
  const modelTally = new Map([["opus-4-8", 750], ["fable-5", 244], ["haiku-4-5", 6]]);
  const s = m.collectSetup({ settingsJson: f.settingsJson,
    skillTally: skillTally, toolTally: toolTally, modelTally: modelTally });
  assert.strictEqual(s.v, 1);
  assert.deepStrictEqual(s.skills, ["copy-mel", "flow-broll-palmier"]); // por frequência desc (6 > 2)
  assert.deepStrictEqual(s.mcp, ["claude-in-chrome", "palmier-pro"]);   // por frequência desc (207 > 40)
  assert.deepStrictEqual(s.hooks, ["stop", "posttooluse"]); // slug [a-z0-9-]
  assert.deepStrictEqual(s.tools[0], ["Edit", 388]);         // ordenado por contagem desc
  assert.deepStrictEqual(s.tools[1], ["Bash", 316]);
  assert.strictEqual(s.models[0][0], "opus-4-8");            // fração dominante primeiro
  const sum = s.models.reduce((a, p) => a + p[1], 0);
  assert.ok(Math.abs(sum - 1) < 0.01, "frações não normalizam p/ ~1: " + sum);
});
t("collectSetup: mcp deriva de ferramentas mcp__server__* USADAS (agrega por servidor, dedup, ordena por freq)", () => {
  const toolTally = new Map([
    ["mcp__a-server__toolX", 5], ["mcp__a-server__toolY", 3], // a-server = 8 no total
    ["mcp__b-server__z", 10], ["Bash", 100]]);               // Bash não é mcp
  const s = m.collectSetup({ settingsJson: null,
    skillTally: new Map(), toolTally: toolTally, modelTally: new Map() });
  assert.deepStrictEqual(s.mcp, ["b-server", "a-server"]); // b(10) > a(8); cada servidor 1x
});
t("collectSetup: palmier-pro só configurado (0 uso) NÃO entra; usado ENTRA (só-quando-usado)", () => {
  // nenhuma tool mcp__palmier-pro__* na temporada -> palmier-pro fora; claude-in-chrome usado -> dentro
  const usadoSo = new Map([["mcp__claude-in-chrome__computer", 3]]);
  const s = m.collectSetup({ settingsJson: null, skillTally: new Map(), toolTally: usadoSo, modelTally: new Map() });
  assert.deepStrictEqual(s.mcp, ["claude-in-chrome"]);
  assert.strictEqual(s.mcp.indexOf("palmier-pro"), -1);
});
t("collectSetup aplica os caps (skills≤40, mcp≤20, hooks≤12, tools≤10, models≤6)", () => {
  const skillTally = new Map(), toolTally = new Map(), modelTally = new Map();
  for (let i = 0; i < 50; i++) skillTally.set("skill-" + i, 100 - i);            // 50 skills usadas
  for (let i = 0; i < 30; i++) toolTally.set("mcp__mcp-" + i + "__t", 100 - i);  // 30 servidores mcp usados
  for (let i = 0; i < 25; i++) toolTally.set("Tool" + i, 100 - i);              // + tools normais
  for (let i = 0; i < 12; i++) modelTally.set("model-" + i, 1000 - i * 10);
  const hooks = []; for (let i = 0; i < 20; i++) hooks.push("hook" + i);
  const f = mkSetupFixture({ hooks: hooks });
  const s = m.collectSetup({ settingsJson: f.settingsJson,
    skillTally: skillTally, toolTally: toolTally, modelTally: modelTally });
  assert.strictEqual(s.skills.length, 40);
  assert.strictEqual(s.mcp.length, 20);
  assert.strictEqual(s.hooks.length, 12);
  assert.strictEqual(s.tools.length, 10);
  assert.strictEqual(s.models.length, 6);
  assert.strictEqual(s.skills[0], "skill-0"); // maior frequência primeiro
  assert.strictEqual(s.mcp[0], "mcp-0");
});
t("collectSetup degrada gracioso sem uso/paths (skills/mcp/hooks/tools/models = [])", () => {
  const s = m.collectSetup({ settingsJson: "/no/such/settings.json",
    skillTally: new Map(), toolTally: new Map(), modelTally: new Map() });
  assert.strictEqual(s.v, 1);
  assert.deepStrictEqual(s.skills, []);
  assert.deepStrictEqual(s.mcp, []);
  assert.deepStrictEqual(s.hooks, []);
  assert.deepStrictEqual(s.tools, []);
  assert.deepStrictEqual(s.models, []);
});
t("collectSetup: settings sem chave hooks -> hooks [] (caso real da Mel); skills/mcp de uso real", () => {
  const f = mkSetupFixture({}); // sem hooks
  const s = m.collectSetup({ settingsJson: f.settingsJson,
    skillTally: new Map([["copy-mel", 3]]),
    toolTally: new Map([["mcp__palmier-pro__x", 5]]), modelTally: new Map() });
  assert.deepStrictEqual(s.hooks, []);
  assert.deepStrictEqual(s.skills, ["copy-mel"]);
  assert.deepStrictEqual(s.mcp, ["palmier-pro"]); // aqui palmier-pro FOI usado -> entra
});
t("collectSetup: <synthetic> não é fonte de energia (fora dos models)", () => {
  const modelTally = new Map([["opus-4-8", 100]]); // normModelSlug já filtra <synthetic> no tally
  assert.strictEqual(m.normModelSlug("<synthetic>"), null);
  assert.strictEqual(m.normModelSlug("claude-opus-4-8[1m]"), "opus-4-8");
  const s = m.collectSetup({ settingsJson: null,
    skillTally: new Map(), toolTally: new Map(), modelTally: modelTally });
  assert.deepStrictEqual(s.models, [["opus-4-8", 1]]);
});
t("skills/mcp de USO REAL: readNew tallia por id do bloco tool_use (mesmo em linha SEM usage-count)", () => {
  const F = path.join(os.tmpdir(), "tt-skilluse-" + process.pid + ".jsonl");
  m.seenUsage.clear(); m.seenTools.clear(); m.offsets.delete(F); m.skillTally.clear(); m.toolTally.clear();
  // 2 linhas com o MESMO mid:rid (streaming): a 1ª (dedupe de usage CONTA) tem só texto; a
  // 2ª (dedupe de usage DESCARTA) traz o tool_use Skill + um mcp__server__tool. Antes o tally
  // via usage PERDIA a 2ª; agora tallyTools (por id do bloco) conta ambos.
  const L1 = JSON.stringify({ timestamp: "2026-07-10T00:00:00Z", requestId: "req_sk",
    message: { id: "msg_sk", model: "claude-opus-4-8", role: "assistant",
      usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "vou usar a skill" }] } });
  const L2 = JSON.stringify({ timestamp: "2026-07-10T00:00:00Z", requestId: "req_sk",
    message: { id: "msg_sk", model: "claude-opus-4-8", role: "assistant",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", name: "Skill", id: "toolu_sk", input: { skill: "copy-mel", args: "..." } },
                { type: "tool_use", name: "mcp__palmier-pro__list", id: "toolu_mcp", input: {} }] } });
  fs.writeFileSync(F, L1 + "\n" + L2 + "\n");
  m.readNew(F);
  assert.strictEqual(m.skillTally.get("copy-mel"), 1);              // skill invocada (linha deduplicada por usage)
  assert.strictEqual(m.toolTally.get("mcp__palmier-pro__list"), 1); // mcp invocado idem
  m.skillTally.clear(); m.toolTally.clear(); m.seenTools.clear();
  fs.unlinkSync(F);
});

// ---------------------------------------------------------------- shapeSetup (sanitização leve do cliente)
t("shapeSetup: rejeita não-objeto e v!=1", () => {
  assert.strictEqual(placar.shapeSetup(null), undefined);
  assert.strictEqual(placar.shapeSetup({ v: 2, skills: [] }), undefined);
});
t("shapeSetup: sluga skills/mcp/hooks (dedup) e preserva nomes de tools", () => {
  const s = placar.shapeSetup({ v: 1, skills: ["Copy Mel", "copy-mel"], mcp: ["Palmier Pro"],
    hooks: ["PostToolUse"], tools: [["mcp__claude-in-chrome__computer", 207], ["Bash", 316]],
    models: [["opus-4-8", 0.75]] });
  assert.deepStrictEqual(s.skills, ["copy-mel"]);                 // "Copy Mel" -> "copy-mel", dedup
  assert.deepStrictEqual(s.mcp, ["palmier-pro"]);
  assert.deepStrictEqual(s.hooks, ["posttooluse"]);
  assert.deepStrictEqual(s.tools[0], ["mcp__claude-in-chrome__computer", 207]); // preserva _ e caixa
  assert.deepStrictEqual(s.models, [["opus-4-8", 0.75]]);
});
t("shapeSetup: contagens negativas/fora de faixa saneadas; frac clampada a [0,1]", () => {
  const s = placar.shapeSetup({ v: 1, skills: [], mcp: [], hooks: [],
    tools: [["Bash", -5], ["Edit", 3]], models: [["opus-4-8", 1.5], ["fable-5", -0.2], ["haiku-4-5", 0.3]] });
  assert.deepStrictEqual(s.tools, [["Edit", 3]]);        // -5 descartada (não > 0)
  assert.deepStrictEqual(s.models, [["opus-4-8", 1], ["haiku-4-5", 0.3]]); // 1.5->1, -0.2 fora
});
t("shapeSetup: descarta o setup inteiro se o JSON passar de ~3KB", () => {
  const big = (fill, i) => (String(i).padStart(4, "0") + fill.repeat(36)).slice(0, 40);
  const skills = [], mcp = [], hooks = [];
  for (let i = 0; i < 40; i++) skills.push(big("z", i));
  for (let i = 0; i < 20; i++) mcp.push(big("y", i));
  for (let i = 0; i < 12; i++) hooks.push(big("x", i));
  assert.strictEqual(placar.shapeSetup({ v: 1, skills: skills, mcp: mcp, hooks: hooks, tools: [], models: [] }), undefined);
});

// ---------------------------------------------------------------- reporter: setup só com shareSetup (opt-in)
// O reporter relê o config a cada report; `setup` só entra no POST se shareSetup:true.
// Captura o corpo do POST substituindo o fetch global (o send é fire-and-forget num
// microtask, então damos um flush com setImmediate antes de checar).
async function captureReport(cfgObj, snapshot) {
  const CFGP = path.join(os.tmpdir(), "tt-cfg-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".json");
  fs.writeFileSync(CFGP, JSON.stringify(cfgObj));
  const reporter = placar.createReporter({ configPath: CFGP });
  let captured = null;
  const origFetch = global.fetch;
  global.fetch = (_url, opts) => { try { captured = JSON.parse(opts.body); } catch (_e) {} return Promise.resolve({ ok: true }); };
  reporter.report(snapshot);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  global.fetch = origFetch;
  try { fs.unlinkSync(CFGP); } catch (_e) {}
  return captured;
}
const SETUP_BLOB = { v: 1, skills: ["copy-mel"], mcp: ["palmier-pro"], hooks: [], tools: [["Bash", 10]], models: [["opus-4-8", 1]] };
const BASE_CFG = { enabled: true, username: "mel", key: "k".repeat(48), url: "http://localhost:3000/api/report" };
const SNAP = { seasonId: 0, tokens: 100, cost: 0.5, residents: 1, buildings: 3, setup: SETUP_BLOB };

async function reporterTests() {
  const withOn = await captureReport(Object.assign({}, BASE_CFG, { shareSetup: true }), SNAP);
  t("reporter INCLUI setup quando shareSetup:true", () => {
    assert.ok(withOn && withOn.setup, "setup ausente no POST");
    assert.strictEqual(withOn.setup.v, 1);
    assert.deepStrictEqual(withOn.setup.skills, ["copy-mel"]);
    assert.deepStrictEqual(withOn.setup.tools, [["Bash", 10]]);
    assert.strictEqual(withOn.tokens, 100); // o report normal continua saindo
  });
  const withOff = await captureReport(Object.assign({}, BASE_CFG, { shareSetup: false }), SNAP);
  t("reporter NÃO inclui setup quando shareSetup:false (default off)", () => {
    assert.ok(withOff, "não postou nada");
    assert.strictEqual(withOff.setup, undefined);
    assert.strictEqual(withOff.tokens, 100);
  });
  const noSetup = await captureReport(Object.assign({}, BASE_CFG, { shareSetup: true }),
    { seasonId: 0, tokens: 5, cost: 0, residents: 0, buildings: 2 });
  t("reporter com shareSetup:true mas sem snapshot.setup não quebra e omite setup", () => {
    assert.ok(noSetup);
    assert.strictEqual(noSetup.setup, undefined);
  });

  // BREAKDOWN DIÁRIO no POST (independente de shareSetup — vai sempre que houver).
  const withDaily = await captureReport(Object.assign({}, BASE_CFG),
    { seasonId: 0, tokens: 100, cost: 0.5, residents: 1, buildings: 3,
      dailyTokens: { "20260713": 40, "20260712": 30, "notaday": 9, "20260711": 0 } });
  t("reporter INCLUI dailyTokens (só chaves AAAAMMDD, valor > 0)", () => {
    assert.ok(withDaily && withDaily.dailyTokens, "dailyTokens ausente no POST");
    assert.strictEqual(withDaily.dailyTokens["20260713"], 40);
    assert.strictEqual(withDaily.dailyTokens["20260712"], 30);
    assert.strictEqual(withDaily.dailyTokens["notaday"], undefined); // chave inválida
    assert.strictEqual(withDaily.dailyTokens["20260711"], undefined); // 0 descartado
    assert.strictEqual(withDaily.tokens, 100); // o report normal continua saindo
  });
  const noDaily = await captureReport(Object.assign({}, BASE_CFG),
    { seasonId: 0, tokens: 5, cost: 0, residents: 0, buildings: 2 });
  t("reporter sem dailyTokens omite o campo (servidor preserva)", () => {
    assert.ok(noDaily);
    assert.strictEqual(noDaily.dailyTokens, undefined);
  });
}

reporterTests().then(() => {
  fs.rmSync(SETUP_TMP, { recursive: true, force: true });
  console.log("\n" + (total - fails) + "/" + total + " passaram" + (fails ? " — " + fails + " FALHARAM" : ""));
  process.exit(fails ? 1 : 0);
}).catch((e) => {
  console.log("\nERRO nos testes async do reporter: " + (e && e.stack || e));
  process.exit(1);
});
