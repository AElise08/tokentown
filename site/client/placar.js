// TOKENTOWN — cliente de report pro placar.
// Módulo CommonJS puro (Node 18+). Zero dependências: usa fetch global, fs,
// path e crypto do próprio Node. Feito pra ser copiado pra dentro do app
// TOKENTOWN e chamado dentro do loop de polling.
//
//   const { createReporter } = require('./client/placar');
//   const reporter = createReporter({ configPath: '~/.tokentown-placar.json resolvido' });
//   reporter.report({ seasonId, tokens, cost, residents, buildings, city });
//   // `city` é OPCIONAL: { v:1, seed, buildings, pop, types, marcos, era }
//
// FILOSOFIA: falha de rede NUNCA quebra o app. Tudo é try/catch + fire-and-forget.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const THROTTLE_MS = 3 * 60 * 1000; // no máximo 1 report a cada 3 min
const RETRY_MS = 20 * 1000; // 1 retentativa silenciosa após 20s se a rede falhar

const DEFAULT_CONFIG = {
  enabled: false, // vira true quando a pessoa quiser entrar no placar
  username: "", // [a-z0-9-]{2,24}
  key: "", // gerada automaticamente na 1ª ativação
  url: "", // ex.: https://SEU-PLACAR.vercel.app/api/report
  shareSetup: false, // opt-in: compartilhar o setup (skills/mcp/hooks/tools/models) no placar
  // PERSONALIZAÇÃO LEVE (opcional) — editada à mão pela pessoa no config:
  cityName: "", // nome da cidade (<= 24 chars). Ex.: "Meltown"
  motto: "", // lema em itálico no /u (<= 48 chars). Ex.: "feita de tokens e teimosia"
  accent: "", // cor de destaque: dourado | teal | rosa | violeta | verde | ambar
};

// Cores de destaque aceitas (o servidor revalida; aqui só filtramos o óbvio).
const ACCENT_SLUGS = ["dourado", "teal", "rosa", "violeta", "verde", "ambar"];

// Monta o campo opcional `profile` a partir do config. Shaping LEVE (tamanho +
// accent da lista); o servidor sanitiza duro de novo. undefined se nada válido.
function shapeProfile(cfg) {
  try {
    const p = {};
    // cityName/motto: valor não-vazio -> envia (cortado no cap); string vazia ""
    // -> envia "" (sinal de LIMPEZA: apaga o guardado no servidor); ausente/
    // não-string -> nem entra (o servidor PRESERVA o que já existe).
    if (typeof cfg.cityName === "string") {
      const c = cfg.cityName.trim();
      p.cityName = c ? c.slice(0, 24) : "";
    }
    if (typeof cfg.motto === "string") {
      const m = cfg.motto.trim();
      p.motto = m ? m.slice(0, 48) : "";
    }
    if (typeof cfg.accent === "string") {
      const a = cfg.accent.trim().toLowerCase();
      if (ACCENT_SLUGS.indexOf(a) >= 0) p.accent = a;
    }
    return Object.keys(p).length ? p : undefined;
  } catch (_e) {
    return undefined;
  }
}

function readConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_CONFIG, parsed);
  } catch (_e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function writeConfig(configPath, cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch (_e) {
    /* se não der pra gravar, seguimos sem persistir — nunca quebra o app */
  }
}

function newKey() {
  return crypto.randomBytes(24).toString("hex"); // 48 chars
}

function nonNeg(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

// Dá forma ao campo opcional `city` no MESMO shape do contrato do placar:
//   { v:1, seed:<uint32>, buildings:<int>, pop:<int>,
//     types:{<string>:<int>}, marcos:[<string>], era:<int> }
// Retorna undefined se não houver cidade válida (app antigo -> nem manda o campo).
// O servidor revalida/sanitiza tudo de novo; aqui só garantimos o formato.
const MARCO_RE = /^[a-z-]{1,24}$/;
function shapeCity(raw) {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    if (raw.v !== 1) return undefined;
    const seed = Number(raw.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return undefined;

    const types = {};
    if (raw.types && typeof raw.types === "object") {
      const keys = Object.keys(raw.types);
      for (let i = 0; i < keys.length && Object.keys(types).length < 24; i++) {
        const k = String(keys[i]).slice(0, 24);
        const v = nonNeg(raw.types[keys[i]]);
        if (k && v > 0) types[k] = v;
      }
    }

    const marcos = [];
    if (Array.isArray(raw.marcos)) {
      for (let j = 0; j < raw.marcos.length && marcos.length < 16; j++) {
        const m = String(raw.marcos[j]).trim().toLowerCase();
        if (MARCO_RE.test(m) && marcos.indexOf(m) < 0) marcos.push(m);
      }
    }

    return {
      v: 1,
      seed: seed >>> 0,
      buildings: nonNeg(raw.buildings),
      pop: nonNeg(raw.pop),
      types: types,
      marcos: marcos,
      era: nonNeg(raw.era),
    };
  } catch (_e) {
    return undefined;
  }
}

// Sanitização LEVE do blob de setup (opt-in) antes do POST — o servidor revalida.
// Contrato: { v:1, skills:[slug], mcp:[slug], hooks:[slug], tools:[[name,count]],
//             models:[[name,frac]] }. Só nomes e contagens; NUNCA prompt/código/caminho.
// Caps: skills<=40, mcp<=20, hooks<=12, tools<=10, models<=6. Se o JSON passar de
// ~3KB, DESCARTA o setup inteiro (o report segue sem ele). undefined = não anexar.
const SETUP_MAX_BYTES = 3072;
function setupSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function slugList(a, cap) {
  if (!Array.isArray(a)) return [];
  const seen = new Set(), out = [];
  for (const x of a) {
    const s = setupSlug(x);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); if (out.length >= cap) break; }
  }
  return out;
}
function shapeSetup(raw) {
  try {
    if (!raw || typeof raw !== "object" || raw.v !== 1) return undefined;
    const tools = Array.isArray(raw.tools)
      ? raw.tools
          .filter((p) => Array.isArray(p) && p.length === 2)
          .map((p) => [String(p[0]).replace(/[^A-Za-z0-9_.-]+/g, "").slice(0, 48), nonNeg(p[1])])
          .filter((p) => p[0] && p[1] > 0)
          .slice(0, 10)
      : [];
    const models = Array.isArray(raw.models)
      ? raw.models
          .filter((p) => Array.isArray(p) && p.length === 2)
          .map((p) => [setupSlug(p[0]), Math.max(0, Math.min(1, Number(p[1]) || 0))])
          .filter((p) => p[0] && p[1] > 0)
          .slice(0, 6)
      : [];
    const out = {
      v: 1,
      skills: slugList(raw.skills, 40),
      mcp: slugList(raw.mcp, 20),
      hooks: slugList(raw.hooks, 12),
      tools: tools,
      models: models,
    };
    if (Buffer.byteLength(JSON.stringify(out)) > SETUP_MAX_BYTES) return undefined;
    return out;
  } catch (_e) {
    return undefined;
  }
}

// BREAKDOWN DIÁRIO (heatmap "CITY LIGHTS · THIS WEEK"): { AAAAMMDD: tokens } dos últimos
// 7 dias UTC. Shaping LEVE — só chaves AAAAMMDD e ints>=0, no máx. 7 (as mais recentes);
// o servidor revalida a janela plausível + tetos. undefined se nada válido (não anexa).
function shapeDailyTokens(raw) {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const keys = Object.keys(raw).filter((k) => /^\d{8}$/.test(k)).sort().reverse();
    const out = {};
    let n = 0;
    for (const k of keys) {
      const v = nonNeg(raw[k]);
      if (v > 0) { out[k] = v; if (++n >= 7) break; }
    }
    return n ? out : undefined;
  } catch (_e) {
    return undefined;
  }
}

function createReporter({ configPath }) {
  if (!configPath) throw new Error("createReporter: configPath é obrigatório");

  let cfg = readConfig(configPath);

  // Garante que o arquivo existe (cria com defaults na primeira vez).
  if (!fs.existsSync(configPath)) writeConfig(configPath, cfg);

  // 1ª ativação: se habilitado e ainda sem key, gera e persiste.
  if (cfg.enabled && !cfg.key) {
    cfg.key = newKey();
    writeConfig(configPath, cfg);
  }

  let lastSent = 0;
  let inFlight = false;

  function send(body, isRetry) {
    // fetch global do Node 18+/Electron. Se não existir, desiste em silêncio.
    if (typeof fetch !== "function") return;
    inFlight = true;
    Promise.resolve()
      .then(() =>
        fetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      )
      .then((res) => {
        inFlight = false;
        // 4xx (403/429/400) não adianta retentar; só a falha de REDE retenta.
        return res;
      })
      .catch(() => {
        inFlight = false;
        if (!isRetry) {
          const t = setTimeout(() => send(body, true), RETRY_MS);
          if (t && typeof t.unref === "function") t.unref(); // não segura o event loop
        }
      });
  }

  // Chame no loop do app. `snapshot` = total absoluto DA TEMPORADA.
  function report(snapshot) {
    try {
      // RE-LÊ o config do disco a cada report: o reporter é criado uma vez no
      // startup, então sem isto uma edição de cityName/motto/accent (ou enabled/
      // url) só valeria após reiniciar o app. Barato: o loop chama isto a cada
      // poll (~2.5s) e o arquivo é minúsculo.
      const fresh = readConfig(configPath);
      if (!fresh.key && cfg.key) fresh.key = cfg.key; // preserva key gerada em runtime
      cfg = fresh;

      if (!cfg.enabled) return;
      if (!cfg.url || !cfg.username) return; // sem destino/nome, não há o que reportar

      const now = Date.now();
      if (now - lastSent < THROTTLE_MS) return; // throttle interno
      if (inFlight) return;

      // Gera key na hora se a pessoa habilitou editando o config na mão.
      if (!cfg.key) {
        cfg.key = newKey();
        writeConfig(configPath, cfg);
      }

      const payload = {
        username: String(cfg.username).trim().toLowerCase(),
        key: cfg.key,
        seasonId: nonNeg(snapshot && snapshot.seasonId),
        tokens: nonNeg(snapshot && snapshot.tokens),
        cost: Number(snapshot && snapshot.cost) >= 0 ? Number(snapshot.cost) : 0,
        residents: nonNeg(snapshot && snapshot.residents),
        buildings: nonNeg(snapshot && snapshot.buildings),
      };
      // cidade REAL (opcional): só entra no payload se vier num shape válido.
      const city = shapeCity(snapshot && snapshot.city);
      if (city) payload.city = city;

      // PERSONALIZAÇÃO (opcional): cityName/motto/accent do config.
      const profile = shapeProfile(cfg);
      if (profile) payload.profile = profile;

      // BREAKDOWN DIÁRIO: 7 dias UTC reais -> heatmap "CITY LIGHTS" da semana. Sem ele, o
      // servidor preserva os snapshots diários que já tem (report antigo não apaga).
      const daily = shapeDailyTokens(snapshot && snapshot.dailyTokens);
      if (daily) payload.dailyTokens = daily;

      // SETUP (opt-in): só entra no payload se shareSetup e o blob for válido/pequeno.
      if (cfg.shareSetup) {
        const setup = shapeSetup(snapshot && snapshot.setup);
        if (setup) payload.setup = setup;
      }

      lastSent = now;
      send(payload, false);
    } catch (_e) {
      /* qualquer erro inesperado é engolido — o app é sagrado */
    }
  }

  return {
    report,
    isEnabled: () => !!cfg.enabled,
    getConfig: () => Object.assign({}, cfg),
    configPath,
  };
}

module.exports = { createReporter, shapeSetup, shapeDailyTokens };
