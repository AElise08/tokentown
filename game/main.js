// TOKENTOWN — janela flutuante sempre-no-topo que lê o uso REAL de tokens do Claude Code.
const { app, BrowserWindow, screen, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Placar web (opcional, DESLIGADO por padrão) — reporta só números da temporada.
// Ativar em ~/.tokentown-placar.json: {enabled:true, username:"...", url:"https://.../api/report"}.
// Falha de rede nunca quebra o app (tratado dentro do módulo).
const { createReporter } = require('./placar');
const reporter = createReporter({ configPath: path.join(os.homedir(), '.tokentown-placar.json') });

// ---------------------------------------------------------------------------
// TEMPORADAS — janelas fixas de 28 dias por CALENDÁRIO GLOBAL (não por abertura).
// ÉPOCA: 01/07/2026, quando o jogo nasceu → hoje (12/07/2026) = T0 (faltam 17 dias).
// A MESMA fórmula roda no placar web — mantenha estas 3 linhas em sincronia lá:
//   const SEASON_EPOCH = Date.UTC(2026, 6, 1);   // 01/07/2026 00:00 UTC
//   const SEASON_MS    = 28 * 86400000;          // 28 dias em ms
//   const seasonId     = Math.floor((Date.now() - SEASON_EPOCH) / SEASON_MS);
// ---------------------------------------------------------------------------
const SEASON_EPOCH = Date.UTC(2026, 6, 1);
const SEASON_MS = 28 * 86400000;
const TOK_PER_BUILD_REAL = 6000; // igual ao renderer — usado só pra arquivar nº de prédios

function currentSeasonId(now) { return Math.floor(((now || Date.now()) - SEASON_EPOCH) / SEASON_MS); }
function daysLeftIn(now) {
  now = now || Date.now();
  const end = SEASON_EPOCH + (currentSeasonId(now) + 1) * SEASON_MS;
  return Math.max(0, Math.ceil((end - now) / 86400000));
}

// LÓGICA PURA de boot (testável em node puro, sem Electron): dado o estado salvo
// em disco e o instante atual, decide RETOMAR a temporada (mesmo seasonId) ou
// ARQUIVAR a anterior em history e zerar os contadores da temporada nova.
function computeBoot(disk, now) {
  const sid = currentSeasonId(now);
  // ÉPOCA NOVA (01/07/2026): um state salvo com seasonId MAIOR que o atual só pode
  // ter vindo de uma época antiga, onde hoje cairia numa temporada bem à frente. Isso
  // não é histórico legítimo — era tudo teste de hoje. Descarta LIMPO (zera contadores
  // E history, SEM arquivar) e recomeça a T0 do zero.
  if (disk && typeof disk.seasonId === 'number' && disk.seasonId > sid) {
    return { seasonId: sid, tokens: 0, costUSD: 0, residents: 0, history: [], archived: false, discarded: true };
  }
  let hist = (disk && Array.isArray(disk.history)) ? disk.history.slice() : [];
  if (disk && disk.seasonId === sid) {
    return { seasonId: sid, tokens: disk.tokens || 0, costUSD: disk.costUSD || 0,
             residents: disk.residents || 0, history: hist, archived: false };
  }
  let archived = false;
  if (disk && ((disk.tokens || 0) || (disk.residents || 0) || (disk.costUSD || 0))) {
    hist.push({ seasonId: disk.seasonId, tokens: disk.tokens || 0, costUSD: disk.costUSD || 0,
                residents: disk.residents || 0,
                buildings: 2 + Math.floor((disk.tokens || 0) / TOK_PER_BUILD_REAL) });
    if (hist.length > 60) hist = hist.slice(-60); // guarda no máx. as 60 últimas
    archived = true;
  }
  return { seasonId: sid, tokens: 0, costUSD: 0, residents: 0, history: hist, archived: archived };
}

// ---------------------------------------------------------------------------
// PREÇOS — USD por 1M tokens. Fonte: skill claude-api (cache: 2026-06-24).
// input = entrada não-cacheada; output = saída.
// Cache: multiplicadores sobre o preço de INPUT (fonte: skill prompt-caching.md):
//   leitura de cache = 0,10x ; escrita 5min = 1,25x ; escrita 1h = 2,00x.
// Opus 4.8 tem janela de 1M no preço padrão (sem premium de contexto longo),
// então o sufixo "[1m]" usa a mesma tabela.
// ---------------------------------------------------------------------------
const PRICING = {
  'claude-opus-4-8':   { in: 5,  out: 25 },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-opus-4-5':   { in: 5,  out: 25 },
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-mythos-5':   { in: 10, out: 50 },
  'claude-sonnet-5':   { in: 3,  out: 15 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-sonnet-4-5': { in: 3,  out: 15 },
  'claude-haiku-4-5':  { in: 1,  out: 5 },
};
const SONNET_PRICE = { in: 3, out: 15 }; // modelo desconhecido -> aproxima por Sonnet

function priceFor(model) {
  if (!model) return SONNET_PRICE;
  let m = String(model).toLowerCase();
  if (m === '<synthetic>') return { in: 0, out: 0 }; // mensagem local, sem custo de API
  m = m.replace(/\[1m\]$/, '');   // remove marcador de contexto longo
  m = m.replace(/-\d{8}$/, '');   // remove sufixo de data (ex.: -20251001)
  if (PRICING[m]) return PRICING[m];
  if (m === 'opus'   || m.startsWith('claude-opus'))   return { in: 5,  out: 25 };
  if (m === 'fable'  || m.startsWith('claude-fable') || m.startsWith('claude-mythos')) return { in: 10, out: 50 };
  if (m === 'sonnet' || m.startsWith('claude-sonnet')) return { in: 3,  out: 15 };
  if (m === 'haiku'  || m.startsWith('claude-haiku'))  return { in: 1,  out: 5 };
  return SONNET_PRICE;
}

// tokens "reais" que fazem os prédios subirem: o que o modelo gera de novo
// (entrada não-cacheada + saída + contexto novo escrito no cache).
// Ignora cache_read (releitura barata e gigante — inflaria o CRESCIMENTO da cidade).
function tokensFromUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// custo em USD de UMA linha de usage — considera TODOS os campos (input, output,
// escrita de cache e leitura de cache), diferente do número de tokens da cidade.
function costFromUsage(u, model) {
  if (!u) return 0;
  const p = priceFor(model);
  if (!p.in && !p.out) return 0; // <synthetic>
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const readTok = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation;
  let w5 = 0, w1 = 0; // escrita de cache: 5min vs 1h
  if (cc && ((cc.ephemeral_1h_input_tokens || 0) + (cc.ephemeral_5m_input_tokens || 0)) > 0) {
    w1 = cc.ephemeral_1h_input_tokens || 0;
    w5 = cc.ephemeral_5m_input_tokens || 0;
  } else {
    w5 = u.cache_creation_input_tokens || 0; // sem detalhamento -> trata como 5min (1,25x)
  }
  const usd = (
    inTok   * p.in +
    outTok  * p.out +
    readTok * p.in * 0.10 +
    w5      * p.in * 1.25 +
    w1      * p.in * 2.00
  ) / 1e6;
  return usd;
}

// ---------------------------------------------------------------------------
// BREAKDOWN DIÁRIO (heatmap "CITY LIGHTS · THIS WEEK") — além do total da temporada,
// o app bucketiza os tokens da cidade (MESMO sinal, MESMO dedupe) por DIA UTC dos
// últimos 7 dias UTC (inclui hoje). O placar recebe isso em `dailyTokens` e desenha a
// semana REAL — antes o registro diário só começava "agora" e só HOJE acendia.
// Funções PURAS (testáveis em node): chave de dia UTC, início da janela e bucketização.
// ---------------------------------------------------------------------------
const DAILY_WINDOW_DAYS = 7;
const DAY_MS = 86400000;

// chave AAAAMMDD (UTC) de um instante em ms — MESMO formato do placar (utcDayKey).
function utcDayKeyMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return '' + y + mo + da;
}
// meia-noite UTC (ms) do dia que contém `ms`.
function utcMidnightMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
// início (meia-noite UTC, ms) do dia mais ANTIGO da janela de DAILY_WINDOW_DAYS dias
// terminando em `now` (inclui hoje). Ex.: hoje 13/07 -> 07/07 00:00 UTC.
function dailyWindowStartMs(now) {
  return utcMidnightMs(now) - (DAILY_WINDOW_DAYS - 1) * DAY_MS;
}
// bucketiza entradas {ts, tokens} (ts em ms UTC) por DIA UTC, SÓ dentro da janela de 7
// dias. Entradas fora da janela ou sem ts finito são descartadas. Devolve {AAAAMMDD:int}.
// PURA: o dedupe é responsabilidade de quem monta as entradas (só passa linhas contadas).
function dailyBucketize(entries, now) {
  const startMs = dailyWindowStartMs(now);
  const out = {};
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (!e || !Number.isFinite(e.ts)) continue;
    if (e.ts < startMs) continue; // fora da janela de 7 dias
    const k = utcDayKeyMs(e.ts);
    out[k] = (out[k] || 0) + (Number(e.tokens) || 0);
  }
  return out;
}
// soma `tokens` ao bucket de HOJE (UTC) e PODA chaves fora da janela de 7 dias. Usado no
// caminho INCREMENTAL (linhas novas são ~agora): mantém o bucket de hoje vivo entre polls
// sem re-varrer tudo. PURA (opera sobre o objeto passado). Devolve o próprio map.
function addDailyTokens(map, now, tokens) {
  if (!map || typeof map !== 'object') return map;
  const k = utcDayKeyMs(now);
  map[k] = (map[k] || 0) + (Number(tokens) || 0);
  const startMs = dailyWindowStartMs(now);
  for (const key of Object.keys(map)) {
    if (!/^\d{8}$/.test(key)) { delete map[key]; continue; }
    const y = +key.slice(0, 4), mo = +key.slice(4, 6), da = +key.slice(6, 8);
    if (Date.UTC(y, mo - 1, da) < startMs) delete map[key]; // dia caiu pra fora da janela
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deduplicação — o Claude Code grava a MESMA mensagem assistant em várias linhas
// (streaming/retry), cada uma com usage IGUAL. Contar cada linha duplica tudo.
// Set com limite de memória (cap ~5000, descarte FIFO simples) — o app roda horas.
// ---------------------------------------------------------------------------
const USAGE_CAP = 5000;
const AGENT_CAP = 5000;
const TOOLS_CAP = 20000;
const seenUsage = new Set();  // chave = `${message.id}:${requestId}`
const seenAgents = new Set(); // chave = id do bloco tool_use do subagente
// dedupe de INVOCAÇÕES de ferramenta p/ o setup (tools/skills/mcp), pelo id do bloco
// tool_use — NÃO pelo dedupe de usage. O Claude Code grava a MESMA mensagem assistant em
// várias linhas (streaming): o dedupe de usage (mid:rid) conta os TOKENS 1x, mas o bloco
// tool_use costuma cair numa linha DESCARTADA por esse dedupe, então contar tool via usage
// PERDE invocações (ex.: Skill/mcp de outras sessões). Dedupe pelo id do bloco conta cada
// invocação 1x — inclusive espelhada em subagents/ — igual ao countNewSubagents.
const seenTools = new Set();

// devolve true se a chave é NOVA (deve contar); false se já vista.
function remember(set, key, cap) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > cap) { const first = set.values().next().value; set.delete(first); }
  return true;
}

// subagentes = blocos tool_use chamados "Agent" (ou "Task", nome antigo),
// deduplicados pelo id do bloco. Devolve quantos são NOVOS.
function countNewSubagents(o) {
  const c = o && o.message && o.message.content;
  let k = 0;
  if (Array.isArray(c)) for (const b of c) {
    if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
      if (b.id != null) { if (remember(seenAgents, b.id, AGENT_CAP)) k++; }
      else k++; // sem id -> conta direto
    }
  }
  return k;
}

function listJsonl(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, acc);
    else if (e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

const offsets = new Map(); // arquivo -> bytes já lidos
let seasonTokens = 0;      // tokens da TEMPORADA atual (acumulam entre aberturas)
let costUSD = 0;           // custo (USD) da temporada atual
let subagents = 0;         // moradores (subagentes) da temporada atual
let lastActivity = 0;      // último crescimento GLOBAL (qualquer arquivo) — só decide o eixo live<->idle
let lastGrewJsonl = null;  // último ~/.claude/projects/**/*.jsonl (NÃO-subagente) que cresceu
// SILÊNCIO POR-TRANSCRIPT (FIX do bug multi-agente): arquivo monitorado -> instante do
// último crescimento DELE (ms). Antes só existia o `lastActivity` GLOBAL, resetado por
// crescimento de QUALQUER arquivo; com vários subagentes escrevendo, o silêncio global
// nunca acumulava e a 'decisão' do principal (ou de um subagente) ficava mascarada como
// 'live'. Agora cada transcript tem o silêncio DELE (ver silenceForFile + combineShapes).
const activityByFile = new Map();
let tailShapesCache = null; // shapes CRUS do tail {mainShape, mainFile, others:[{shape,file}]} por ESTIRÃO (limpo a cada crescimento)
let seasonId = currentSeasonId(); // temporada corrente (recalculada no loadState)
let history = [];          // resumos de temporadas passadas
let dirty = false;         // há mudança de contadores ainda não gravada?
let lastCity = null;       // último snapshot da cidade vindo do renderer (p/ o placar)
// BREAKDOWN DIÁRIO da temporada: { AAAAMMDD(UTC): tokens da cidade } dos últimos 7 dias
// UTC. Reconstruído do zero pelo backfill (verdade da temporada, mesmo dedupe) e somado
// incrementalmente por poll (bucket de hoje); zerado no rollover. Vai em `dailyTokens` no
// POST do placar -> o heatmap "CITY LIGHTS · THIS WEEK" desenha a semana REAL.
let lastDaily = {};

// SETUP → CIDADE (Fase 1): tallies POR TEMPORADA reusados pela leitura de tokens.
//  • toolTally: nome de tool_use (Bash/Edit/Agent/mcp__…) -> contagem — vira as
//    "indústrias" (top 10) do setup.
//  • modelTally: modelo normalizado -> tokens da cidade — vira as "fontes de
//    energia" (frações, top 6). Peso = tokensFromUsage (o MESMO sinal que faz os
//    prédios subirem), pra coerência com "tokens = cidade".
// Ambos são reconstruídos do zero pelo backfill (verdade da temporada) e somados
// incrementalmente por readNew; zerados no rollover de temporada.
const toolTally = new Map();
const modelTally = new Map();
// SKILLS REALMENTE USADAS (não as instaladas): nome da skill -> nº de invocações da
// tool `Skill` na temporada. Reconstruído do zero pelo backfill e somado por readNew;
// zerado no rollover — mesmo ciclo de toolTally/modelTally. Vira a lista de skills do
// setup (feedback da Mel: mostrar o stack VIVO, não ~/.claude/skills inteiro).
const skillTally = new Map();
let lastSetup = null;      // último setup coletado (mandado ao renderer SEMPRE + ao placar se shareSetup)

// ---------------------------------------------------------------------------
// LIVENESS ("ao vivo") — FIX: antes marcávamos atividade SÓ quando chegavam TOKENS
// novos (linhas usage) e considerávamos ocioso após 9s. Isso dava falso "o agente
// terminou" em dois cenários: (a) ferramenta demorada (Bash longo) — o transcript só
// recebe linhas tool_result SEM usage; (b) SUBAGENTES em background — o transcript
// principal fica em silêncio esperando o subagente.
//
// EVIDÊNCIA (colhida NESTA máquina em 12/07/2026 — ver relatório):
//  • Os transcripts de subagente vivem em
//    /private/tmp/claude-<uid>/<slug>/<sessão>/tasks/<agentId>.output (JSONL).
//  • PORÉM o MESMO conteúdo é ESPELHADO dentro de ~/.claude/projects, na subpasta
//    ~/.claude/projects/<slug>/<sessão>/subagents/agent-<agentId>.jsonl.
//  • Comparei somas de usage (dedupe message.id:requestId) de 3 pares
//    tasks/*.output ⇄ subagents/*.jsonl — TOKENS e Nº DE LINHAS IDÊNTICOS
//    (322165/25, 100293/12, 238618/49); size e mtime também batem.
//  ⇒ O usage dos subagentes JÁ APARECE em ~/.claude/projects (subpasta subagents/),
//    e o listJsonl() abaixo RECORRE nessa subpasta → os tokens/custo dos subagentes
//    JÁ SÃO CONTADOS pelo backfill e pela leitura incremental. Portanto:
//      – NÃO contamos tasks/*.output para tokens (duplicaria) e NÃO mexemos no backfill.
//      – Usamos tasks/*.output SÓ como SINAL DE ATIVIDADE: o .output cresce ao vivo
//        durante a execução do subagente (o espelho em projects pode ser gravado em
//        lote no fim), então é a fonte de liveness mais fresca.
//
// live = houve QUALQUER crescimento de bytes num arquivo monitorado nos últimos ~15s:
//   • qualquer linha nova em ~/.claude/projects/**/*.jsonl — INCLUI tool_result SEM
//     usage (cenário a) e o espelho dos subagentes (cenário b); detectado via readNew
//     (campo `grew` = ganhou bytes), OU
//   • crescimento de qualquer tasks/*.output das sessões da Mel — detectado por stat
//     de tamanho (barato, sem parsear os .output).
// ---------------------------------------------------------------------------
// IDLE_MS 45s→15s (a Mel achava a reação LENTA demais). SEGURO reduzir: 'idle' já
// exige o tail mostrar FIM-DE-TURNO real (assistant end_turn); "pensando" (tail =
// user / tool_result) segue 'live' até THINK_MS, então thinking longo NUNCA vira idle
// a 15s (ver resolveState + teste do Mulling). 15s = turno realmente fechado.
const IDLE_MS = 15000;
const taskSizes = new Map(); // tasks/*.output -> último tamanho visto (só p/ liveness)

// ---------------------------------------------------------------------------
// ESTADO 3-VIAS ('live' | 'decision' | 'idle') — FIX: quando o Claude Code pede
// AUTORIZAÇÃO (permissão de ferramenta, AskUserQuestion), o agente NÃO terminou —
// está esperando a MEL. Antes o app esperava 45s e mostrava "o agente terminou"
// (mentira). Agora, quando o transcript para de crescer, olhamos o SHAPE do tail.
//
// EVIDÊNCIA (colhida NESTA máquina em 12/07/2026, ~80 sessões em ~/.claude/projects):
//  • REJEIÇÃO de ferramenta (a Mel disse "não"): a linha assistant tem UM bloco
//    tool_use (ex.: {type:'tool_use',name:'Bash',id:'toolu_01WfWTsF…'}) e a resposta
//    vem numa linha user posterior com toolUseResult:true e content
//    [{type:'tool_result',tool_use_id:<mesmo id>,is_error:true,content:"The user
//    doesn't want to proceed with this tool use…"}]. Enquanto a Mel decide, NADA é
//    gravado entre o tool_use e o tool_result — 41 casos medidos, espera de 0,1s a
//    minutos (mediana ~11,6s). AskUserQuestion idem (espera observada de 99s).
//    ⇒ "última mensagem assistant tem tool_use SEM tool_result correspondente
//      depois" + arquivo parado = AGUARDANDO A HUMANA ('decision').
//  • FIM DE TURNO NORMAL: cada linha assistant carrega message.stop_reason; TODAS
//    as linhas de um turno com ferramenta têm stop_reason:'tool_use' (11.486
//    linhas) e o turno FINAL tem 'end_turn' (1.011) / 'stop_sequence' (18).
//    Das ~80 sessões, 59 terminam em assistant end_turn ⇒ turno fechado = 'idle'.
//  • "PENSANDO": se a última linha conversacional é user (prompt novo ou
//    tool_result recém-chegado) sem assistant completa depois, o modelo DEVE uma
//    resposta — está pensando/gerando ⇒ 'live' mesmo sem crescimento. EXCEÇÃO
//    medida: ESC grava user text "[Request interrupted by user]" (9 sessões
//    terminam assim) — interrupção = turno abortado ⇒ 'idle'. E sessões
//    abandonadas no prompt (5 casos "pesquisa sobre paris"…) ⇒ cap THINK_MS:
//    pensar sem gravar NADA por >10min não é pensar, é sessão morta ⇒ 'idle'.
//  • SUBAGENTES/TASKS: o transcript principal NÃO tem linhas isSidechain inline
//    (0 de 28.182 amostradas) — o espelho fica em subagents/agent-*.jsonl (pode
//    ser gravado em lote no fim). Um tool_use Agent/Task pendente no principal
//    significa "subagente rodando" (liveness vem de tasks/*.output), NÃO decisão
//    ⇒ Agent/Task pendente = 'live', nunca 'decision'. E o "transcript ativo"
//    ignora subagents/ (o shape que importa é o da conversa da Mel).
//  • A última linha bruta do arquivo é quase sempre METADADO sem message.role
//    (type=last-prompt 52x, permission-mode 13x, mode/ai-title/queue-operation…)
//    ⇒ o parser pula linhas não-conversacionais.
//
// CUSTO: o tail (últimos ~64KB) só é parseado quando o silêncio passa de
// DECISION_MS (não a cada poll) e o resultado fica CACHEADO até o próximo
// crescimento — o arquivo parado não muda de shape, então 1 parse por estirão.
// ---------------------------------------------------------------------------
const DECISION_MS = 4000;       // 10s→4s: silêncio p/ olhar o tail; principal c/ tool_use pendente = permissão dela -> 'decision' rápido
const THINK_MS = 30 * 60000;    // "pensando" sem gravar nada além disso = sessão abandonada
const RECENT_MS = 30 * 60000;   // um transcript conta como "ativo agora" se cresceu nos últimos 30min
const SUB_DECISION_MS = 22000;  // 90s→22s: silêncio GLOBAL mínimo p/ subagente c/ tool_use pendente virar 'decision' (ver combineShapes + evidência abaixo)
const TAIL_BYTES = 64 * 1024;   // lê só o fim do transcript (barato)
const AGENT_TOOLS = { Agent: true, Task: true }; // pendente => subagente rodando, não decisão

// lê as últimas linhas COMPLETAS (~64KB) de um .jsonl e devolve os objetos parseados.
function readTailLines(f) {
  if (!f) return [];
  let size, fd;
  try { size = fs.statSync(f).size; } catch (e) { return []; }
  const start = Math.max(0, size - TAIL_BYTES);
  let buf;
  try {
    fd = fs.openSync(f, 'r');
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
  } catch (e) { try { if (fd != null) fs.closeSync(fd); } catch (e2) {} return []; }
  let txt = buf.toString('utf8');
  if (start > 0) { const i = txt.indexOf('\n'); txt = i < 0 ? '' : txt.slice(i + 1); } // descarta a linha cortada
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) {} // linha parcial no fim -> ignora
  }
  return out;
}

function contentBlocks(o) {
  const c = o && o.message && o.message.content;
  return Array.isArray(c) ? c : [];
}
function userText(o) { // texto de uma linha user (string ou blocos text concatenados)
  const c = o && o.message && o.message.content;
  if (typeof c === 'string') return c;
  let s = '';
  if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text') s += (b.text || '');
  return s;
}

// SHAPE do tail -> 'decision' | 'live' | 'idle'. Função PURA (testável em node).
function tailShape(lines) {
  if (!lines || !lines.length) return 'idle';
  // ids já respondidos (tool_result sempre vem DEPOIS do tool_use correspondente)
  const answered = new Set();
  for (const o of lines) for (const b of contentBlocks(o))
    if (b && b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
  // última linha conversacional + índice da última linha assistant (pula metadados)
  let lastConv = null, lastAsst = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const role = lines[i] && lines[i].message && lines[i].message.role;
    if (!lastConv && (role === 'assistant' || role === 'user')) lastConv = lines[i];
    if (role === 'assistant') { lastAsst = i; break; }
  }
  if (!lastConv) return 'idle';
  // turno assistant mais recente = linhas assistant consecutivas com o MESMO requestId
  // (o Claude Code grava um turno em várias linhas: text/thinking/tool_use).
  let pendingDecision = false, pendingAgent = false;
  if (lastAsst >= 0) {
    const rid = lines[lastAsst].requestId;
    for (let i = lastAsst; i >= 0; i--) {
      const o = lines[i], role = o && o.message && o.message.role;
      if (role !== 'assistant' || (rid != null && o.requestId !== rid)) break;
      for (const b of contentBlocks(o)) {
        if (b && b.type === 'tool_use' && b.id && !answered.has(b.id)) {
          if (AGENT_TOOLS[b.name]) pendingAgent = true; else pendingDecision = true;
        }
      }
    }
  }
  if (pendingDecision) return 'decision'; // ferramenta/pergunta esperando a Mel
  if (pendingAgent) return 'live';        // subagente rodando (liveness via tasks/*.output)
  const role = lastConv.message.role;
  if (role === 'user') {
    if (userText(lastConv).indexOf('[Request interrupted') !== -1) return 'idle'; // ESC = turno abortado
    return 'live'; // prompt novo ou tool_result fresco -> o modelo deve resposta (pensando)
  }
  const sr = lastConv.message.stop_reason;
  if (sr === 'end_turn' || sr === 'stop_sequence' || sr === 'max_tokens' || sr === 'refusal') return 'idle';
  return 'live'; // null (turno ainda sendo gravado) ou tool_use sem o bloco gravado ainda
}

// transcript "ativo": o último que cresceu nesta execução; no boot (nada cresceu
// ainda), o de mtime mais recente. subagents/ nunca conta (espelho, não a conversa).
function isSubagentPath(f) { return f.indexOf(path.sep + 'subagents' + path.sep) !== -1; }
function activeTranscript() {
  if (lastGrewJsonl) return lastGrewJsonl;
  let best = null, bt = 0;
  for (const f of listJsonl(PROJECTS, [])) {
    if (isSubagentPath(f)) continue;
    let mt; try { mt = fs.statSync(f).mtimeMs; } catch (e) { continue; }
    if (mt > bt) { bt = mt; best = f; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// AGREGAÇÃO DE ESTADO (FIX do falso "o agente terminou" durante SUBAGENTE pensando)
// ---------------------------------------------------------------------------
// BUG REAL (Mel, 12/07/2026 ~22:01, sessão 5765f9c7): o app mostrou "o agente
// terminou" enquanto a sessão dela estava em "Mulling… (7m17s · ↓87.5k · thinking
// with xhigh effort)". CAUSA RAIZ (provada com os arquivos reais do horário):
//
//  • Os subagentes desta sessão são despachados em BACKGROUND
//    (Agent tool_use com input.run_in_background=true). O despacho recebe um
//    tool_result IMEDIATO ("Async agent launched successfully… agentId: X") e o
//    turno do agente PRINCIPAL FECHA logo em seguida com `end_turn`. Portanto a
//    ÚLTIMA linha conversacional do transcript principal fica `assistant end_turn`
//    ⇒ tailShape(principal) = 'idle'.
//  • Enquanto isso o subagente roda por MINUTOS. Durante os blocos longos de
//    thinking (xhigh) ele NÃO grava nada: medi no espelho subagents/agent-*.jsonl
//    lacunas de escrita de 78s, 108s, 616s (10m16s) e até 3167s (52min) SEM um
//    único byte novo — nem no espelho, nem no tasks/*.output. Logo o único sinal de
//    liveness (crescimento de bytes) some, `lastActivity` envelhece e, com o tail do
//    principal em 'idle', computeState devolvia 'idle' após IDLE_MS ⇒ falso
//    "terminou" com o subagente ativíssimo pensando.
//  • REPRODUÇÃO AO VIVO (22:14): tailShape(principal)='idle' (end_turn) e o
//    activeTranscript() era o principal, ENQUANTO dois espelhos de subagente estavam
//    fresquíssimos — ab0417 (age 0.0min, shape='live') e aad33bd (age 0.2min,
//    shape='decision', o editor do game.js). O detector antigo olhava SÓ o principal
//    ⇒ 'idle'. Bug 1:1 com o relato da Mel.
//
// Hipóteses do enunciado:
//  H1 (confirmada como a DIREÇÃO certa do fix): decidir agregando TODOS os
//     transcripts com atividade recente, não só o principal. (Obs.: o código antigo
//     NÃO lia o espelho como "ativo" — ele lia SÓ o principal; o espelho, aliás, é
//     gravado INCREMENTALMENTE durante a execução, então seu shape serve de sinal.)
//  H2 (confirmada, causa secundária/composta): THINK_MS era 10min < lacunas de
//     thinking do subagente (616s, 3167s). Mesmo o caminho "pensando" estouraria o
//     cap. Subi p/ 30min (cap generoso; a atividade real do subagente agora é
//     provada pelo mtime recente do espelho, não só pelo silêncio).
//  H3 (confirmada como princípio): o espelho subagents/*.jsonl é SINAL DE ATIVIDADE,
//     nunca veredito de 'idle' do principal nem de 'decision' da Mel. Aqui: só o
//     PRINCIPAL pode gerar 'decision' (a Mel é quem autoriza); um espelho mid-turn
//     (inclusive 'decision' interna, que é só "vou rodar uma tool") vira 'live'.
//
// ---------------------------------------------------------------------------
// BUG REAL nº2 (Mel, screenshot 12/07/2026 ~22:20, sessão 5765f9c7): um SUBAGENTE em
// background pediu AUTORIZAÇÃO (prompt de permissão de Bash NO TERMINAL DELA — um
// relançamento `pkill electron; npm start`) e o app mostrou "AO VIVO" com o jogo
// liberado, em vez de "sua decisão" + pausa. O prompt SURGIU no terminal e PRECISAVA
// dela → tinha de virar 'decision'. Antes, combineShapes rebaixava QUALQUER 'decision'
// de subagente p/ 'live' (só o principal podia gerar 'decision'), por medo de confundir
// "tool_use pendente = ferramenta executando" com "aguardando permissão".
//
// INVESTIGAÇÃO EMPÍRICA (arquivos reais desta máquina, sessão 5765f9c7, 12→13/07/2026):
//  1) MARCADOR `type:permission-mode`? NÃO SERVE. As linhas
//     {"type":"permission-mode","permissionMode":"default|acceptEdits",...} são só o
//     MODO de permissão (shift+tab), num bloco de metadados no FIM do transcript, e
//     existem SÓ no principal (64x no 5765f9c7.jsonl, 0x em qualquer subagents/*.jsonl).
//     Não marcam "prompt aberto" — mudam quando a Mel troca o modo. Descartado.
//  2) SHAPE do espelho durante a espera de permissão vs execução de tool? IDÊNTICOS.
//     Os tasks/<id>.output são SYMLINK pro próprio subagents/agent-<id>.jsonl (mesmo
//     inode) → o espelho é escrito AO VIVO. Tanto "esperando permissão" quanto "Bash
//     executando" aparecem como a MESMA última linha: assistant tool_use Bash SEM
//     tool_result depois ⇒ tailShape='decision' nos dois casos. Não há como distinguir
//     pela ESTRUTURA. (Confirmado no próprio espelho deste agente enquanto rodava.)
//  3) SINAL QUE SOBRA = TEMPO. Medi os gaps tool_use→tool_result reais de HOJE: os
//     relançamentos de recreio pendentes de aprovação ficaram MUDOS por 186,6s (ab0417
//     "bug da beirada"), 123,6s (a02357 "Mario"), 119,9s (a0db02) — todos `pkill
//     electron; npm start`, todos > 90s SEM nenhum byte novo em lugar nenhum. Já uma
//     ferramenta longa de fato ESCREVE algo (ex.: a0db02 rodou um `until curl
//     localhost:3000` de 1040s, mas com o servidor subindo/outros agentes gravando).
//     ⇒ REGRA (fallback, sem marcador confiável): subagente com tool_use pendente
//       ('decision') + SILÊNCIO GLOBAL >= SUB_DECISION_MS = permissão → 'decision'.
//       O `silence` (now - lastActivity) JÁ codifica "nada cresceu": qualquer
//       crescimento de .jsonl ou tasks/*.output zera lastActivity (ver poll()).
//  4) REMEDIÇÃO 13/07 (a Mel achou 90s LENTO demais — só descobria a permissão 1,5min
//     depois). Re-medi TODOS os transcripts dela (~78 sessões) e o SILÊNCIO GLOBAL por
//     sessão (min entre todos os arquivos, = o que `silence` observa) DURANTE um
//     tool_use NÃO-Agent pendente: p50=0,3s p90=7,4s p95=18,8s. Ou seja, 95% das
//     ferramentas legítimas de subagente quebram o silêncio global em <19s; as esperas
//     de permissão REAIS ficam em 120-186s (bem acima). Escolhi SUB_DECISION_MS=22s:
//     logo ACIMA do p95 (18,8s) do silêncio legítimo, ~3s de folga, e 4x mais rápido
//     que 90s. Obs.: Agent/Task pendente NÃO conta (vira 'live', não 'decision'), então
//     os gaps gigantes de sub-subagentes (p50=161s) não entram nessa conta.
//     TRADEOFF (documentado): uma ferramenta de subagente genuinamente LONGA e 100%
//       muda por >22s (~5% dos casos, muitos dos quais SÃO permissão) daria um 'decision'
//       falso — mas AUTO-CORRIGE assim que o tool_result é gravado (crescimento → live).
//       "Melhor um 'decision' atrasado (22s) que um 'live' falso durante permissão real".
//
// combineShapes: função PURA (testável em node). mainShape = shape do transcript
// principal (semântica cheia: 'decision' já aos ~4s, validado); otherShapes = shapes
// dos demais transcripts recentes (espelhos de subagente etc.); silence = ms desde o
// último crescimento global. Um 'decision' de subagente só vira 'decision' agregado se
// sustentado por SUB_DECISION_MS; abaixo disso é ambíguo (pode ser tool executando) → 'live'.
// FIX MULTI-AGENTE — SILÊNCIO POR-TRANSCRIPT (não global): main={shape,silence},
// others=[{shape,silence},...], onde `silence` é o do PRÓPRIO transcript (ms desde o
// último crescimento DELE), não o global. Regras:
//  • PRINCIPAL 'decision' + o silêncio DELE >= DECISION_MS (4s) -> 'decision', com
//    PRIORIDADE e INDEPENDENTE de subagentes barulhentos ao lado. (Antes o silêncio
//    global era resetado por qualquer subagente e a decisão do principal ficava
//    mascarada como 'live' — o bug relatado pela Mel.)
//  • Um tool_use pendente do PRINCIPAL ainda "quente" (silêncio dele < DECISION_MS) =
//    tool executando -> conta como 'live' (auto-corrige quando o tool_result grava).
//  • Subagente 'decision' MUDO no PRÓPRIO arquivo por >= SUB_DECISION_MS (22s) = prompt
//    de permissão no terminal da Mel -> 'decision'. Abaixo disso é ambíguo (pode ser
//    tool executando) -> 'live'.
//  • O estado agregado vira 'decision' se QUALQUER transcript precisa de decisão — MESMO
//    que outros transcripts estejam vivos. 'live' se há atividade viva e ninguém decide;
//    'idle' só quando todos fecharam o turno. Função PURA (testável em node).
function combineShapes(main, others) {
  const mShape = main && main.shape;
  const mSil = (main && main.silence) || 0;
  if (mShape === 'decision' && mSil >= DECISION_MS) return 'decision'; // principal te esperando (prioridade)
  let live = (mShape === 'live') || (mShape === 'decision'); // decisão do principal ainda quente = tool executando
  let needDecision = false;
  if (others) for (const o of others) {
    const s = o && o.shape, sil = (o && o.silence) || 0;
    if (s === 'decision') {
      if (sil >= SUB_DECISION_MS) needDecision = true; // permissão de subagente (mudo >=22s no arquivo dele)
      else live = true;                                // ambíguo (tool executando) -> vivo
    } else if (s && s !== 'idle') {
      live = true;                                     // subagente pensando/gerando
    }
  }
  if (needDecision) return 'decision'; // QUALQUER transcript precisa de decisão -> agregado 'decision'
  return live ? 'live' : 'idle';
}

// silenceForFile: silêncio PRÓPRIO de um transcript = ms desde o último crescimento DELE
// (activityByFile, alimentado por poll). Arquivo nunca visto crescer -> Infinity (tratado
// como maximamente silencioso; a 1ª observação em collectShapes fixa o baseline).
function silenceForFile(f, now) {
  if (!f) return Infinity;
  const t = activityByFile.get(f);
  return (t == null) ? Infinity : ((now || Date.now()) - t);
}

// collectShapes: parseia o tail do principal + de todo transcript cujo mtime caiu nos
// últimos RECENT_MS (inclui espelhos de subagente vivos). Devolve os shapes CRUS COM O
// ARQUIVO-FONTE de cada um — o veredito depende do SILÊNCIO PRÓPRIO de cada transcript
// (que cresce a cada poll SEM crescimento), então cacheamos {shape,file} 1x por estirão e
// recombinamos com o silêncio de cada arquivo (silenceForFile) a cada poll. Na 1ª
// observação de um arquivo, fixa o baseline de atividade = `now` (silêncio começa em ~0 e
// cresce), pra não disparar 'decision' falso no boot por um arquivo herdado.
function collectShapes(now) {
  now = now || Date.now();
  const main = activeTranscript();
  if (main && !activityByFile.has(main)) activityByFile.set(main, now);
  const mainShape = tailShape(readTailLines(main));
  const others = [];
  for (const f of listJsonl(PROJECTS, [])) {
    if (f === main) continue;
    let mt; try { mt = fs.statSync(f).mtimeMs; } catch (e) { continue; }
    if (now - mt > RECENT_MS) continue; // não cresceu recentemente -> ignora
    if (!activityByFile.has(f)) activityByFile.set(f, now); // baseline na 1ª observação
    others.push({ shape: tailShape(readTailLines(f)), file: f });
  }
  return { mainShape: mainShape, mainFile: main, others: others };
}

// combineNow: mapeia o cache {mainShape,mainFile,others:[{shape,file}]} -> combineShapes
// com o silêncio PRÓPRIO de cada transcript AGORA (silenceForFile). Um só ponto de verdade
// pra computeState e aggregateShape.
function combineNow(c, now) {
  return combineShapes(
    { shape: c.mainShape, silence: silenceForFile(c.mainFile, now) },
    c.others.map((o) => ({ shape: o.shape, silence: silenceForFile(o.file, now) }))
  );
}

// aggregateShape: shape agregado AGORA (coleta fresca + silêncio próprio de cada transcript).
// 'idle' só quando o principal E todos os recentes fecharam o turno; 'decision' quando o
// principal aguarda a Mel (silêncio DELE >=4s) OU um subagente ficou mudo num tool_use
// pendente por >=22s no próprio arquivo — mesmo com outros subagentes vivos ao lado.
function aggregateShape(now) {
  now = now || Date.now();
  return combineNow(collectShapes(now), now);
}

// resolveState: veredito PURO (testável em node) dado o SILÊNCIO GLOBAL e o shape agregado.
// Extraído de computeState. O gating temporal da DECISÃO agora mora em combineShapes (via
// o silêncio PRÓPRIO de cada transcript), então aqui o silêncio GLOBAL só decide o eixo
// live<->idle:
//  • shape 'decision' já vem validado pelo silêncio próprio -> 'decision' (mesmo com o
//    silêncio global baixo, pois um subagente barulhento não invalida a espera do principal).
//  • 'idle' só quando o silêncio global passa de IDLE_MS (15s) E o shape não é 'live':
//    "pensando"/subagente vivo tem shape 'live' e segura 'live' até THINK_MS, então
//    thinking longo NUNCA vira idle a 15s.
function resolveState(silence, shape) {
  if (shape === 'decision') return 'decision';
  if (silence < IDLE_MS) return 'live';
  if (shape === 'live') return silence < THINK_MS ? 'live' : 'idle';
  return 'idle';
}

// estado do agente agora. Parse do tail SÓ depois de DECISION_MS de silêncio, 1x
// por estirão (cache limpo a cada crescimento). 'decision' aparece já aos ~4s
// (pausa o recreio NA HORA, sem esperar os 15s); 'idle' continua exigindo 15s E
// TODOS os transcripts recentes com turno fechado; "pensando"/subagente vivo segura
// 'live' até THINK_MS.
function computeState(now) {
  // shapes CRUS (main + recentes) + arquivos-fonte cacheados 1x por estirão (invalidados
  // a cada crescimento). Recombinados a CADA poll com o silêncio PRÓPRIO de cada transcript
  // (que cresce SEM crescimento de arquivo), pra a 'decisão' do principal (silêncio dele
  // >=DECISION_MS) OU de um subagente (silêncio dele >=SUB_DECISION_MS) emergir mesmo com
  // outros subagentes barulhentos — o bug multi-agente. NÃO há mais atalho por silêncio
  // GLOBAL (era ele que mascarava a decisão): durante runs multi-agente o global nunca
  // acumula, então precisamos SEMPRE olhar o silêncio de cada transcript.
  if (tailShapesCache == null) tailShapesCache = collectShapes(now);
  const shape = combineNow(tailShapesCache, now);
  return resolveState(now - lastActivity, shape); // silêncio GLOBAL só decide live<->idle
}

// ---------------------------------------------------------------------------
// AVISO ATIVO (a Mel: "quando o agente para, o app demora e não me avisa quando
// preciso decidir/agir — fica parado me esperando"). Além do LED que já muda,
// disparamos uma NOTIFICAÇÃO do sistema UMA vez por transição p/ um estado que
// exige ação dela (live→decision / live→idle). Debounce: só na MUDANÇA de estado,
// nunca repetido enquanto o estado dura. Silenciada se a janela do overlay já está
// focada (ela está olhando). O SOM (chime) e o PULSO da borda ficam no renderer
// (game.js), disparados na mesma transição via o payload 'state'. Funções PURAS
// (testáveis em node):
//   alertForTransition(prev,next) -> 'decision'|'idle'|null : só na MUDANÇA p/ um
//     estado que pede ação; prev==null (boot) estabelece baseline em SILÊNCIO — evita
//     chime/notificação a cada relançamento do app; só transições DENTRO da sessão avisam.
//   shouldNotify(prev,next,focused): idem, porém suprime se a janela está focada.
// ---------------------------------------------------------------------------
function alertForTransition(prev, next) {
  if (prev === next) return null;                            // sem mudança -> sem aviso (debounce)
  if (prev == null) return null;                             // boot: baseline silencioso
  if (next === 'decision' || next === 'idle') return next;   // ela precisa decidir / é a vez dela
  return null;                                                // ->live não avisa
}
function shouldNotify(prev, next, focused) {
  return !focused && alertForTransition(prev, next) != null;
}
let lastAlertState = null; // último estado já "avisado" (baseline + debounce por transição)

// dispara a Notification do Electron (no-op gracioso se indisponível / sem permissão).
function notifyOS(kind) {
  try {
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
    const msg = (kind === 'decision')
      ? { title: 'TOKENTOWN — precisa da sua decisão', body: 'o agente está te esperando' }
      : { title: 'TOKENTOWN — o agente terminou', body: 'sua vez' };
    new Notification(msg).show();
  } catch (e) {}
}

// base dos .output: /private/tmp/claude-<uid>/... (NÃO os.tmpdir(), que no macOS é
// /var/folders/...). tenta /private/tmp e /tmp (symlink no mac).
function taskOutputBase() {
  const uid = (typeof process.getuid === 'function') ? process.getuid() : null;
  if (uid == null) return null;
  for (const base of ['/private/tmp/claude-' + uid, '/tmp/claude-' + uid]) {
    try { if (fs.statSync(base).isDirectory()) return base; } catch (e) {}
  }
  return null;
}

// lista os tasks/<agentId>.output (estrutura fixa base/<slug>/<sessão>/tasks/*.output).
function listTaskOutputs() {
  const base = taskOutputBase();
  if (!base) return [];
  const out = [];
  let slugs; try { slugs = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return out; }
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    let sess; try { sess = fs.readdirSync(path.join(base, s.name), { withFileTypes: true }); } catch (e) { continue; }
    for (const se of sess) {
      if (!se.isDirectory()) continue;
      const tdir = path.join(base, s.name, se.name, 'tasks');
      let ents; try { ents = fs.readdirSync(tdir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) if (e.isFile() && e.name.endsWith('.output')) out.push(path.join(tdir, e.name));
    }
  }
  return out;
}

// devolve true se ALGUM arquivo cresceu desde a última checagem. A 1ª vez que vê um
// arquivo, registra o tamanho como BASELINE (não conta como crescimento) — assim os
// .output pré-existentes não marcam "ao vivo" falso no boot.
function anyFileGrew(files) {
  let grew = false;
  for (const f of files) {
    let sz; try { sz = fs.statSync(f).size; } catch (e) { continue; }
    const prev = taskSizes.get(f);
    taskSizes.set(f, sz);
    if (prev !== undefined && sz > prev) grew = true;
  }
  if (taskSizes.size > 20000) { const k = taskSizes.keys().next().value; taskSizes.delete(k); }
  return grew;
}

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');

// carrega o state.json no boot e decide retomar/arquivar (via computeBoot puro).
function loadState() {
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch (e) {}
  const b = computeBoot(disk, Date.now());
  seasonId = b.seasonId; seasonTokens = b.tokens; costUSD = b.costUSD;
  subagents = b.residents; history = b.history;
  dirty = true;   // grava logo o estado inicial (temporada nova arquivada, 1º boot, etc.)
  saveState();
}

// grava o state.json (assíncrono por padrão; síncrono no before-quit pra não perder).
function saveState(sync) {
  if (!app || !app.getPath) return; // node puro (testes) não tem userData
  const data = JSON.stringify({ seasonId, tokens: seasonTokens, costUSD, residents: subagents, history });
  try {
    if (sync) fs.writeFileSync(STATE_FILE(), data);
    else fs.writeFile(STATE_FILE(), data, () => {});
    dirty = false;
  } catch (e) {}
}

// vira a temporada em RUNTIME (app aberto na virada dos 28 dias): arquiva e zera.
function rolloverIfNeeded() {
  const sid = currentSeasonId();
  if (sid === seasonId) return false;
  history.push({ seasonId: seasonId, tokens: seasonTokens, costUSD: costUSD, residents: subagents,
                 buildings: 2 + Math.floor(seasonTokens / TOK_PER_BUILD_REAL) });
  if (history.length > 60) history = history.slice(-60);
  seasonId = sid; seasonTokens = 0; costUSD = 0; subagents = 0;
  toolTally.clear(); modelTally.clear(); skillTally.clear(); // temporada nova: zera indústrias/energia/skills também
  lastDaily = {}; // temporada nova: zera o breakdown diário (semana recomeça vazia)
  dirty = true; saveState();
  return true;
}

// baseline: apenas marca onde cada arquivo ESTÁ AGORA (byte-offset), pra contar só
// o que vier daqui pra frente. SEM varredura histórica — moradores são POR TEMPORADA
// (o total da temporada vem do state.json, não do histórico dos transcripts).
function initBaseline() {
  for (const f of listJsonl(PROJECTS, [])) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { continue; }
    const nl = buf.lastIndexOf(0x0a);
    offsets.set(f, nl < 0 ? 0 : nl + 1);
  }
}

// BACKFILL no boot — FONTE DA VERDADE da temporada corrente = os transcripts.
// Antes os contadores vinham do state.json, mas uso feito com o app FECHADO se
// perdia (a Mel contava mais do que o app mostrava). Aqui reconstruímos os totais
// da temporada varrendo TODAS as linhas dos transcripts cujo timestamp cai dentro
// da temporada atual (>= seasonStart), com o MESMO dedupe de sempre: popula
// seenUsage/seenAgents (que a leitura incremental reusa) e marca os offsets no FIM
// de cada arquivo, pra seguir incremental daqui pra frente exatamente como o
// initBaseline fazia. Roda 1x no boot (no did-finish-load, antes do 1º poll).
// Linha sem timestamp: pulada. Rollover em runtime NÃO faz backfill (só zera e segue).
function backfillSeason() {
  const seasonStart = SEASON_EPOCH + seasonId * SEASON_MS;
  toolTally.clear(); modelTally.clear(); skillTally.clear(); seenTools.clear(); // verdade da temporada: reconstrói do zero
  let tk = 0, ag = 0, cost = 0;
  // BREAKDOWN DIÁRIO: coleta {ts, tokens} das linhas de usage CONTADAS (mesmo dedupe) que
  // caem na janela dos últimos 7 dias UTC; bucketiza por dia UTC no fim. Pré-filtra pelo
  // início da janela pra não guardar a temporada inteira (só os últimos ~7 dias).
  const now = Date.now();
  const dailyStart = dailyWindowStartMs(now);
  const dailyEntries = [];
  for (const f of listJsonl(PROJECTS, [])) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { continue; }
    const nl = buf.lastIndexOf(0x0a);
    offsets.set(f, nl < 0 ? 0 : nl + 1); // baseline: só o que vier DEPOIS é incremental
    if (nl < 0) continue;                 // nenhuma linha completa neste arquivo
    for (const line of buf.slice(0, nl).toString('utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o.timestamp) continue;                          // sem timestamp -> pula
      const ts = Date.parse(o.timestamp);
      if (!(ts >= seasonStart)) continue; // fora da temporada atual
      const u = o.message && o.message.usage;
      if (u) {
        const mid = o.message && o.message.id;
        const rid = o.requestId;
        let counted = true;
        if (mid != null && rid != null) counted = remember(seenUsage, mid + ':' + rid, USAGE_CAP);
        if (counted) {
          const lineTk = tokensFromUsage(u);
          tk += lineTk;
          cost += costFromUsage(u, o.message.model);
          tallyForSetup(o, u); // modelos (energia) da temporada — precisa dos tokens+dedupe de usage
          // MESMO dedupe/gate que os tokens da cidade: só linhas contadas entram no diário.
          if (ts >= dailyStart && lineTk > 0) dailyEntries.push({ ts: ts, tokens: lineTk });
        }
      }
      tallyTools(o);           // tools/skills (indústrias/skills) — dedupe por id do bloco tool_use
      ag += countNewSubagents(o);
    }
  }
  seasonTokens = tk; costUSD = cost; subagents = ag; // sobrescreve o cache do state.json
  lastDaily = dailyBucketize(dailyEntries, now);     // 7 dias UTC reais (verdade da temporada)
  if (tk > 0) lastActivity = Date.now();
  dirty = true; saveState();
  try { console.log('[tokentown] backfill T' + seasonId + ': tokens=' + tk +
    ' custo=US$' + cost.toFixed(4) + ' moradores=' + ag +
    ' (desde ' + new Date(seasonStart).toISOString() + ')' +
    ' diario=' + JSON.stringify(lastDaily)); } catch (e) {}
}

function readNew(f) {
  let size;
  try { size = fs.statSync(f).size; } catch (e) { return { tokens: 0, agents: 0, cost: 0, grew: false }; }
  let off = offsets.has(f) ? offsets.get(f) : 0; // arquivo novo -> conta do zero
  if (off > size) off = 0;                        // rotacionou/truncou
  // `grew` = ganhou bytes desde a última leitura = ATIVIDADE (mesmo sem usage: um
  // tool_result de um Bash longo ao terminar, ou uma linha nova do espelho de subagente).
  const grew = size > off;
  if (size <= off) { if (!offsets.has(f)) offsets.set(f, size); return { tokens: 0, agents: 0, cost: 0, grew: false }; }

  let buf;
  try {
    const fd = fs.openSync(f, 'r');
    buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, size - off, off);
    fs.closeSync(fd);
  } catch (e) { offsets.set(f, size); return { tokens: 0, agents: 0, cost: 0, grew: grew }; }

  const nl = buf.lastIndexOf(0x0a); // só processa linhas completas (com \n)
  if (nl < 0) return { tokens: 0, agents: 0, cost: 0, grew: grew }; // linha parcial (sem \n): já é atividade
  offsets.set(f, off + nl + 1);

  let tk = 0, ag = 0, cost = 0;
  for (const line of buf.slice(0, nl).toString('utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    const u = o && o.message && o.message.usage;
    if (u) {
      const mid = o.message && o.message.id;
      const rid = o.requestId;
      let counted = true;
      if (mid != null && rid != null) counted = remember(seenUsage, mid + ':' + rid, USAGE_CAP);
      if (counted) {
        tk += tokensFromUsage(u);
        cost += costFromUsage(u, o.message.model);
        tallyForSetup(o, u); // modelos p/ o blob de setup (dedupe de usage)
      }
    }
    tallyTools(o);           // tools/skills p/ o setup (dedupe por id do bloco tool_use)
    ag += countNewSubagents(o);
  }
  return { tokens: tk, agents: ag, cost, grew: grew };
}

function poll(win) {
  rolloverIfNeeded(); // se cruzou os 28 dias com o app aberto, arquiva e zera
  const now0 = Date.now();
  let addedTk = 0, addedAg = 0, addedCost = 0, grew = false;
  for (const f of listJsonl(PROJECTS, [])) {
    const r = readNew(f);
    addedTk += r.tokens; addedAg += r.agents; addedCost += r.cost;
    if (r.grew) {
      grew = true;
      activityByFile.set(f, now0); // SILÊNCIO POR-TRANSCRIPT: cada arquivo marca o seu próprio último crescimento
      if (activityByFile.size > 20000) { const k = activityByFile.keys().next().value; activityByFile.delete(k); }
      if (!isSubagentPath(f)) lastGrewJsonl = f; // transcript principal ativo
    }
  }
  // subagentes em background: os tasks/*.output crescem AO VIVO durante a execução.
  if (anyFileGrew(listTaskOutputs())) grew = true;
  if (grew) { lastActivity = Date.now(); tailShapesCache = null; } // crescimento invalida os shapes cacheados
  // linhas novas são ~agora -> somam no bucket de HOJE (UTC) e a janela é podada. Mantém
  // o breakdown diário vivo entre backfills; dias passados só mudam num relançamento.
  if (addedTk > 0) addDailyTokens(lastDaily, now0, addedTk);
  if (addedTk > 0) { seasonTokens += addedTk; dirty = true; }
  if (addedAg > 0) { subagents += addedAg; dirty = true; }
  if (addedCost > 0) { costUSD += addedCost; dirty = true; }
  if (win && !win.isDestroyed()) {
    const st = computeState(Date.now()); // 'live' | 'decision' | 'idle'
    // AVISO ATIVO: Notification do sistema 1x na TRANSIÇÃO p/ decision/idle,
    // silenciada se a janela do overlay já está focada (a Mel já está olhando).
    let focused = false; try { focused = win.isFocused(); } catch (e) {}
    if (shouldNotify(lastAlertState, st, focused)) notifyOS(st);
    lastAlertState = st; // atualiza sempre (baseline + debounce), focada ou não
    win.webContents.send('usage', {
      total: seasonTokens,
      added: addedTk,
      state: st,
      live: st === 'live', // compat: quem só conhece o booleano segue funcionando
      residents: subagents,
      cost: costUSD,
      seasonId: seasonId,
      daysLeft: daysLeftIn()
    });
  }
  // snapshot da temporada pro placar (no-op se desabilitado; throttle interno de 10min).
  // `city` = retrato da cidade REAL (seed/prédios/população/especiais/marcos/era) que o
  // renderer manda via IPC (tt.sendCity → 'city'); null até a 1ª mensagem chegar.
  reporter.report({
    seasonId: seasonId,
    tokens: seasonTokens,
    cost: costUSD,
    residents: subagents,
    buildings: 2 + Math.floor(seasonTokens / TOK_PER_BUILD_REAL),
    city: lastCity,
    setup: lastSetup, // o placar só o inclui no POST se shareSetup (ver placar.js)
    dailyTokens: lastDaily // breakdown por dia UTC (7 dias) -> heatmap "CITY LIGHTS" real
  });
}

// ---------------------------------------------------------------------------
// SETUP → CIDADE (Fase 1) — coleta o setup LOCAL (só nomes e contagens) e monta o
// blob do contrato. PRIVACIDADE: nunca prompt/código/conteúdo/caminho — só nomes de
// skills/MCP/hooks e contagens de ferramentas/modelos. Best-effort: cada fonte
// degrada pra [] se o caminho não existir. O renderer recebe SEMPRE (D5: a cidade
// local mostra o próprio stack); o placar só recebe se shareSetup (ver placar.js).
// ---------------------------------------------------------------------------
const SETUP_V = 1;

// normaliza o modelo pro slug curto de exibição (opus-4-8, fable-5, haiku-4-5).
// <synthetic> (mensagem local, custo 0) NÃO é fonte de energia -> descartado.
function normModelSlug(model) {
  if (!model) return null;
  let s = String(model).toLowerCase();
  if (s === '<synthetic>') return null;
  s = s.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '').replace(/^claude-/, '');
  return s || null;
}

// soma UMA linha de usage já contada (dedupe do caller) nos tallies do setup.
// modelTally: modelo -> tokens da cidade. PRECISA do usage (tokens) e do dedupe de usage
// (não contar tokens do mesmo requestId 2x), então roda no caminho `counted` do caller.
function tallyForSetup(o, u) {
  const md = normModelSlug(o && o.message && o.message.model);
  if (md) modelTally.set(md, (modelTally.get(md) || 0) + tokensFromUsage(u));
}

// tallyTools: conta INVOCAÇÕES de ferramenta p/ o setup (toolTally + skillTally),
// deduplicadas pelo id do bloco tool_use (seenTools) — INDEPENDENTE do dedupe de usage.
// Roda por linha, fora do gate de usage, pra não perder tool_use que caem em linhas
// descartadas pelo dedupe de tokens (streaming) nem duplicar os espelhados em subagents/.
function tallyTools(o) {
  const c = o && o.message && o.message.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || b.type !== 'tool_use' || !b.name) continue;
    if (b.id != null && !remember(seenTools, b.id, TOOLS_CAP)) continue; // invocação já contada
    toolTally.set(b.name, (toolTally.get(b.name) || 0) + 1);
    // SKILLS REALMENTE USADAS: a tool `Skill` traz o nome da skill em input.skill
    // (shape real: {name:'Skill', input:{skill:'copy-mel', args?}} — com ou sem `args`).
    if (b.name === 'Skill' && b.input && b.input.skill) {
      const sk = String(b.input.skill);
      if (sk) skillTally.set(sk, (skillTally.get(sk) || 0) + 1);
    }
  }
}

// slug estrito [a-z0-9-] p/ skills/mcp/hooks/modelos (coage; o servidor revalida).
function setupSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
// nome de ferramenta: preserva caixa + underscore (ex.: mcp__claude-in-chrome__computer).
function setupToolName(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, '').slice(0, 48); }
function uniq(a) { const seen = new Set(), out = []; for (const x of a) if (x && !seen.has(x)) { seen.add(x); out.push(x); } return out; }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

// collectSetup: monta o blob { v, skills, mcp, hooks, tools, models }. Aceita `opts`
// pra teste (caminhos e tallies injetáveis); em produção usa ~/.claude + os tallies.
// FEEDBACK DA MEL: skills/mcp agora refletem o que ela REALMENTE USA (invocações reais nos
// transcripts da temporada), não o que está apenas INSTALADO/CONFIGURADO — a /u mostra o
// stack VIVO. hooks/tools/models seguem como estavam.
function collectSetup(opts) {
  opts = opts || {};
  const home = opts.home || os.homedir();
  const settingsJson = ('settingsJson' in opts) ? opts.settingsJson : path.join(home, '.claude', 'settings.json');
  const tools = opts.toolTally || toolTally;
  const models = opts.modelTally || modelTally;
  const skillsUsed = opts.skillTally || skillTally;

  // SKILLS REALMENTE USADAS: frequência de invocações da tool `Skill` na temporada
  // (skillTally, reconstruído pelo backfill). Ordena por frequência desc, cap 40. Uma
  // skill só instalada (em ~/.claude/skills) mas NUNCA chamada NÃO entra.
  const skills = uniq(
    Array.from(skillsUsed.entries())
      .filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1])
      .map((e) => setupSlug(e[0])).filter(Boolean)
  ).slice(0, 40);

  // MCP REALMENTE USADOS: servidores cujas ferramentas mcp__<server>__* foram chamadas na
  // temporada — derivado do toolTally (server = 2º segmento de `mcp__server__tool`). Agrega
  // a contagem por servidor, ordena por frequência desc, cap 20. Um servidor só configurado
  // em mcpServers mas NUNCA chamado NÃO entra (ex.: se palmier-pro não for usado, sai;
  // claude-in-chrome, usadíssimo, entra).
  const mcpCounts = new Map();
  for (const e of tools.entries()) {
    const mm = /^mcp__(.+?)__/.exec(String(e[0]));
    if (mm) mcpCounts.set(mm[1], (mcpCounts.get(mm[1]) || 0) + Math.max(0, Number(e[1]) || 0));
  }
  const mcp = uniq(
    Array.from(mcpCounts.entries())
      .filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1])
      .map((e) => setupSlug(e[0])).filter(Boolean)
  ).slice(0, 20);

  // HOOKS: eventos (chaves de settings.hooks) de ~/.claude/settings.json, cap 12.
  let hooks = [];
  const sj = settingsJson ? readJsonSafe(settingsJson) : null;
  if (sj && sj.hooks && typeof sj.hooks === 'object') hooks = uniq(Object.keys(sj.hooks).map(setupSlug)).slice(0, 12);

  // TOOLS: top-10 tool_use.name da temporada, [[name,count]].
  const toolsArr = Array.from(tools.entries())
    .map((e) => [setupToolName(e[0]), Math.max(0, Math.floor(Number(e[1]) || 0))])
    .filter((p) => p[0] && p[1] > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 10);

  // MODELS: top-6 frações normalizadas por tokens, [[name,frac]].
  let total = 0; for (const v of models.values()) if (v > 0) total += v;
  let modelsArr = [];
  if (total > 0) {
    modelsArr = Array.from(models.entries())
      .filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map((e) => [setupSlug(e[0]), Math.round((e[1] / total) * 1e4) / 1e4])
      .filter((p) => p[0] && p[1] > 0);
  }

  return { v: SETUP_V, skills: skills, mcp: mcp, hooks: hooks, tools: toolsArr, models: modelsArr };
}

// recoleta o setup e o manda ao renderer (SEMPRE — D5). Guardado em lastSetup pro
// próximo report do placar (que só o inclui se shareSetup). Nunca quebra o app.
function refreshSetup(win) {
  try { lastSetup = collectSetup(); } catch (e) {}
  try { if (win && !win.isDestroyed() && lastSetup) win.webContents.send('setup', lastSetup); } catch (e) {}
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 320, H = 360; // +altura pra caber a faixa de verba / linha de vontade

  const win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - 24,
    y: workArea.y + workArea.height - H - 24,
    frame: false, transparent: true, hasShadow: false,
    resizable: false, maximizable: false, minimizable: true,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));

  win.webContents.on('did-finish-load', () => {
    backfillSeason(); // reconstrói a temporada dos transcripts + marca offsets (baseline)
    refreshSetup(win); // coleta o setup (tallies já populados pelo backfill) + manda ao renderer
    poll(win); // primeiro tick (manda o total de moradores já)
    const iv = setInterval(() => poll(win), 1500); // 2500→1500ms: mais granularidade p/ reagir rápido
    const sv = setInterval(() => refreshSetup(win), 5 * 60000); // refresca o setup ~a cada 5min
    win.on('closed', () => { clearInterval(iv); clearInterval(sv); });
  });
}

// Bootstrap só quando rodando DENTRO do Electron (em node puro `app` é undefined).
if (app && app.whenReady) {
  // Ponte renderer→main: o game.js manda o retrato da cidade quando ela muda de forma
  // relevante (nº de prédios/especiais/era/marcos). Guardamos o último e o reporter o
  // anexa no próximo POST. Só aceita objeto simples e pequeno (é a nossa própria janela).
  if (ipcMain && ipcMain.on) {
    ipcMain.on('city', (_e, city) => {
      if (city && typeof city === 'object') lastCity = city;
    });
  }
  app.whenReady().then(() => {
    loadState();                 // retoma/arquiva a temporada ANTES de abrir a janela
    createWindow();
    const saveIv = setInterval(() => { if (dirty) saveState(); }, 30000); // grava a cada ~30s se mudou
    app.on('before-quit', () => { clearInterval(saveIv); saveState(true); }); // grava síncrono ao sair
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}

// Exporta as funções puras pra teste em node (não afeta o app sob Electron).
module.exports = {
  priceFor, tokensFromUsage, costFromUsage, remember, countNewSubagents,
  readNew, initBaseline, backfillSeason, offsets, seenUsage, seenAgents, seenTools,
  anyFileGrew, listTaskOutputs, taskSizes, IDLE_MS,
  tailShape, readTailLines, computeState, resolveState, activeTranscript, isSubagentPath,
  combineShapes, aggregateShape, collectShapes, silenceForFile, activityByFile,
  alertForTransition, shouldNotify,
  DECISION_MS, THINK_MS, RECENT_MS, SUB_DECISION_MS, TAIL_BYTES,
  SEASON_EPOCH, SEASON_MS, currentSeasonId, daysLeftIn, computeBoot, TOK_PER_BUILD_REAL,
  collectSetup, normModelSlug, toolTally, modelTally, skillTally,
  utcDayKeyMs, dailyWindowStartMs, dailyBucketize, addDailyTokens, DAILY_WINDOW_DAYS,
  lastDaily: () => Object.assign({}, lastDaily),
  state: () => ({ seasonTokens, costUSD, subagents, seasonId, history, daily: Object.assign({}, lastDaily) })
};
