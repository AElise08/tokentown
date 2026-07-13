/* TOKENTOWN — reader.js (o CÉREBRO, portado de main.js + placar.js).
   Roda DENTRO do WKWebView, no MESMO contexto do game.js. NÃO toca em disco nem
   em rede: a casca nativa (Swift) faz o I/O de arquivo (enumerar/ler incremental/
   tails/config/tasks) e a POSTagem no placar; aqui vive toda a LÓGICA TESTADA —
   dedupe(messageId:requestId), backfill da temporada, custo/PRICING, estado
   3-vias (live/decision/idle) com silêncio POR-TRANSCRIPT, collectSetup e a
   montagem/sanitização do corpo do report. As funções puras foram copiadas
   VERBATIM de main.js/placar.js; só os pontos que liam `fs` passaram a consumir
   os dados que o Swift injeta via window.__tt.*.

   window.tt      = API que o game.js consome (onUsage/onSetup/sendCity) — inalterada.
   window.__tt    = ponte chamada pelo Swift (init, backfill, poll, peek). O poll
                    DEVOLVE ao Swift o que ele precisa fazer (notificar / postar). */
(function () {
  "use strict";

  // =========================================================================
  // TEMPORADAS — MESMA fórmula do main.js e do placar web (manter em sincronia).
  // =========================================================================
  var SEASON_EPOCH = Date.UTC(2026, 6, 1);
  var SEASON_MS = 28 * 86400000;
  var TOK_PER_BUILD_REAL = 6000;
  function currentSeasonId(now) { return Math.floor(((now || Date.now()) - SEASON_EPOCH) / SEASON_MS); }
  function daysLeftIn(now) {
    now = now || Date.now();
    var end = SEASON_EPOCH + (currentSeasonId(now) + 1) * SEASON_MS;
    return Math.max(0, Math.ceil((end - now) / 86400000));
  }
  // LÓGICA PURA de boot (idêntica a main.js.computeBoot).
  function computeBoot(disk, now) {
    var sid = currentSeasonId(now);
    if (disk && typeof disk.seasonId === 'number' && disk.seasonId > sid) {
      return { seasonId: sid, tokens: 0, costUSD: 0, residents: 0, history: [], archived: false, discarded: true };
    }
    var hist = (disk && Array.isArray(disk.history)) ? disk.history.slice() : [];
    if (disk && disk.seasonId === sid) {
      return { seasonId: sid, tokens: disk.tokens || 0, costUSD: disk.costUSD || 0,
               residents: disk.residents || 0, history: hist, archived: false };
    }
    var archived = false;
    if (disk && ((disk.tokens || 0) || (disk.residents || 0) || (disk.costUSD || 0))) {
      hist.push({ seasonId: disk.seasonId, tokens: disk.tokens || 0, costUSD: disk.costUSD || 0,
                  residents: disk.residents || 0,
                  buildings: 2 + Math.floor((disk.tokens || 0) / TOK_PER_BUILD_REAL) });
      if (hist.length > 60) hist = hist.slice(-60);
      archived = true;
    }
    return { seasonId: sid, tokens: 0, costUSD: 0, residents: 0, history: hist, archived: archived };
  }

  // =========================================================================
  // PREÇOS / TOKENS / CUSTO (VERBATIM de main.js).
  // =========================================================================
  var PRICING = {
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
  var SONNET_PRICE = { in: 3, out: 15 };
  function priceFor(model) {
    if (!model) return SONNET_PRICE;
    var m = String(model).toLowerCase();
    if (m === '<synthetic>') return { in: 0, out: 0 };
    m = m.replace(/\[1m\]$/, '');
    m = m.replace(/-\d{8}$/, '');
    if (PRICING[m]) return PRICING[m];
    if (m === 'opus'   || m.indexOf('claude-opus') === 0)   return { in: 5,  out: 25 };
    if (m === 'fable'  || m.indexOf('claude-fable') === 0 || m.indexOf('claude-mythos') === 0) return { in: 10, out: 50 };
    if (m === 'sonnet' || m.indexOf('claude-sonnet') === 0) return { in: 3,  out: 15 };
    if (m === 'haiku'  || m.indexOf('claude-haiku') === 0)  return { in: 1,  out: 5 };
    return SONNET_PRICE;
  }
  function tokensFromUsage(u) {
    if (!u) return 0;
    return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  function costFromUsage(u, model) {
    if (!u) return 0;
    var p = priceFor(model);
    if (!p.in && !p.out) return 0;
    var inTok = u.input_tokens || 0;
    var outTok = u.output_tokens || 0;
    var readTok = u.cache_read_input_tokens || 0;
    var cc = u.cache_creation;
    var w5 = 0, w1 = 0;
    if (cc && ((cc.ephemeral_1h_input_tokens || 0) + (cc.ephemeral_5m_input_tokens || 0)) > 0) {
      w1 = cc.ephemeral_1h_input_tokens || 0;
      w5 = cc.ephemeral_5m_input_tokens || 0;
    } else {
      w5 = u.cache_creation_input_tokens || 0;
    }
    var usd = (
      inTok   * p.in +
      outTok  * p.out +
      readTok * p.in * 0.10 +
      w5      * p.in * 1.25 +
      w1      * p.in * 2.00
    ) / 1e6;
    return usd;
  }

  // =========================================================================
  // BREAKDOWN DIÁRIO (VERBATIM de main.js).
  // =========================================================================
  var DAILY_WINDOW_DAYS = 7;
  var DAY_MS = 86400000;
  function utcDayKeyMs(ms) {
    var d = new Date(ms);
    var y = d.getUTCFullYear();
    var mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    var da = String(d.getUTCDate()).padStart(2, '0');
    return '' + y + mo + da;
  }
  function utcMidnightMs(ms) {
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  function dailyWindowStartMs(now) {
    return utcMidnightMs(now) - (DAILY_WINDOW_DAYS - 1) * DAY_MS;
  }
  function dailyBucketize(entries, now) {
    var startMs = dailyWindowStartMs(now);
    var out = {};
    if (!Array.isArray(entries)) return out;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !Number.isFinite(e.ts)) continue;
      if (e.ts < startMs) continue;
      var k = utcDayKeyMs(e.ts);
      out[k] = (out[k] || 0) + (Number(e.tokens) || 0);
    }
    return out;
  }
  function addDailyTokens(map, now, tokens) {
    if (!map || typeof map !== 'object') return map;
    var k = utcDayKeyMs(now);
    map[k] = (map[k] || 0) + (Number(tokens) || 0);
    var startMs = dailyWindowStartMs(now);
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      if (!/^\d{8}$/.test(key)) { delete map[key]; continue; }
      var y = +key.slice(0, 4), mo = +key.slice(4, 6), da = +key.slice(6, 8);
      if (Date.UTC(y, mo - 1, da) < startMs) delete map[key];
    }
    return map;
  }

  // =========================================================================
  // DEDUPE (VERBATIM de main.js).
  // =========================================================================
  var USAGE_CAP = 5000, AGENT_CAP = 5000, TOOLS_CAP = 20000;
  var seenUsage = new Set(), seenAgents = new Set(), seenTools = new Set();
  function remember(set, key, cap) {
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > cap) { var first = set.values().next().value; set.delete(first); }
    return true;
  }
  function countNewSubagents(o) {
    var c = o && o.message && o.message.content;
    var k = 0;
    if (Array.isArray(c)) for (var i = 0; i < c.length; i++) {
      var b = c[i];
      if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
        if (b.id != null) { if (remember(seenAgents, b.id, AGENT_CAP)) k++; }
        else k++;
      }
    }
    return k;
  }

  // =========================================================================
  // SETUP → CIDADE (VERBATIM de main.js; hooks vêm injetados pelo Swift).
  // =========================================================================
  var toolTally = new Map(), modelTally = new Map(), skillTally = new Map();
  var SETUP_V = 1;
  var _settingsHooks = []; // Object.keys(settings.hooks) — injetado no init pelo Swift
  function normModelSlug(model) {
    if (!model) return null;
    var s = String(model).toLowerCase();
    if (s === '<synthetic>') return null;
    s = s.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '').replace(/^claude-/, '');
    return s || null;
  }
  function tallyForSetup(o, u) {
    var md = normModelSlug(o && o.message && o.message.model);
    if (md) modelTally.set(md, (modelTally.get(md) || 0) + tokensFromUsage(u));
  }
  function tallyTools(o) {
    var c = o && o.message && o.message.content;
    if (!Array.isArray(c)) return;
    for (var i = 0; i < c.length; i++) {
      var b = c[i];
      if (!b || b.type !== 'tool_use' || !b.name) continue;
      if (b.id != null && !remember(seenTools, b.id, TOOLS_CAP)) continue;
      toolTally.set(b.name, (toolTally.get(b.name) || 0) + 1);
      if (b.name === 'Skill' && b.input && b.input.skill) {
        var sk = String(b.input.skill);
        if (sk) skillTally.set(sk, (skillTally.get(sk) || 0) + 1);
      }
    }
  }
  function setupSlug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function setupToolName(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, '').slice(0, 48); }
  function uniq(a) { var seen = new Set(), out = []; for (var i = 0; i < a.length; i++) { var x = a[i]; if (x && !seen.has(x)) { seen.add(x); out.push(x); } } return out; }
  function collectSetup() {
    var tools = toolTally, models = modelTally, skillsUsed = skillTally;
    var skills = uniq(
      Array.from(skillsUsed.entries())
        .filter(function (e) { return e[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return setupSlug(e[0]); }).filter(Boolean)
    ).slice(0, 40);
    var mcpCounts = new Map();
    tools.forEach(function (v, k) {
      var mm = /^mcp__(.+?)__/.exec(String(k));
      if (mm) mcpCounts.set(mm[1], (mcpCounts.get(mm[1]) || 0) + Math.max(0, Number(v) || 0));
    });
    var mcp = uniq(
      Array.from(mcpCounts.entries())
        .filter(function (e) { return e[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return setupSlug(e[0]); }).filter(Boolean)
    ).slice(0, 20);
    var hooks = uniq((_settingsHooks || []).map(setupSlug)).slice(0, 12);
    var toolsArr = Array.from(tools.entries())
      .map(function (e) { return [setupToolName(e[0]), Math.max(0, Math.floor(Number(e[1]) || 0))]; })
      .filter(function (p) { return p[0] && p[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    var total = 0; models.forEach(function (v) { if (v > 0) total += v; });
    var modelsArr = [];
    if (total > 0) {
      modelsArr = Array.from(models.entries())
        .filter(function (e) { return e[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6)
        .map(function (e) { return [setupSlug(e[0]), Math.round((e[1] / total) * 1e4) / 1e4]; })
        .filter(function (p) { return p[0] && p[1] > 0; });
    }
    return { v: SETUP_V, skills: skills, mcp: mcp, hooks: hooks, tools: toolsArr, models: modelsArr };
  }

  // =========================================================================
  // ESTADO 3-VIAS — tailShape/combineShapes/resolveState (VERBATIM de main.js).
  // A leitura de tail deixa de usar fs: o Swift entrega o texto do tail; aqui só
  // parseamos as linhas (JSON.parse por linha; a 1ª parcial falha o parse e é
  // ignorada — mesmo efeito do descarte de linha cortada do readTailLines).
  // =========================================================================
  var IDLE_MS = 15000;
  var DECISION_MS = 4000;
  var THINK_MS = 30 * 60000;
  var RECENT_MS = 30 * 60000;
  var SUB_DECISION_MS = 22000;
  var AGENT_TOOLS = { Agent: true, Task: true };

  function contentBlocks(o) {
    var c = o && o.message && o.message.content;
    return Array.isArray(c) ? c : [];
  }
  function userText(o) {
    var c = o && o.message && o.message.content;
    if (typeof c === 'string') return c;
    var s = '';
    if (Array.isArray(c)) for (var i = 0; i < c.length; i++) { var b = c[i]; if (b && b.type === 'text') s += (b.text || ''); }
    return s;
  }
  function parseTail(text) {
    var out = [];
    if (!text) return out;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) {}
    }
    return out;
  }
  function tailShape(lines) {
    if (!lines || !lines.length) return 'idle';
    var answered = new Set();
    for (var a = 0; a < lines.length; a++) {
      var bl = contentBlocks(lines[a]);
      for (var b2 = 0; b2 < bl.length; b2++) {
        var blk = bl[b2];
        if (blk && blk.type === 'tool_result' && blk.tool_use_id) answered.add(blk.tool_use_id);
      }
    }
    var lastConv = null, lastAsst = -1;
    for (var i = lines.length - 1; i >= 0; i--) {
      var role = lines[i] && lines[i].message && lines[i].message.role;
      if (!lastConv && (role === 'assistant' || role === 'user')) lastConv = lines[i];
      if (role === 'assistant') { lastAsst = i; break; }
    }
    if (!lastConv) return 'idle';
    var pendingDecision = false, pendingAgent = false;
    if (lastAsst >= 0) {
      var rid = lines[lastAsst].requestId;
      for (var j = lastAsst; j >= 0; j--) {
        var o = lines[j], role2 = o && o.message && o.message.role;
        if (role2 !== 'assistant' || (rid != null && o.requestId !== rid)) break;
        var blocks = contentBlocks(o);
        for (var k = 0; k < blocks.length; k++) {
          var bk = blocks[k];
          if (bk && bk.type === 'tool_use' && bk.id && !answered.has(bk.id)) {
            if (AGENT_TOOLS[bk.name]) pendingAgent = true; else pendingDecision = true;
          }
        }
      }
    }
    if (pendingDecision) return 'decision';
    if (pendingAgent) return 'live';
    var lrole = lastConv.message.role;
    if (lrole === 'user') {
      if (userText(lastConv).indexOf('[Request interrupted') !== -1) return 'idle';
      return 'live';
    }
    var sr = lastConv.message.stop_reason;
    if (sr === 'end_turn' || sr === 'stop_sequence' || sr === 'max_tokens' || sr === 'refusal') return 'idle';
    return 'live';
  }
  function combineShapes(main, others) {
    var mShape = main && main.shape;
    var mSil = (main && main.silence) || 0;
    if (mShape === 'decision' && mSil >= DECISION_MS) return 'decision';
    var live = (mShape === 'live') || (mShape === 'decision');
    var needDecision = false;
    if (others) for (var i = 0; i < others.length; i++) {
      var o = others[i], s = o && o.shape, sil = (o && o.silence) || 0;
      if (s === 'decision') {
        if (sil >= SUB_DECISION_MS) needDecision = true;
        else live = true;
      } else if (s && s !== 'idle') {
        live = true;
      }
    }
    if (needDecision) return 'decision';
    return live ? 'live' : 'idle';
  }
  function resolveState(silence, shape) {
    if (shape === 'decision') return 'decision';
    if (silence < IDLE_MS) return 'live';
    if (shape === 'live') return silence < THINK_MS ? 'live' : 'idle';
    return 'idle';
  }
  function alertForTransition(prev, next) {
    if (prev === next) return null;
    if (prev == null) return null;
    if (next === 'decision' || next === 'idle') return next;
    return null;
  }

  // caminho de subagente: idêntico a main.js (separador POSIX '/').
  function isSubagentPath(f) { return f.indexOf('/subagents/') !== -1; }

  // =========================================================================
  // SANITIZADORES DO REPORT (VERBATIM de placar.js) — usados aqui pra montar o
  // corpo; o POST em si é feito pelo Swift (URLSession) por causa de CORS/ATS.
  // =========================================================================
  function nonNeg(n) { var v = Number(n); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0; }
  var ACCENT_SLUGS = ["dourado", "teal", "rosa", "violeta", "verde", "ambar"];
  function shapeProfile(cfg) {
    try {
      var p = {};
      if (typeof cfg.cityName === "string") { var c = cfg.cityName.trim(); p.cityName = c ? c.slice(0, 24) : ""; }
      if (typeof cfg.motto === "string") { var m = cfg.motto.trim(); p.motto = m ? m.slice(0, 48) : ""; }
      if (typeof cfg.accent === "string") { var aa = cfg.accent.trim().toLowerCase(); if (ACCENT_SLUGS.indexOf(aa) >= 0) p.accent = aa; }
      return Object.keys(p).length ? p : undefined;
    } catch (e) { return undefined; }
  }
  var CITY_MAX_BYTES = 2048;
  function byteLen(s) { try { return unescape(encodeURIComponent(s)).length; } catch (e) { return s.length; } }
  function sanitizeCity(c) {
    if (!c || typeof c !== "object") return null;
    var types = {};
    if (c.types && typeof c.types === "object") {
      for (var kk in c.types) { if (Object.prototype.hasOwnProperty.call(c.types, kk) && /^[a-z0-9-]{1,20}$/.test(kk)) types[kk] = nonNeg(c.types[kk]); }
    }
    var marcos = Array.isArray(c.marcos)
      ? c.marcos.filter(function (s) { return typeof s === "string" && /^[a-z0-9-]{1,20}$/.test(s); }).slice(0, 24) : [];
    var out = { v: 1, seed: nonNeg(c.seed), buildings: nonNeg(c.buildings), pop: nonNeg(c.pop), types: types, marcos: marcos, era: nonNeg(c.era) };
    while (byteLen(JSON.stringify(out)) > CITY_MAX_BYTES) {
      if (out.marcos.length) out.marcos = out.marcos.slice(0, -1);
      else { var keys = Object.keys(out.types); if (!keys.length) break; delete out.types[keys[keys.length - 1]]; }
    }
    return out;
  }
  var SETUP_MAX_BYTES = 3072;
  function slugList(a, cap) {
    if (!Array.isArray(a)) return [];
    var seen = new Set(), out = [];
    for (var i = 0; i < a.length; i++) { var s = setupSlug(a[i]); if (s && !seen.has(s)) { seen.add(s); out.push(s); if (out.length >= cap) break; } }
    return out;
  }
  function shapeSetup(raw) {
    try {
      if (!raw || typeof raw !== "object" || raw.v !== 1) return undefined;
      var tools = Array.isArray(raw.tools)
        ? raw.tools.filter(function (p) { return Array.isArray(p) && p.length === 2; })
            .map(function (p) { return [String(p[0]).replace(/[^A-Za-z0-9_.-]+/g, "").slice(0, 48), nonNeg(p[1])]; })
            .filter(function (p) { return p[0] && p[1] > 0; }).slice(0, 10) : [];
      var models = Array.isArray(raw.models)
        ? raw.models.filter(function (p) { return Array.isArray(p) && p.length === 2; })
            .map(function (p) { return [setupSlug(p[0]), Math.max(0, Math.min(1, Number(p[1]) || 0))]; })
            .filter(function (p) { return p[0] && p[1] > 0; }).slice(0, 6) : [];
      var out = { v: 1, skills: slugList(raw.skills, 40), mcp: slugList(raw.mcp, 20), hooks: slugList(raw.hooks, 12), tools: tools, models: models };
      if (byteLen(JSON.stringify(out)) > SETUP_MAX_BYTES) return undefined;
      return out;
    } catch (e) { return undefined; }
  }
  function shapeDailyTokens(raw) {
    try {
      if (!raw || typeof raw !== "object") return undefined;
      var keys = Object.keys(raw).filter(function (k) { return /^\d{8}$/.test(k); }).sort().reverse();
      var out = {}, n = 0;
      for (var i = 0; i < keys.length; i++) { var v = nonNeg(raw[keys[i]]); if (v > 0) { out[keys[i]] = v; if (++n >= 7) break; } }
      return n ? out : undefined;
    } catch (e) { return undefined; }
  }

  // =========================================================================
  // ESTADO MUTÁVEL DA TEMPORADA (equivalente às globais de main.js).
  // =========================================================================
  var seasonId = currentSeasonId();
  var seasonTokens = 0, costUSD = 0, subagents = 0;
  var history = [];
  var lastActivity = 0;
  var lastGrewJsonl = null;
  var activityByFile = new Map();
  var tailShapesCache = null;
  var lastDaily = {};
  var lastSetup = null;
  var lastCity = null;
  var lastAlertState = null;
  // acumuladores do backfill em streaming (o Swift manda 1 arquivo por vez)
  var _bfTk = 0, _bfAg = 0, _bfCost = 0, _bfDaily = [], _bfSeasonStart = 0, _bfDailyStart = 0;
  // callbacks registrados pelo game.js
  var _onUsage = null, _onSetup = null;
  // estado do reporter (equivalente a createReporter de placar.js)
  var _lastSent = 0;

  // processa o texto de linhas NOVAS de um transcript (equivalente ao miolo do
  // readNew de main.js). O Swift já cuidou de offset/últ-\n; aqui só parseamos.
  function processNewText(text) {
    var tk = 0, ag = 0, cost = 0;
    if (!text) return { tokens: 0, agents: 0, cost: 0 };
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var o; try { o = JSON.parse(line); } catch (e) { continue; }
      var u = o && o.message && o.message.usage;
      if (u) {
        var mid = o.message && o.message.id;
        var rid = o.requestId;
        var counted = true;
        if (mid != null && rid != null) counted = remember(seenUsage, mid + ':' + rid, USAGE_CAP);
        if (counted) {
          tk += tokensFromUsage(u);
          cost += costFromUsage(u, o.message.model);
          tallyForSetup(o, u);
        }
      }
      tallyTools(o);
      ag += countNewSubagents(o);
    }
    return { tokens: tk, agents: ag, cost: cost };
  }

  // vira a temporada em runtime (equivalente a rolloverIfNeeded de main.js).
  function rolloverIfNeeded(now) {
    var sid = currentSeasonId(now);
    if (sid === seasonId) return false;
    history.push({ seasonId: seasonId, tokens: seasonTokens, costUSD: costUSD, residents: subagents,
                   buildings: 2 + Math.floor(seasonTokens / TOK_PER_BUILD_REAL) });
    if (history.length > 60) history = history.slice(-60);
    seasonId = sid; seasonTokens = 0; costUSD = 0; subagents = 0;
    toolTally.clear(); modelTally.clear(); skillTally.clear();
    lastDaily = {};
    return true;
  }

  // ---- ESTADO: collectShapes/activeTranscript/computeState com tails injetados ----
  function silenceForFile(f, now) {
    if (!f) return Infinity;
    var t = activityByFile.get(f);
    return (t == null) ? Infinity : ((now || Date.now()) - t);
  }
  function activeTranscript(payload) {
    if (lastGrewJsonl) return lastGrewJsonl;
    if (payload && payload.maxMtimeFile && payload.maxMtimeFile.path) return payload.maxMtimeFile.path;
    return null;
  }
  function tailForPath(path, payload) {
    if (!path || !payload) return '';
    if (payload.recent) for (var i = 0; i < payload.recent.length; i++) { if (payload.recent[i].path === path) return payload.recent[i].tail || ''; }
    if (payload.maxMtimeFile && payload.maxMtimeFile.path === path) return payload.maxMtimeFile.tail || '';
    return '';
  }
  function collectShapes(now, payload) {
    var main = activeTranscript(payload);
    if (main && !activityByFile.has(main)) activityByFile.set(main, now);
    var mainShape = tailShape(parseTail(tailForPath(main, payload)));
    var others = [];
    var recent = (payload && payload.recent) || [];
    for (var i = 0; i < recent.length; i++) {
      var f = recent[i].path;
      if (f === main) continue;
      if (now - recent[i].mtimeMs > RECENT_MS) continue;
      if (!activityByFile.has(f)) activityByFile.set(f, now);
      others.push({ shape: tailShape(parseTail(recent[i].tail || '')), file: f });
    }
    return { mainShape: mainShape, mainFile: main, others: others };
  }
  function combineNow(c, now) {
    return combineShapes(
      { shape: c.mainShape, silence: silenceForFile(c.mainFile, now) },
      c.others.map(function (o) { return { shape: o.shape, silence: silenceForFile(o.file, now) }; })
    );
  }
  function computeState(now, payload) {
    if (tailShapesCache == null) tailShapesCache = collectShapes(now, payload);
    var shape = combineNow(tailShapesCache, now);
    return resolveState(now - lastActivity, shape);
  }

  // monta o corpo do report (equivalente a placar.js report()); DEVOLVE o corpo
  // (ou null) pro Swift postar. Reusa os sanitizadores VERBATIM acima.
  function buildReport(cfg, now) {
    try {
      if (!cfg || !cfg.enabled) return null;
      if (!cfg.url || !cfg.username) return null;
      if (now - _lastSent < 3 * 60 * 1000) return null; // THROTTLE_MS
      if (!cfg.key) return null;
      _lastSent = now;
      var body = {
        username: String(cfg.username).trim().toLowerCase(),
        key: cfg.key,
        seasonId: nonNeg(seasonId),
        tokens: nonNeg(seasonTokens),
        cost: Number(costUSD) >= 0 ? Number(costUSD) : 0,
        residents: nonNeg(subagents),
        buildings: 2 + Math.floor(nonNeg(seasonTokens) / TOK_PER_BUILD_REAL),
      };
      var city = sanitizeCity(lastCity);
      if (city) body.city = city;
      var profile = shapeProfile(cfg);
      if (profile) body.profile = profile;
      var daily = shapeDailyTokens(lastDaily);
      if (daily) body.dailyTokens = daily;
      if (cfg.shareSetup) { var setup = shapeSetup(lastSetup); if (setup) body.setup = setup; }
      return { url: cfg.url, body: body };
    } catch (e) { return null; }
  }

  function refreshSetup() {
    try { lastSetup = collectSetup(); } catch (e) {}
    try { if (_onSetup && lastSetup) _onSetup(lastSetup); } catch (e) {}
  }

  // =========================================================================
  // window.tt — API consumida pelo game.js (idêntica ao preload.js do Electron).
  // =========================================================================
  window.tt = {
    onUsage: function (cb) { _onUsage = cb; },
    onSetup: function (cb) { _onSetup = cb; },
    sendCity: function (city) { if (city && typeof city === 'object') lastCity = city; }
  };

  // =========================================================================
  // window.__tt — ponte chamada pelo Swift (I/O de arquivo/rede vive no Swift).
  // =========================================================================
  window.__tt = {
    // init: recebe o state.json em disco (ou null), a config do placar e os hooks
    // do settings.json. Decide retomar/arquivar a temporada (computeBoot).
    init: function (diskState, settingsHooks, now) {
      now = now || Date.now();
      _settingsHooks = Array.isArray(settingsHooks) ? settingsHooks : [];
      var b = computeBoot(diskState || null, now);
      seasonId = b.seasonId; seasonTokens = b.tokens; costUSD = b.costUSD;
      subagents = b.residents; history = b.history;
      return { seasonId: seasonId, seasonStart: SEASON_EPOCH + seasonId * SEASON_MS };
    },
    // backfillStart: zera tallies/dedupe (verdade da temporada = transcritos).
    backfillStart: function (now) {
      now = now || Date.now();
      toolTally.clear(); modelTally.clear(); skillTally.clear(); seenTools.clear();
      seenUsage.clear(); seenAgents.clear();
      _bfTk = 0; _bfAg = 0; _bfCost = 0; _bfDaily = [];
      _bfSeasonStart = SEASON_EPOCH + seasonId * SEASON_MS;
      _bfDailyStart = dailyWindowStartMs(now);
    },
    // backfillFile: uma varredura de arquivo (só arquivos com mtime>=seasonStart;
    // os demais não têm linha in-season). MESMO dedupe/gate de main.backfillSeason.
    backfillFile: function (content, now) {
      if (!content) return;
      var lines = content.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o.timestamp) continue;
        var ts = Date.parse(o.timestamp);
        if (!(ts >= _bfSeasonStart)) continue;
        var u = o.message && o.message.usage;
        if (u) {
          var mid = o.message && o.message.id;
          var rid = o.requestId;
          var counted = true;
          if (mid != null && rid != null) counted = remember(seenUsage, mid + ':' + rid, USAGE_CAP);
          if (counted) {
            var lineTk = tokensFromUsage(u);
            _bfTk += lineTk;
            _bfCost += costFromUsage(u, o.message.model);
            tallyForSetup(o, u);
            if (ts >= _bfDailyStart && lineTk > 0) _bfDaily.push({ ts: ts, tokens: lineTk });
          }
        }
        tallyTools(o);
        _bfAg += countNewSubagents(o);
      }
    },
    // backfillDone: fecha o backfill, calcula o diário, e dispara o 1º onSetup +
    // 1º onUsage (estado inicial). DEVOLVE o resumo pro Swift logar/comparar.
    backfillDone: function (now) {
      now = now || Date.now();
      seasonTokens = _bfTk; costUSD = _bfCost; subagents = _bfAg;
      lastDaily = dailyBucketize(_bfDaily, now);
      if (_bfTk > 0) lastActivity = Date.now();
      refreshSetup();
      var st = 'idle';
      try {
        if (_onUsage) _onUsage({ total: seasonTokens, added: 0, state: st, live: false,
                                 residents: subagents, cost: costUSD, seasonId: seasonId, daysLeft: daysLeftIn(now) });
      } catch (e) {}
      lastAlertState = st; // baseline silencioso (equivale ao 1º poll do Electron)
      return { tokens: seasonTokens, cost: costUSD, subagents: subagents, seasonId: seasonId,
               daily: JSON.stringify(lastDaily), setup: JSON.stringify(lastSetup) };
    },
    // poll: processa as linhas novas + sinais de atividade + tails, computa o
    // estado, chama onUsage, e DEVOLVE ao Swift {notify, report} p/ ele agir.
    poll: function (payload, now) {
      now = now || Date.now();
      payload = payload || {};
      rolloverIfNeeded(now);
      var addedTk = 0, addedAg = 0, addedCost = 0, grew = false;
      var files = payload.files || [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var r = processNewText(f.newText || '');
        addedTk += r.tokens; addedAg += r.agents; addedCost += r.cost;
        grew = true;
        activityByFile.set(f.path, now);
        if (!isSubagentPath(f.path)) lastGrewJsonl = f.path;
      }
      if (payload.taskGrew) grew = true;
      if (grew) { lastActivity = Date.now(); tailShapesCache = null; }
      if (addedTk > 0) addDailyTokens(lastDaily, now, addedTk);
      if (addedTk > 0) seasonTokens += addedTk;
      if (addedAg > 0) subagents += addedAg;
      if (addedCost > 0) costUSD += addedCost;

      var st = computeState(Date.now(), payload);
      var notify = null;
      var k = alertForTransition(lastAlertState, st);
      if (k) notify = k; // o Swift decide suprimir se a janela estiver focada
      lastAlertState = st;

      try {
        if (_onUsage) _onUsage({ total: seasonTokens, added: addedTk, state: st, live: st === 'live',
                                 residents: subagents, cost: costUSD, seasonId: seasonId, daysLeft: daysLeftIn(now) });
      } catch (e) {}

      var report = buildReport(payload.config, now);
      return { notify: notify, report: report, state: st,
               total: seasonTokens, residents: subagents, cost: costUSD };
    },
    // refreshSetup periódico (o Swift chama a cada ~5min, como o Electron).
    tickSetup: function () { refreshSetup(); },
    // introspecção p/ verificação (logada pelo Swift): estado interno vivo.
    peek: function () {
      return { seasonTokens: seasonTokens, costUSD: costUSD, subagents: subagents, seasonId: seasonId,
               hasCity: !!lastCity, lastAlertState: lastAlertState, daily: JSON.stringify(lastDaily),
               city: lastCity ? JSON.stringify(lastCity) : null };
    }
  };
})();
