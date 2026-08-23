import { createHash, randomUUID } from "crypto";
import { currentSeasonId, isReportSeasonValid } from "./season";
import { sanitizeCity, type RealCity } from "./city";
import { sanitizeProfile, mergeProfile, type Profile } from "./profile";
import { sanitizeSetup, type Setup } from "./setup";
import {
  parseSnaps,
  rankWindow,
  seasonPosition,
  utcDayKey,
  dayKeyRefMs,
  MAX_SNAP_DAYS,
  type WindowKind,
  type UserWindowInput,
  type SnapPoint,
} from "./window";
import {
  effectiveSponsorStatus,
  nextSponsorWindow,
  sanitizeSponsorDraft,
  SPONSOR_DRAFT_RETENTION_MS,
  SPONSOR_DURATION_MS,
  SPONSOR_GAP_MS,
  SPONSOR_HISTORY_RETENTION_MS,
  toPublicSponsor,
  type PublicSponsor,
  type PublicSponsorSlot,
  type SponsorCampaign,
} from "./sponsor";

export type { WindowKind, SnapPoint, UserWindowInput } from "./window";
export { utcDayKey, dayKeyRefMs, parseSnaps, windowDelta, rankWindow, MAX_SNAP_DAYS, WINDOW_7D_MS } from "./window";

// ---------------------------------------------------------------------------
// TIPOS
// ---------------------------------------------------------------------------
export interface Entry {
  username: string;
  tokens: number;
  cost: number;
  residents: number;
  buildings: number;
  lastReport: number;
  // CIDADE REAL (opcional). Sanitizada na escrita e revalidada na leitura.
  city?: RealCity | null;
  // PERSONALIZAÇÃO LEVE (opcional): nome da cidade, lema, cor de destaque.
  // Sanitizada na escrita e revalidada na leitura; report sem profile PRESERVA
  // o que já existe.
  profile?: Profile | null;
  // SETUP (opcional, opt-in): skills/mcp/hooks/ferramentas/modelos — nomes e
  // contagens que viram a cidade. Sanitizado na escrita, revalidado na leitura;
  // report sem setup PRESERVA o guardado, `setup:null` explícito LIMPA.
  setup?: Setup | null;
}

export interface RankedEntry extends Entry {
  position: number;
  // Valores ABSOLUTOS da temporada — usados pra skyline e referência. Quando a
  // janela é "season" são iguais a tokens/cost; quando é "7d", tokens/cost já
  // vêm como o DELTA da janela e seasonTokens/seasonCost guardam o total real.
  seasonTokens: number;
  seasonCost: number;
  // Janela 7d: não havia snapshot com +7 dias (usuário novo / registro recente),
  // então o delta é o total dele — marcado discretamente como "desde o registro".
  sinceRegister?: boolean;
}

export type ReportInput = {
  username: string;
  key: string;
  seasonId: number;
  tokens: number;
  cost: number;
  residents: number;
  buildings: number;
  // Identifica a familia do contador absoluto. Quando o algoritmo/leitor muda,
  // o servidor ancora a nova base e passa a aplicar somente seus deltas.
  counterId?: unknown;
  city?: unknown; // payload BRUTO da cidade real; sanitizado aqui dentro.
  profile?: unknown; // payload BRUTO do perfil (cityName/motto/accent); sanitizado aqui dentro.
  setup?: unknown; // payload BRUTO do setup (skills/mcp/hooks/tools/models); sanitizado aqui dentro.
  dailyTokens?: unknown; // payload BRUTO do breakdown diário { AAAAMMDD: tokens }; sanitizado aqui.
};

export type ReportResult =
  | { ok: true; status: 200; updated: boolean; rebased: boolean; entry: Entry }
  | { ok: false; status: 400 | 403 | 429; error: string };

// ---------------------------------------------------------------------------
// LIMITES DE SANIDADE — teto pra não deixar um report absurdo dominar o placar.
// ---------------------------------------------------------------------------
export const CAPS = {
  tokens: 10e9, // 10 bilhões
  cost: 1e7, // US$ 10 milhões
  residents: 1e7,
  buildings: 1e7,
};
const RATE_LIMIT_SEC = 60; // 1 report/min por username

// ---------------------------------------------------------------------------
// INTERFACE KV mínima — implementada por Redis (Upstash) e por memória.
// ---------------------------------------------------------------------------
interface KV {
  backend: "upstash" | "memory" | "node-redis" | "memory-fallback";
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, obj: Record<string, string | number>): Promise<void>;
  hincrby(key: string, field: string, amount: number): Promise<number>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string | number> | null>;
  zadd(key: string, score: number, member: string): Promise<void>;
  // remove member from ZSET (no-op if absent)
  zrem(key: string, member: string): Promise<void>;
  // delete a whole key (hash / zset / string)
  del(key: string): Promise<void>;
  // top N por score DESC -> [{ member, score }]
  ztop(key: string, n: number): Promise<Array<{ member: string; score: number }>>;
  // SET key val NX EX ttl -> true se conseguiu setar (não existia)
  setNxEx(key: string, val: string, ttlSec: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// BACKEND: Upstash Redis via @upstash/redis
// ---------------------------------------------------------------------------
// Aceita os nomes que o Vercel/Upstash podem injetar: o Marketplace do Upstash
// usa UPSTASH_REDIS_REST_*, integrações antigas (Vercel KV) usam KV_REST_API_*.
// Pega o primeiro disponível — assim funciona com qualquer um.
function redisCreds(): { url: string; token: string } {
  const env = process.env as Record<string, string | undefined>;
  const isHttps = (v?: string) => !!v && /^https:\/\//.test(v);
  // 1) Nomes explícitos conhecidos (Upstash Marketplace, Vercel KV, ou prefixo
  //    custom — o Vercel deixa você nomear; aqui a Mel usou "tokentown").
  const uNames = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "STORAGE_REST_API_URL",
    "tokentown_REST_API_URL", "tokentown_KV_REST_API_URL", "TOKENTOWN_REST_API_URL"];
  const tNames = ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "STORAGE_REST_API_TOKEN",
    "tokentown_REST_API_TOKEN", "tokentown_KV_REST_API_TOKEN", "TOKENTOWN_REST_API_TOKEN"];
  let url = uNames.map((n) => env[n]).find((v) => isHttps(v)) || "";
  let token = tNames.map((n) => env[n]).find(Boolean) || "";
  if (url && token) return { url, token };
  // 2) Robusto: acha a URL REST do Upstash pelo VALOR (https://...upstash), seja
  //    qual for o prefixo/nome; o token vem do mesmo prefixo (…URL -> …TOKEN).
  let urlKey = "";
  if (!url) {
    for (const k of Object.keys(env)) {
      const v = env[k] || "";
      if (/URL$/i.test(k) && /^https:\/\/[^ ]*upstash/i.test(v)) { url = v; urlKey = k; break; }
    }
  }
  if (urlKey && !token) token = env[urlKey.replace(/URL$/i, "TOKEN")] || "";
  // 3) Último recurso: qualquer *TOKEN longo e não read-only.
  if (url && !token) {
    for (const k of Object.keys(env)) {
      const v = env[k] || "";
      if (/TOKEN$/i.test(k) && !/READ.?ONLY/i.test(k) && v.length >= 24) { token = v; break; }
    }
  }
  return { url, token };
}
function makeUpstashKV(): KV {
  // require dinâmico pra o fallback em memória não exigir o pacote instalado.
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  const c = redisCreds();
  const redis = new Redis({ url: c.url, token: c.token });
  return {
    backend: "upstash",
    async hget(key, field) {
      const v = await redis.hget<string | number>(key, field);
      return v == null ? null : String(v);
    },
    async hset(key, obj) {
      await redis.hset(key, obj);
    },
    async hincrby(key, field, amount) {
      return Number(await redis.hincrby(key, field, amount));
    },
    async hdel(key, field) {
      await redis.hdel(key, field);
    },
    async hgetall(key) {
      return (await redis.hgetall(key)) as Record<string, string | number> | null;
    },
    async zadd(key, score, member) {
      await redis.zadd(key, { score, member });
    },
    async zrem(key, member) {
      await redis.zrem(key, member);
    },
    async del(key) {
      await redis.del(key);
    },
    async ztop(key, n) {
      // rev + withScores -> [member, score, member, score, ...]
      const raw = (await redis.zrange(key, 0, n - 1, { rev: true, withScores: true })) as Array<
        string | number
      >;
      const out: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        out.push({ member: String(raw[i]), score: Number(raw[i + 1]) });
      }
      return out;
    },
    async setNxEx(key, val, ttlSec) {
      const r = await redis.set(key, val, { nx: true, ex: ttlSec });
      return r === "OK";
    },
  };
}

// ---------------------------------------------------------------------------
// BACKEND: memória (dev local sem Redis). Vive só enquanto o processo vive.
// Os Maps ficam no globalThis pra serem COMPARTILHADOS entre a página (RSC) e
// as route handlers (que o Next dev empacota separadamente) e pra sobreviver
// aos recompiles do hot-reload. Em produção o Upstash cuida disso.
// ---------------------------------------------------------------------------
interface MemStore {
  hashes: Map<string, Map<string, string | number>>;
  zsets: Map<string, Map<string, number>>;
  expires: Map<string, number>; // key -> epoch ms de expiração
}
const glob = globalThis as unknown as { __ttpMem?: MemStore };

function memStore(): MemStore {
  if (!glob.__ttpMem) {
    glob.__ttpMem = { hashes: new Map(), zsets: new Map(), expires: new Map() };
  }
  return glob.__ttpMem;
}

function makeMemoryKV(): KV {
  const { hashes, zsets, expires } = memStore();

  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!;

  return {
    backend: "memory",
    async hget(key, field) {
      const v = hashes.get(key)?.get(field);
      return v == null ? null : String(v);
    },
    async hset(key, obj) {
      const m = h(key);
      for (const [f, v] of Object.entries(obj)) m.set(f, v);
    },
    async hincrby(key, field, amount) {
      const m = h(key);
      const next = (Number(m.get(field)) || 0) + amount;
      m.set(field, next);
      return next;
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field);
    },
    async hgetall(key) {
      const m = hashes.get(key);
      if (!m || m.size === 0) return null;
      return Object.fromEntries(m);
    },
    async zadd(key, score, member) {
      z(key).set(member, score);
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
    },
    async del(key) {
      hashes.delete(key);
      zsets.delete(key);
      expires.delete(key);
    },
    async ztop(key, n) {
      const m = zsets.get(key);
      if (!m) return [];
      return [...m.entries()]
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, n);
    },
    async setNxEx(key, val, ttlSec) {
      const now = Date.now();
      const exp = expires.get(key);
      if (exp && exp <= now) {
        hashes.delete(key);
        expires.delete(key);
      }
      if (expires.has(key)) return false; // ainda válido -> rate limited
      expires.set(key, now + ttlSec * 1000);
      h(key).set("v", val);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Escolha do backend (uma vez por processo — cacheada no globalThis pra
// sobreviver aos recompiles do Next dev e ser a mesma pra página e API).
// ---------------------------------------------------------------------------
// BACKEND: Redis NATIVO (rediss://) via node-redis — pro caso em que a
// integração do Vercel injeta só a URL nativa (ex.: tokentown_REDIS_URL), sem
// endpoint REST. FAIL-FAST POR CONSTRUÇÃO: connect com timeout curto, sem
// reconnect, e CADA operação corre contra um timeout; QUALQUER falha derruba
// pro fallback em memória — a página NUNCA fica pendurada esperando o Redis.
// ---------------------------------------------------------------------------
function findNativeRedisUrl(): string {
  const env = process.env as Record<string, string | undefined>;
  // nomes óbvios primeiro (o prefixo aqui é o do projeto: "tokentown")
  for (const n of ["tokentown_REDIS_URL", "TOKENTOWN_REDIS_URL", "REDIS_URL", "STORAGE_REDIS_URL"]) {
    if (/^rediss?:\/\//.test(env[n] || "")) return env[n]!;
  }
  for (const k of Object.keys(env)) {
    if (/^rediss?:\/\//.test(env[k] || "")) return env[k]!;
  }
  return "";
}

function makeNodeRedisKV(url: string): KV {
  const mem = makeMemoryKV();
  let dead = false;
  let warned = false;
  const warnOnce = (e: unknown) => {
    if (!warned) {
      console.warn("[tokentown-placar] redis nativo indisponível — caindo pra MEMÓRIA:", (e as Error)?.message);
      warned = true;
    }
  };
  // import() dinâmico: funciona no bundle do Next E em Node ESM puro (testes).
  type RedisClient = import("redis").RedisClientType;
  const clientP: Promise<RedisClient | null> = (async () => {
    const { createClient } = await import("redis");
    const c = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
    c.on("error", () => { /* sem listener, node-redis derruba o processo */ });
    await c.connect();
    return c as RedisClient;
  })().catch((e: unknown) => { dead = true; warnOnce(e); return null; });
  const T = <X,>(p: Promise<X>): Promise<X> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("redis timeout")), 2500))]);
  const self: KV = {
    backend: "node-redis",
    async hget(key, field) {
      return guard(async (c) => {
        const v = await c.hGet(key, field);
        return v == null ? null : String(v);
      }, () => mem.hget(key, field));
    },
    async hset(key, obj) {
      return guard((c) => c.hSet(key, obj as Record<string, string | number>).then(() => undefined), () => mem.hset(key, obj));
    },
    async hincrby(key, field, amount) {
      return guard((c) => c.hIncrBy(key, field, amount), () => mem.hincrby(key, field, amount));
    },
    async hdel(key, field) {
      return guard((c) => c.hDel(key, field).then(() => undefined), () => mem.hdel(key, field));
    },
    async hgetall(key) {
      return guard(async (c) => {
        const r = await c.hGetAll(key);
        return r && Object.keys(r).length ? (r as unknown as Record<string, string | number>) : null;
      }, () => mem.hgetall(key));
    },
    async zadd(key, score, member) {
      return guard((c) => c.zAdd(key, { score, value: member }).then(() => undefined), () => mem.zadd(key, score, member));
    },
    async zrem(key, member) {
      return guard((c) => c.zRem(key, member).then(() => undefined), () => mem.zrem(key, member));
    },
    async del(key) {
      return guard((c) => c.del(key).then(() => undefined), () => mem.del(key));
    },
    async ztop(key, n) {
      return guard(async (c) => {
        const r = await c.zRangeWithScores(key, 0, n - 1, { REV: true });
        return r.map((x) => ({ member: String(x.value), score: Number(x.score) }));
      }, () => mem.ztop(key, n));
    },
    async setNxEx(key, val, ttlSec) {
      return guard(async (c) => {
        const r = await c.set(key, val, { NX: true, EX: ttlSec });
        return r === "OK";
      }, () => mem.setNxEx(key, val, ttlSec));
    },
  };
  async function guard<X>(op: (c: RedisClient) => Promise<X>, fb: () => Promise<X>): Promise<X> {
    if (dead) return fb();
    try {
      const c = await T(clientP);
      if (!c || dead) return fb();
      return await T(op(c));
    } catch (e) {
      dead = true;
      self.backend = "memory-fallback"; // /api/health passa a mostrar a verdade
      warnOnce(e);
      return fb();
    }
  }
  return self;
}

// ---------------------------------------------------------------------------
const globKv = globalThis as unknown as { __ttpKv?: KV; __ttpWarned?: boolean };

function kv(): KV {
  if (globKv.__ttpKv) return globKv.__ttpKv;
  const c = redisCreds();
  if (c.url && c.token) {
    globKv.__ttpKv = makeUpstashKV();
    return globKv.__ttpKv;
  }
  const native = findNativeRedisUrl();
  if (native) {
    globKv.__ttpKv = makeNodeRedisKV(native);
    return globKv.__ttpKv;
  }
  if (!globKv.__ttpWarned) {
    console.warn(
      "[tokentown-placar] nenhuma credencial de Redis (REST ou nativa) — usando storage EM MEMÓRIA (dados somem ao reiniciar)."
    );
    globKv.__ttpWarned = true;
  }
  globKv.__ttpKv = makeMemoryKV();
  return globKv.__ttpKv;
}

// Saúde do storage — usada por /api/health: backend ativo + roundtrip REAL.
export async function storeHealth(): Promise<{ backend: string; roundtrip: boolean }> {
  const k = kv();
  try {
    const val = String(Date.now());
    await k.hset("tt:health", { ping: val });
    const got = await k.hget("tt:health", "ping");
    return { backend: k.backend, roundtrip: got === val };
  } catch {
    return { backend: k.backend, roundtrip: false };
  }
}

// ---------------------------------------------------------------------------
// CHAVES
// ---------------------------------------------------------------------------
const kRank = (s: number) => `s${s}:rank`; // ZSET score=tokens
const kUser = (s: number, u: string) => `s${s}:u:${u}`; // HASH detalhes
const kSnap = (s: number, u: string) => `s${s}:snap:${u}`; // HASH dia AAAAMMDD -> "tokens|cost"
const kRate = (u: string) => `rl:${u}`; // rate limit
const K_USERS = "users"; // HASH username -> keyHash
const K_SITE_METRICS = "tt:site:metrics";
const K_SPONSORS = "tt:sponsors:campaigns";
const K_SPONSOR_SCHEDULE_LOCK = "tt:sponsors:schedule-lock";
const kSponsorCheckoutRate = (email: string) =>
  `tt:sponsors:checkout-rate:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
const shortPrivateHash = (scope: string, value: string) =>
  createHash("sha256")
    .update(`${scope}:${process.env.SPONSOR_ADMIN_KEY || "local"}:${value}`)
    .digest("hex")
    .slice(0, 32);

// Reset do storage EM MEMÓRIA — só pra testes de lib (limpa maps e cache do KV).
export function __resetStoreForTests(): void {
  const g = globalThis as unknown as { __ttpMem?: unknown; __ttpKv?: unknown; __ttpWarned?: boolean };
  g.__ttpMem = undefined;
  g.__ttpKv = undefined;
  g.__ttpWarned = true; // silencia o aviso de "storage em memória" nos testes
}

// ---------------------------------------------------------------------------
// SANITIZAÇÃO
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-z0-9-]{2,24}$/;
const COUNTER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function sanitizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

function sanitizeCounterId(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return COUNTER_ID_RE.test(id) ? id : null;
}

type CounterCheckpoint = {
  id: string;
  tokens: number;
  cost: number;
  residents: number;
  buildings: number;
};

function parseCounterCheckpoint(h: Record<string, string | number> | null): CounterCheckpoint | null {
  if (!h || typeof h.counterId !== "string" || !COUNTER_ID_RE.test(h.counterId)) return null;
  return {
    id: h.counterId,
    tokens: Number(h.counterTokens) || 0,
    cost: Number(h.counterCost) || 0,
    residents: Number(h.counterResidents) || 0,
    buildings: Number(h.counterBuildings) || 0,
  };
}

function num(raw: unknown, cap: number): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null; // negativo/NaN/Infinity -> inválido
  return Math.min(n, cap); // clampa no teto de sanidade
}

// ---------------------------------------------------------------------------
// BREAKDOWN DIÁRIO (heatmap "CITY LIGHTS · THIS WEEK"). O app manda `dailyTokens` =
// { AAAAMMDD(UTC): tokens da cidade } dos últimos 7 dias UTC. Sanitiza duro:
//  • só chaves que casam ^\d{8}$ E caem numa JANELA PLAUSÍVEL (até 7 dias atrás e 1 de
//    folga à frente, pra skew de relógio na virada da meia-noite) — descarta o resto;
//  • valores int>=0 com o mesmo teto de sanidade dos tokens;
//  • no máx. 7 chaves (mantém as mais recentes).
// Devolve null quando nada sobra (report sem dailyTokens PRESERVA os snapshots).
// ---------------------------------------------------------------------------
export const DAILY_MAX_KEYS = 7;
export function sanitizeDailyTokens(
  raw: unknown,
  now: number = Date.now()
): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const today0 = dayKeyRefMs(utcDayKey(now));
  const DAY_MS = 86400000;
  const minMs = today0 - 7 * DAY_MS; // até 7 dias atrás (cobre o floor today-7)
  const maxMs = today0 + DAY_MS; // 1 dia de folga à frente (skew de relógio)
  const kept: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{8}$/.test(k)) continue; // formato AAAAMMDD
    const refMs = dayKeyRefMs(k);
    if (!(refMs >= minMs && refMs <= maxMs)) continue; // fora da janela plausível
    const n = num(v, CAPS.tokens); // int>=0 com teto de sanidade
    if (n === null) continue;
    kept.push([k, Math.floor(n)]);
  }
  if (!kept.length) return null;
  kept.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)); // dia DESC (mais recente 1º)
  const out: Record<string, number> = {};
  for (const [k, val] of kept.slice(0, DAILY_MAX_KEYS)) out[k] = val;
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function parseCityField(raw: string | number | undefined): RealCity | null {
  if (raw == null || raw === "") return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return sanitizeCity(obj); // revalida na leitura (guarda contra dado velho/corrompido)
  } catch {
    return null;
  }
}

function parseProfileField(raw: string | number | undefined): Profile | null {
  if (raw == null || raw === "") return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    // revalida na leitura (guarda contra dado velho/corrompido). Dado guardado é
    // sempre limpo (sem ""), então mergeProfile(null, patch) só limpa o patch.
    return mergeProfile(null, sanitizeProfile(obj));
  } catch {
    return null;
  }
}

function parseSetupField(raw: string | number | undefined): Setup | null {
  if (raw == null || raw === "") return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    // revalida na leitura (guarda contra dado velho/corrompido). Dado guardado é
    // sempre limpo; sanitizeSetup devolve Setup | null | undefined -> null em qq
    // caso não-Setup.
    return sanitizeSetup(obj) ?? null;
  } catch {
    return null;
  }
}

function parseEntry(username: string, h: Record<string, string | number> | null): Entry | null {
  if (!h) return null;
  return {
    username,
    tokens: Number(h.tokens) || 0,
    cost: Number(h.cost) || 0,
    residents: Number(h.residents) || 0,
    buildings: Number(h.buildings) || 0,
    lastReport: Number(h.lastReport) || 0,
    city: parseCityField(h.city),
    profile: parseProfileField(h.profile),
    setup: parseSetupField(h.setup),
  };
}

// ---------------------------------------------------------------------------
// SITE VIEWS + SPONSOR FLIGHTS
// Only aggregate site counters are stored. Sponsor campaigns deliberately do
// not track per-ad impressions, clicks, visitors, IP addresses or user agents.
// ---------------------------------------------------------------------------
export type SiteMetrics = { visitors: number; pageviews: number };

export async function recordSiteView(newVisitor: boolean): Promise<SiteMetrics> {
  const db = kv();
  const pageviews = await db.hincrby(K_SITE_METRICS, "pageviews", 1);
  const visitors = newVisitor
    ? await db.hincrby(K_SITE_METRICS, "visitors", 1)
    : Number(await db.hget(K_SITE_METRICS, "visitors")) || 0;
  return { visitors, pageviews };
}

export async function getSiteMetrics(): Promise<SiteMetrics> {
  const h = await kv().hgetall(K_SITE_METRICS);
  return { visitors: Number(h?.visitors) || 0, pageviews: Number(h?.pageviews) || 0 };
}

export async function reserveSiteView(sessionId: string): Promise<boolean> {
  if (!/^[a-f0-9-]{20,64}$/i.test(sessionId)) return false;
  return kv().setNxEx(`tt:site:view-rate:${shortPrivateHash("view", sessionId)}`, "1", 5);
}

function parseSponsorCampaign(raw: string | number | undefined): SponsorCampaign | null {
  if (typeof raw !== "string") return null;
  try {
    const c = JSON.parse(raw) as SponsorCampaign;
    return c && typeof c.id === "string" && sanitizeSponsorDraft(c) ? c : null;
  } catch {
    return null;
  }
}

async function saveSponsorCampaign(c: SponsorCampaign): Promise<void> {
  await kv().hset(K_SPONSORS, { [c.id]: JSON.stringify(c) });
}

function sponsorCampaignExpired(c: SponsorCampaign, now: number): boolean {
  const status = effectiveSponsorStatus(c, now);
  if (status === "draft") return now - c.createdAt > SPONSOR_DRAFT_RETENTION_MS;
  if (status === "paid" || status === "scheduled" || status === "active") return false;
  const reference = c.endsAt || c.approvedAt || c.paidAt || c.createdAt;
  return now - reference > SPONSOR_HISTORY_RETENTION_MS;
}

export async function cleanupSponsorCampaigns(now = Date.now()): Promise<number> {
  const db = kv();
  const h = await db.hgetall(K_SPONSORS);
  let removed = 0;
  for (const [id, raw] of Object.entries(h ?? {})) {
    const campaign = parseSponsorCampaign(raw);
    if (campaign && sponsorCampaignExpired(campaign, now)) {
      await db.hdel(K_SPONSORS, id);
      removed++;
    }
  }
  return removed;
}

export async function listSponsorCampaigns(now = Date.now()): Promise<SponsorCampaign[]> {
  await cleanupSponsorCampaigns(now);
  const h = await kv().hgetall(K_SPONSORS);
  return Object.values(h ?? {})
    .map(parseSponsorCampaign)
    .filter((c): c is SponsorCampaign => !!c)
    .map((c) => ({ ...c, status: effectiveSponsorStatus(c, now) }))
    .sort((a, b) => {
      if (a.status === "paid" && b.status === "paid")
        return (a.paidAt || a.createdAt) - (b.paidAt || b.createdAt) || a.id.localeCompare(b.id);
      if (a.status === "paid") return -1;
      if (b.status === "paid") return 1;
      return b.createdAt - a.createdAt;
    });
}

export async function getSponsorCampaign(id: string): Promise<SponsorCampaign | null> {
  if (!/^[a-f0-9-]{20,40}$/i.test(id)) return null;
  return parseSponsorCampaign((await kv().hget(K_SPONSORS, id)) ?? undefined);
}

export async function createSponsorCampaign(raw: unknown): Promise<SponsorCampaign | null> {
  const draft = sanitizeSponsorDraft(raw);
  if (!draft) return null;
  const campaign: SponsorCampaign = {
    id: randomUUID(),
    ...draft,
    status: "draft",
    createdAt: Date.now(),
  };
  await saveSponsorCampaign(campaign);
  return campaign;
}

export async function reserveSponsorCheckout(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return false;
  return kv().setNxEx(kSponsorCheckoutRate(normalized), "1", 60);
}

export async function reserveSponsorAdminAttempt(fingerprint: string): Promise<boolean> {
  const value = fingerprint.trim().slice(0, 160) || "unknown";
  return kv().setNxEx(`tt:sponsors:admin-rate:${shortPrivateHash("admin", value)}`, "1", 3);
}

export async function deleteSponsorDraft(id: string): Promise<boolean> {
  const campaign = await getSponsorCampaign(id);
  if (!campaign || campaign.status !== "draft") return false;
  await kv().hdel(K_SPONSORS, id);
  return true;
}

export async function attachSponsorCheckout(id: string, checkoutSessionId: string): Promise<SponsorCampaign | null> {
  const c = await getSponsorCampaign(id);
  if (!c || c.status !== "draft") return c;
  const next = { ...c, checkoutSessionId };
  await saveSponsorCampaign(next);
  return next;
}

export async function markSponsorPaid(input: {
  id: string;
  checkoutSessionId: string;
  paymentIntentId?: string;
  email?: string;
}): Promise<SponsorCampaign | null> {
  const c = await getSponsorCampaign(input.id);
  if (!c) return null;
  // Stripe can retry webhooks: an already-paid/approved campaign is a no-op.
  if (c.status !== "draft") return c;
  if (c.checkoutSessionId && c.checkoutSessionId !== input.checkoutSessionId) return null;
  const next: SponsorCampaign = {
    ...c,
    status: "paid",
    paidAt: Date.now(),
    checkoutSessionId: input.checkoutSessionId,
    paymentIntentId: input.paymentIntentId,
    email: input.email || c.email,
  };
  await saveSponsorCampaign(next);
  return next;
}

async function withSponsorScheduleLock(
  task: () => Promise<SponsorCampaign | null>
): Promise<SponsorCampaign | null> {
  const db = kv();
  const locked = await db.setNxEx(K_SPONSOR_SCHEDULE_LOCK, randomUUID(), 15);
  if (!locked) return null;
  try {
    return await task();
  } finally {
    await db.del(K_SPONSOR_SCHEDULE_LOCK);
  }
}

export async function approveSponsorCampaign(id: string, now = Date.now()): Promise<SponsorCampaign | null> {
  return withSponsorScheduleLock(async () => {
    const c = await getSponsorCampaign(id);
    if (!c || c.status !== "paid") return null;
    const all = await listSponsorCampaigns(now);
    const queue = all
      .filter((item) => item.status === "paid")
      .sort((a, b) =>
        (a.paidAt || a.createdAt) - (b.paidAt || b.createdAt) || a.id.localeCompare(b.id)
      );
    if (queue[0]?.id !== id) return null;
    const window = nextSponsorWindow(all.filter((x) => x.id !== id), now);
    const next: SponsorCampaign = {
      ...c,
      status: "scheduled",
      approvedAt: now,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    };
    await saveSponsorCampaign(next);
    return { ...next, status: effectiveSponsorStatus(next, now) };
  });
}

export async function getSponsorAvailability(now = Date.now()): Promise<{ startsAt: number; waiting: number }> {
  const campaigns = await listSponsorCampaigns(now);
  const base = nextSponsorWindow(campaigns, now);
  const waiting = campaigns.filter((campaign) => campaign.status === "paid").length;
  return {
    startsAt: base.startsAt + waiting * (SPONSOR_DURATION_MS + SPONSOR_GAP_MS),
    waiting,
  };
}

export async function pauseSponsorCampaign(id: string, now = Date.now()): Promise<SponsorCampaign | null> {
  const campaign = await getSponsorCampaign(id);
  if (!campaign) return null;
  const status = effectiveSponsorStatus(campaign, now);
  if (status !== "paid" && status !== "scheduled" && status !== "active") return null;
  const remainingMs = status === "active" && campaign.endsAt
    ? Math.max(60_000, campaign.endsAt - now)
    : SPONSOR_DURATION_MS;
  const next: SponsorCampaign = { ...campaign, status: "paused", pausedAt: now, remainingMs };
  await saveSponsorCampaign(next);
  return next;
}

export async function resumeSponsorCampaign(id: string, now = Date.now()): Promise<SponsorCampaign | null> {
  return withSponsorScheduleLock(async () => {
    const campaign = await getSponsorCampaign(id);
    if (!campaign || campaign.status !== "paused") return null;
    const all = await listSponsorCampaigns(now);
    if (all.some((item) => item.status === "paid")) return null;
    const window = nextSponsorWindow(all.filter((item) => item.id !== id), now);
    const duration = Math.max(60_000, Math.min(campaign.remainingMs || SPONSOR_DURATION_MS, SPONSOR_DURATION_MS));
    const next: SponsorCampaign = {
      ...campaign,
      status: "scheduled",
      approvedAt: now,
      startsAt: window.startsAt,
      endsAt: window.startsAt + duration,
      pausedAt: undefined,
      remainingMs: undefined,
    };
    await saveSponsorCampaign(next);
    return { ...next, status: effectiveSponsorStatus(next, now) };
  });
}

export async function setSponsorStatus(
  id: string,
  status: "rejected" | "refunded",
  refundId?: string
): Promise<SponsorCampaign | null> {
  const c = await getSponsorCampaign(id);
  if (!c) return null;
  const next: SponsorCampaign = { ...c, status, ...(refundId ? { refundId } : {}) };
  await saveSponsorCampaign(next);
  return next;
}

export async function getActiveSponsor(now = Date.now()): Promise<PublicSponsor | null> {
  const campaigns = await listSponsorCampaigns(now);
  const active = campaigns.find((c) => effectiveSponsorStatus(c, now) === "active") ?? null;
  return toPublicSponsor(active, now);
}

export async function getPublicSponsorLineup(now = Date.now(), limit = 4): Promise<PublicSponsorSlot[]> {
  const campaigns = await listSponsorCampaigns(now);
  return campaigns
    .map((c) => ({ campaign: c, status: effectiveSponsorStatus(c, now) }))
    .filter((x): x is { campaign: SponsorCampaign; status: "active" | "scheduled" } =>
      x.status === "active" || x.status === "scheduled")
    .sort((a, b) => (a.campaign.startsAt || 0) - (b.campaign.startsAt || 0))
    .slice(0, Math.max(1, Math.min(limit, 8)))
    .map(({ campaign, status }) => {
      const { id, name, tagline, url, startsAt, endsAt } = campaign;
      return { id, name, tagline, url, startsAt, endsAt, status };
    });
}

// ---------------------------------------------------------------------------
// HISTÓRICO DIÁRIO (pra ranking por janela). Cada usuário tem um HASH cujos
// campos são dias UTC (AAAAMMDD) e o valor é a ALTA-MARCA daquele dia
// ("tokens|cost"), monotônica. Guardamos no máx MAX_SNAP_DAYS dias e podamos os
// mais antigos. As funções PURAS (parseSnaps/windowDelta/rankWindow/...) vivem
// em ./window pra serem testáveis sem I/O.
// ---------------------------------------------------------------------------
// Grava a alta-marca do dia atual (monotônica por dia) e poda dias antigos.
async function recordDailySnapshot(
  db: KV,
  season: number,
  username: string,
  tokens: number,
  cost: number,
  now: number
): Promise<void> {
  const key = kSnap(season, username);
  const dayKey = utcDayKey(now);
  const hash = await db.hgetall(key);
  const existing = hash?.[dayKey];
  let write = true;
  if (existing != null) {
    const prevTokens = Number(String(existing).split("|")[0]) || 0;
    if (prevTokens >= tokens) write = false; // já temos alta-marca >= hoje
  }
  const value = `${tokens}|${cost}`;
  if (write) await db.hset(key, { [dayKey]: value });

  // poda: mantém no máx MAX_SNAP_DAYS dias (remove os mais antigos).
  const after: Record<string, unknown> = { ...(hash ?? {}) };
  after[dayKey] = value;
  const days = Object.keys(after)
    .filter((k) => /^\d{8}$/.test(k))
    .sort(); // AAAAMMDD ordena cronologicamente
  if (days.length > MAX_SNAP_DAYS) {
    for (const d of days.slice(0, days.length - MAX_SNAP_DAYS)) await db.hdel(key, d);
  }
}

// ---------------------------------------------------------------------------
// BACK-DATING dos snapshots diários a partir do breakdown `dailyTokens` (per-dia).
// O HASH kSnap guarda a ALTA-MARCA CUMULATIVA (tokens da temporada ATÉ o fim daquele dia)
// — é o que weekHeatmap/windowDelta DIFERENCIAM. Mas o app manda GANHOS por dia. Aqui
// reconstruímos o cumulativo de cada dia ancorando no total da temporada (`seasonTokens`):
//   cumAsOf(hoje)    = seasonTokens
//   cumAsOf(dia-1)   = cumAsOf(dia) - ganho(dia)   (subtrai o ganho do próprio dia)
// Escrevemos HOJE..HOJE-7 (8 dias): os 7 dias VISÍVEIS + o "chão" em HOJE-7, cujo
// cumulativo (= total menos os 7 ganhos da janela) faz o dia mais antigo VISÍVEL (HOJE-6)
// diferenciar certo — sem ele, atividade PRÉ-JANELA (ex.: início da temporada) vazaria pro
// HOJE-6 acendendo-o falso. Alta-marca por dia (só grava se cresceu). Custo é rateado por
// token (o par tokens|custo fica coerente; o heatmap ignora custo, o 7d usa só o chão).
// ---------------------------------------------------------------------------
async function recordBackdatedDailySnapshots(
  db: KV,
  season: number,
  username: string,
  seasonTokens: number,
  seasonCost: number,
  daily: Record<string, number>,
  now: number
): Promise<void> {
  const key = kSnap(season, username);
  const hash = await db.hgetall(key);
  const DAY_MS = 86400000;
  const today0 = dayKeyRefMs(utcDayKey(now));
  const writes: Record<string, string | number> = {};
  const after: Record<string, unknown> = { ...(hash ?? {}) };
  let cum = Math.max(0, seasonTokens);
  for (let i = 0; i <= 7; i++) {
    const refMs = today0 - i * DAY_MS;
    const dayKey = utcDayKey(refMs);
    const existing = hash?.[dayKey];
    const prevTokens = existing != null ? Number(String(existing).split("|")[0]) || 0 : -1;
    if (cum > prevTokens) {
      const cumCost = seasonTokens > 0 ? (seasonCost * cum) / seasonTokens : 0;
      const value = `${cum}|${cumCost}`;
      writes[dayKey] = value;
      after[dayKey] = value;
    }
    cum -= daily[dayKey] || 0; // ganho do dia -> cumulativo do dia anterior
    if (cum < 0) cum = 0; // guarda contra dailyTokens inconsistente (> total)
  }
  if (Object.keys(writes).length) await db.hset(key, writes);
  // poda: mantém no máx MAX_SNAP_DAYS dias (remove os mais antigos).
  const daysK = Object.keys(after)
    .filter((k) => /^\d{8}$/.test(k))
    .sort();
  if (daysK.length > MAX_SNAP_DAYS) {
    for (const d of daysK.slice(0, daysK.length - MAX_SNAP_DAYS)) await db.hdel(key, d);
  }
}

// ---------------------------------------------------------------------------
// REPORT — honor system. Primeiro report registra o hash do key; depois key
// errado -> 403. Valores são SNAPSHOTS absolutos e monotônicos por métrica:
// tokens, custo, residentes e prédios podem avançar de forma independente.
// ---------------------------------------------------------------------------
export async function submitReport(input: ReportInput): Promise<ReportResult> {
  const db = kv();

  const username = sanitizeUsername(input.username);
  if (!username) return { ok: false, status: 400, error: "username inválido (use [a-z0-9-]{2,24})" };
  if (typeof input.key !== "string" || input.key.length < 8)
    return { ok: false, status: 400, error: "key ausente ou curta demais" };

  const tokens = num(input.tokens, CAPS.tokens);
  const cost = num(input.cost, CAPS.cost);
  const residents = num(input.residents, CAPS.residents);
  const buildings = num(input.buildings, CAPS.buildings);
  if (tokens === null || cost === null || residents === null || buildings === null)
    return { ok: false, status: 400, error: "números inválidos (não-negativos, finitos)" };

  const counterId = sanitizeCounterId(input.counterId);
  if (input.counterId != null && input.counterId !== "" && !counterId)
    return { ok: false, status: 400, error: "counterId inválido" };

  // valida temporada — PÓDIO CONGELA. A atual sempre entra; a anterior só nos
  // primeiros 60 min da virada (grace de relógio), depois o pódio velho está
  // trancado -> 400 "temporada encerrada". A seguinte só com relógio adiantado.
  const now = Date.now();
  const cur = currentSeasonId(now);
  const season = Number(input.seasonId);
  if (!isReportSeasonValid(season, now)) {
    const msg =
      season === cur - 1 ? "temporada encerrada" : `seasonId fora da janela (atual=${cur})`;
    return { ok: false, status: 400, error: msg };
  }

  // AUTENTICAÇÃO (honor system): registra na primeira vez, depois compara hash.
  const keyHash = sha256(input.key);
  const known = await db.hget(K_USERS, username);
  if (known && known !== keyHash) return { ok: false, status: 403, error: "key incorreta pra este username" };
  if (!known) await db.hset(K_USERS, { [username]: keyHash });

  // RATE LIMIT (1/min por username). Só chega aqui quem passou na auth.
  const allowed = await db.setNxEx(kRate(username), "1", RATE_LIMIT_SEC);
  if (!allowed) return { ok: false, status: 429, error: "devagar — 1 report por minuto" };

  // CIDADE REAL: sanitiza rigorosamente (null se ausente/inválida/maliciosa/>2KB).
  const city = sanitizeCity(input.city);
  // PERSONALIZAÇÃO: sanitiza -> PATCH (SET/CLEAR/PRESERVE por campo). null = nada
  // veio -> preserva tudo. "" explícito num campo APAGA o guardado.
  const patch = sanitizeProfile(input.profile);

  // SNAPSHOT monotônico por campo. Isso é importante quando um leitor novo
  // aprende a calcular custo/modelos históricos: o custo pode sair de zero
  // mesmo sem que o total de tokens tenha mudado desde o último report.
  const prevHash = await db.hgetall(kUser(season, username));
  const prev = parseEntry(username, prevHash);
  const checkpoint = parseCounterCheckpoint(prevHash);
  // merge do patch sobre o profile guardado (aplica-se mesmo em report sem
  // crescimento — trocar/limpar o lema não exige queimar mais tokens).
  const mergedProfile = mergeProfile(prev?.profile ?? null, patch);
  // campo `profile` do hash: só toca quando veio um patch. JSON quando sobra
  // algo; "" quando esvaziou (parseProfileField lê "" como null).
  const profileWrite = patch ? (mergedProfile ? JSON.stringify(mergedProfile) : "") : null;

  // SETUP: sanitiza -> tri-estado. undefined = ausente/inválido/>3KB -> PRESERVA;
  // null = `setup:null` explícito -> LIMPA; Setup = SET. Aplica-se mesmo em report
  // sem crescimento de tokens (mudar o setup não exige queimar token).
  const setup = sanitizeSetup(input.setup);
  const effectiveSetup: Setup | null = setup === undefined ? (prev?.setup ?? null) : setup;
  // campo `setup` do hash: undefined = não toca (preserva); "" quando limpa;
  // JSON quando SET (parseSetupField lê "" como null).
  const setupWrite: string | undefined =
    setup === undefined ? undefined : setup === null ? "" : JSON.stringify(setup);

  // BREAKDOWN DIÁRIO (heatmap "CITY LIGHTS"): sanitiza -> { AAAAMMDD: tokens } ou null.
  // null (ausente/inválido) PRESERVA os snapshots diários que já existem. Quando presente,
  // back-data o cumulativo dos 7 dias (+ chão em today-7) como alta-marca. Aplica-se
  // mesmo sem crescimento de tokens (a semana muda de dia sem novo total).
  const daily = sanitizeDailyTokens(input.dailyTokens, now);

  // Um snapshot sem counterId mantém o contrato legado (máximo absoluto). Com
  // counterId, o primeiro snapshot ancora a base. Os seguintes aplicam somente
  // o crescimento desde o checkpoint — assim uma versão nova do leitor pode
  // começar abaixo do total histórico sem deixar o perfil congelado até
  // alcançá-lo. Se os arquivos locais forem podados e o contador cair, apenas
  // reancoramos; nunca subtraímos do placar.
  const continuingCounter = !!(
    prev &&
    counterId &&
    checkpoint &&
    checkpoint.id === counterId
  );
  const counterReset = !!(
    continuingCounter &&
    checkpoint &&
    (tokens < checkpoint.tokens ||
      cost < checkpoint.cost ||
      residents < checkpoint.residents ||
      buildings < checkpoint.buildings)
  );
  const rebased = !!(prev && counterId && (!continuingCounter || counterReset));
  const nextTokens = !prev
    ? tokens
    : continuingCounter && checkpoint
      ? prev.tokens + Math.max(0, tokens - checkpoint.tokens)
      : Math.max(prev.tokens, tokens);
  const nextCost = !prev
    ? cost
    : continuingCounter && checkpoint
      ? prev.cost + Math.max(0, cost - checkpoint.cost)
      : Math.max(prev.cost, cost);
  const nextResidents = !prev
    ? residents
    : continuingCounter && checkpoint
      ? prev.residents + Math.max(0, residents - checkpoint.residents)
      : Math.max(prev.residents, residents);
  const nextBuildings = !prev
    ? buildings
    : continuingCounter && checkpoint
      ? prev.buildings + Math.max(0, buildings - checkpoint.buildings)
      : Math.max(prev.buildings, buildings);
  const numbersChanged =
    !prev ||
    nextTokens > prev.tokens ||
    nextCost > prev.cost ||
    nextResidents > prev.residents ||
    nextBuildings > prev.buildings;
  const cityChanged = !!city && JSON.stringify(city) !== JSON.stringify(prev?.city ?? null);

  if (!prev || numbersChanged || cityChanged) {
    const fields: Record<string, string | number> = {
      tokens: nextTokens,
      cost: nextCost,
      residents: nextResidents,
      buildings: nextBuildings,
      lastReport: now,
    };
    // só sobrescreve a city se veio uma válida; report sem city não apaga a que já existe.
    if (city) fields.city = JSON.stringify(city);
    if (profileWrite !== null) fields.profile = profileWrite;
    if (setupWrite !== undefined) fields.setup = setupWrite;
    if (counterId) {
      fields.counterId = counterId;
      fields.counterTokens = tokens;
      fields.counterCost = cost;
      fields.counterResidents = residents;
      fields.counterBuildings = buildings;
    }
    await db.hset(kUser(season, username), fields);
    if (!prev || nextTokens > prev.tokens) await db.zadd(kRank(season), nextTokens, username);
    // alta-marca do dia (pra ranking por janela).
    await recordDailySnapshot(db, season, username, nextTokens, nextCost, now);
    // BREAKDOWN DIÁRIO: back-data os 7 dias reais (+ chão) -> heatmap da semana.
    if (daily) await recordBackdatedDailySnapshots(db, season, username, nextTokens, nextCost, daily, now);
    const entry: Entry = {
      username,
      tokens: nextTokens,
      cost: nextCost,
      residents: nextResidents,
      buildings: nextBuildings,
      lastReport: now,
      city: city ?? prev?.city ?? null,
      profile: mergedProfile,
      setup: effectiveSetup,
    };
    return { ok: true, status: 200, updated: true, rebased, entry };
  }

  // report atrasado / sem crescimento -> mantém os números, mas ainda aplica o
  // patch do profile (SET/CLEAR) e o setup (SET/CLEAR) e confirma a alta-marca.
  const tailFields: Record<string, string | number> = {};
  if (profileWrite !== null) tailFields.profile = profileWrite;
  if (setupWrite !== undefined) tailFields.setup = setupWrite;
  if (counterId) {
    tailFields.counterId = counterId;
    tailFields.counterTokens = tokens;
    tailFields.counterCost = cost;
    tailFields.counterResidents = residents;
    tailFields.counterBuildings = buildings;
  }
  if (Object.keys(tailFields).length) await db.hset(kUser(season, username), tailFields);
  await recordDailySnapshot(db, season, username, prev.tokens, prev.cost, now);
  // BREAKDOWN DIÁRIO: back-data mesmo sem crescimento (a semana avança de dia).
  if (daily) await recordBackdatedDailySnapshots(db, season, username, prev.tokens, prev.cost, daily, now);
  return {
    ok: true,
    status: 200,
    updated: false,
    rebased,
    entry: { ...prev, profile: mergedProfile, setup: effectiveSetup },
  };
}

// ---------------------------------------------------------------------------
// DELETE PROFILE — remove username from the board (honor system: same key that
// was registered on first report). Wipes rank + user hash + daily snaps for the
// current season (and previous, if still present) and frees the username so a
// fresh key can re-claim it later.
// ---------------------------------------------------------------------------
export type DeleteResult =
  | { ok: true; status: 200; deleted: true; username: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function deleteUser(input: { username: string; key: string }): Promise<DeleteResult> {
  const db = kv();

  const username = sanitizeUsername(input.username);
  if (!username) return { ok: false, status: 400, error: "username inválido (use [a-z0-9-]{2,24})" };
  if (typeof input.key !== "string" || input.key.length < 8)
    return { ok: false, status: 400, error: "key ausente ou curta demais" };

  const keyHash = sha256(input.key);
  const known = await db.hget(K_USERS, username);
  if (!known) return { ok: false, status: 404, error: "username não encontrado" };
  if (known !== keyHash) return { ok: false, status: 403, error: "key incorreta pra este username" };

  const now = Date.now();
  const cur = currentSeasonId(now);
  // Wipe current + previous season (grace window / leftover data).
  for (const s of [cur, cur - 1]) {
    if (s < 0) continue;
    await db.zrem(kRank(s), username);
    await db.del(kUser(s, username));
    await db.del(kSnap(s, username));
  }
  await db.hdel(K_USERS, username);
  // Drop rate-limit key so a re-register isn't blocked for 60s.
  await db.del(kRate(username));

  return { ok: true, status: 200, deleted: true, username };
}

// ---------------------------------------------------------------------------
// LEADERBOARD — top 100. window "season" (padrão) = tokens/custo absolutos da
// temporada; window "7d" = ganho dos últimos 7 dias (re-ordenado por esse ganho).
// ---------------------------------------------------------------------------
export async function getLeaderboard(
  season: number,
  opts: { window?: WindowKind; limit?: number } = {}
): Promise<RankedEntry[]> {
  const window = opts.window ?? "season";
  const limit = opts.limit ?? 100;
  const db = kv();
  // enumera pelo ZSET (top por tokens absolutos); no 7d o delta <= total, então
  // o topo por janela está contido no topo por total. Escaneia ao menos 100.
  const top = await db.ztop(kRank(season), Math.max(limit, 100));
  const users: UserWindowInput[] = [];
  for (const { member } of top) {
    const entry = parseEntry(member, await db.hgetall(kUser(season, member)));
    if (!entry) continue;
    const snaps = window === "7d" ? parseSnaps(await db.hgetall(kSnap(season, member))) : [];
    users.push({ entry, snaps });
  }
  return rankWindow(users, window, Date.now(), limit);
}

// Entrada de UM dev com a posição no ranking da temporada — pra página /u/[username].
// A posição é 1 + (quantos membros têm mais tokens). Escaneia o topo do ZSET.
export async function getUserWithRank(
  season: number,
  usernameRaw: string
): Promise<RankedEntry | null> {
  const db = kv();
  const username = sanitizeUsername(usernameRaw);
  if (!username) return null;
  const entry = parseEntry(username, await db.hgetall(kUser(season, username)));
  if (!entry) return null;
  const top = await db.ztop(kRank(season), 10000);
  // posição coerente com o quadro: desempate por username ASC (não pela ordem
  // do ZSET/inserção, que discordava da tabela pra tokens iguais).
  const position = seasonPosition(
    top.map((t) => ({ member: t.member, tokens: t.score })),
    username,
    entry.tokens
  );
  // /u é sempre por temporada: seasonTokens/seasonCost == tokens/cost.
  return { ...entry, position, seasonTokens: entry.tokens, seasonCost: entry.cost };
}

// ---------------------------------------------------------------------------
// LEITURA dos snapshots diários de UM usuário — pro heatmap "CITY LIGHTS" da /u.
// CRÍTICO: lê pelo MESMO kv() que o store ESCREVE (node-redis em prod, memória em
// dev). Antes esta leitura vivia num módulo à parte (lib/snaps.ts) que só sabia
// falar Upstash REST (UPSTASH_REDIS_REST_URL/_TOKEN) — variáveis que NÃO existem
// em produção (lá a integração injeta só a URL nativa `tokentown_REDIS_URL`). Sem
// achar credencial REST, ele caía pro mapa em memória (vazio no processo do
// render) e devolvia [] -> o heatmap ficava todo apagado menos "hoje". Rotear
// pelo kv() garante leitor == escritor, então os snapshots retro-datados aparecem.
// Defensivo: qualquer erro -> [] (o heatmap degrada pra "quiet week"), e o kv()
// node-redis tem timeouts/fallback próprios, então NUNCA pendura a página.
export async function getUserSnaps(season: number, usernameRaw: string): Promise<SnapPoint[]> {
  const username = sanitizeUsername(usernameRaw);
  if (!username) return [];
  const db = kv();
  try {
    return parseSnaps(await db.hgetall(kSnap(season, username)));
  } catch {
    return [];
  }
}

export function backendName(): string {
  return kv().backend;
}
