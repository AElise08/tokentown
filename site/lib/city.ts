// ---------------------------------------------------------------------------
// GERADOR DE CIDADE — pixel-art SVG server-side, DETERMINÍSTICO e PURO.
//
// A alma do placar: cada dev tem uma cidade noturna própria, desenhada só a
// partir dos dados PÚBLICOS dele (username + números da temporada). Mesma
// entrada -> exatamente o mesmo SVG (nada de Math.random / Date.now aqui).
//
// Regras (inspiradas na arte do app TOKENTOWN — game.js, só leitura):
//   - username        -> semente (hash simples -> mulberry32) do layout.
//   - buildings (nº)   -> densidade/largura dos prédios (mais prédios = skyline
//                         mais cheia, prédios mais estreitos).
//   - residents        -> fração de janelas ACESAS (cidade mais habitada brilha).
//   - tokens           -> MARCOS que enfeitam a cena, nos mesmos limiares do jogo:
//        >= 100k  jardim na orla
//        >= 300k  balsa cruzando a água
//        >= 1M    FAROL (com feixe de luz)
//        >= 3M    bairro das torres (prédios mais altos)
//
// Zero dependências, zero JS no cliente: devolve uma string <svg> que a página
// injeta. Paleta noturna calma, coerente com o resto do site (#141019).
// ---------------------------------------------------------------------------

export interface CityInput {
  username: string;
  tokens: number;
  residents: number;
  buildings: number;
  // CIDADE REAL (opcional). Quando presente, a skyline é desenhada DELA (não do
  // hash do username). Usuário antigo sem city -> fallback pela seed do username.
  city?: RealCity | null;
  // COR DE DESTAQUE (opcional) — HEX já resolvido do accent do perfil. Quando
  // presente, tinge de leve o dourado das janelas (sutil, não neon). Ausente ->
  // janelas no dourado padrão. Puro/determinístico: mesmo hex -> mesmo SVG.
  accent?: string | null;
}

// ---------------------------------------------------------------------------
// CIDADE REAL — payload que o app TOKENTOWN manda descrevendo a cidade DE VERDADE
// da pessoa (contrato fechado com o agente do app). `seed` alimenta o mulberry32
// (mesma cidade toda vez); `buildings` densidade; `pop` janelas acesas; `types`
// as construções especiais reconhecíveis; `marcos` os enfeites ambientais;
// `era` muda o tom e a altura média.
// ---------------------------------------------------------------------------
export interface RealCity {
  v: 1;
  seed: number; // uint32
  buildings: number;
  pop: number;
  types: Record<string, number>; // ex.: { torre: 12, parque: 3, cais: 2 }
  marcos: string[]; // ex.: ["garden","lighthouse","festival"]
  era: number;
}

// Tetos de sanidade da cidade real (sanitização).
export const CITY_CAPS = {
  buildings: 5_000_000,
  pop: 10_000_000,
  era: 12,
  typeValue: 1_000_000, // contagem máx por tipo
  typeKeys: 24, // máx de chaves em `types`
  marcos: 16, // máx de marcos
  jsonBytes: 2048, // payload bruto acima disso -> descarta a city
};

// en-US labels for the special buildings (for the /u composition chips). The
// city-generator slugs stay in Portuguese (they're data keys); these are the
// human-facing names. Unknown slugs fall back to the raw slug.
export const TYPE_LABELS: Record<string, string> = {
  parque: "park",
  torre: "tower",
  cais: "dock",
  biblioteca: "library",
  mirante: "lookout",
  praca: "plaza",
  museu: "museum",
  mercado: "market",
  coreto: "bandstand",
  jardim: "garden",
  chamine: "smokestack",
  estacao: "station",
  ponte: "bridge",
  catedral: "cathedral",
};

// en-US labels for the ambient landmarks.
export const MARCO_LABELS: Record<string, string> = {
  garden: "waterfront garden",
  ferry: "ferry across the water",
  lighthouse: "lighthouse with a beam",
  towers: "tower district",
  festival: "lantern festival",
  fireworks: "fireworks",
};

// ---------------------------------------------------------------------------
// SANITIZAÇÃO da cidade real — RIGOROSA. Pura (sem I/O), usada pela API/store e
// coberta pelos testes de lib/city. Regras:
//   - objeto não-nulo, não-array; payload BRUTO serializado <= 2KB (senão null);
//   - v === 1 obrigatório; seed uint32 obrigatório (senão descarta a city toda);
//   - buildings/pop/era = inteiros não-negativos clampados nos tetos;
//   - types: máx 24 chaves; chave normalizada p/ slug [a-z0-9-]{1,24} (tira
//            acentos: "praça"->"praca"); valor int não-neg clampado; contagem 0
//            descartada; colisão de slug soma;
//   - marcos: máx 16; cada um string [a-z-]{1,24}, minúsculo, sem duplicata.
// ---------------------------------------------------------------------------
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function uint32OrNull(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return null;
  return v >>> 0;
}

function nnInt(n: unknown, cap: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), cap);
}

const TYPE_SLUG_STRIP = /[^a-z0-9-]+/g;
const MARCO_RE = /^[a-z-]{1,24}$/;

function slugType(raw: string): string | null {
  const s = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira diacríticos (praça -> praca)
    .toLowerCase()
    .replace(TYPE_SLUG_STRIP, "")
    .slice(0, 24);
  return s.length >= 1 ? s : null;
}

export function sanitizeCity(raw: unknown): RealCity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  // 0) guarda de tamanho no payload BRUTO — nada acima de 2KB é processado.
  let rawJson: string;
  try {
    rawJson = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (!rawJson || byteLen(rawJson) > CITY_CAPS.jsonBytes) return null;

  const c = raw as Record<string, unknown>;
  if (c.v !== 1) return null; // versão obrigatória
  const seed = uint32OrNull(c.seed);
  if (seed === null) return null; // seed é essencial pro render determinístico

  const buildings = nnInt(c.buildings, CITY_CAPS.buildings);
  const pop = nnInt(c.pop, CITY_CAPS.pop);
  const era = nnInt(c.era, CITY_CAPS.era);

  // types: máx 24 chaves; slug seguro; valor clampado; 0 descartado.
  const types: Record<string, number> = {};
  let keyCount = 0;
  if (c.types && typeof c.types === "object" && !Array.isArray(c.types)) {
    for (const [k, val] of Object.entries(c.types as Record<string, unknown>)) {
      if (keyCount >= CITY_CAPS.typeKeys) break;
      const slug = slugType(k);
      if (!slug) continue;
      const v = nnInt(val, CITY_CAPS.typeValue);
      if (v <= 0) continue;
      if (types[slug] != null) {
        types[slug] = Math.min(types[slug] + v, CITY_CAPS.typeValue); // colisão -> soma
      } else {
        types[slug] = v;
        keyCount++;
      }
    }
  }

  // marcos: máx 16; [a-z-]{1,24}; sem duplicata.
  const marcos: string[] = [];
  if (Array.isArray(c.marcos)) {
    const seen = new Set<string>();
    for (const m of c.marcos) {
      if (marcos.length >= CITY_CAPS.marcos) break;
      if (typeof m !== "string") continue;
      const s = m.trim().toLowerCase();
      if (!MARCO_RE.test(s) || seen.has(s)) continue;
      seen.add(s);
      marcos.push(s);
    }
  }

  return { v: 1, seed, buildings, pop, types, marcos, era };
}

export interface CompItem {
  slug: string;
  label: string;
  count: number;
}

// Composição da cidade p/ os chips do /u: [{ slug, label, count }] desc por count.
export function cityComposition(city: RealCity): CompItem[] {
  return Object.entries(city.types)
    .map(([slug, count]) => ({ slug, label: TYPE_LABELS[slug] ?? slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

// Marcos legíveis (pt-BR) da cidade real.
export function cityMarcoLabels(city: RealCity): string[] {
  return city.marcos.map((m) => MARCO_LABELS[m] ?? m);
}

export interface CityFeatures {
  garden: boolean; // >= 100k tokens
  ferry: boolean; // >= 300k tokens
  lighthouse: boolean; // >= 1M tokens (com feixe)
  towers: boolean; // >= 3M tokens (prédios mais altos)
  density: number; // 0..1 (a partir de buildings)
  litRatio: number; // 0..1 (a partir de residents)
}

export type CityVariant = "mini" | "full";

// Limiares dos marcos (mesmos números do jogo).
export const TOKEN_GARDEN = 100_000;
export const TOKEN_FERRY = 300_000;
export const TOKEN_LIGHTHOUSE = 1_000_000;
export const TOKEN_TOWERS = 3_000_000;

// ---------------------------------------------------------------------------
// PALETA (extraída de game.js — cena noturna, sem ciclo dia/noite).
// ---------------------------------------------------------------------------
const SKY = ["#12112e", "#181637", "#221c42", "#31244d", "#43305a", "#59395f", "#794b62"];
const BODY = ["#3b3450", "#463a5c", "#524565", "#5c4a62", "#6a4e64", "#413a58"];
const ROOF = ["#7a4a63", "#864f5e", "#6b4a70", "#8a5a5a", "#734867"];
const WIN_WARM = "#ffcf7a";
const WIN_BRIGHT = "#fff0c0";
const WATER_DEEP = "#141230";
const WATER_TOP = "#1c1838";
const WATERLINE = "#4a3a55";
const GRASS = "#2f4740";
const FLOWERS = ["#e08aa0", "#f2d07a", "#c98ac4", "#e0a06a"];
const LAMP_ON = "#ffdf9a";
const MOON_CORE = "#e7ecff";
const MOON_HALO = "#5a5f8a";
const STAR = "#e8e4ff";

// FAROL (lighthouse) — listrado VERMELHO/BRANCO como o marco do app. O fuste é
// claro (lê "branco" mesmo na cena noturna) e ganha faixas vermelhas; exportado
// pros testes conferirem que o farol está listrado. LH_ROCK = quebra-mar.
export const LH_TOWER = "#cfc8d0"; // fuste branco-acinzentado
export const LH_STRIPE = "#c05a5a"; // faixa vermelha
const LH_LANTERN = "#fff2c0"; // lanterna acesa
const LH_TRIM = "#7a4a5a"; // teto/arremate
const LH_ROCK = "#4a4050"; // molhe de pedras
const ANTENNA_LIGHT = "#ff8a6a"; // luz na ponta da antena/mastro

// Estilos de telhado sorteados por prédio (variedade tipo o app): laje simples,
// mureta (parapet), mastro com luz (antenna) e caixa d'água (watertank).
const ROOF_STYLES = ["flat", "parapet", "antenna", "watertank", "flat", "flat"] as const;

// ---------------------------------------------------------------------------
// UTILIDADES puras
// ---------------------------------------------------------------------------
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// hash de string estável -> uint32 (FNV-1a). Simples e determinístico.
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// PRNG semeado (mulberry32) — mesmo do jogo, layout reprodutível.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- cor ---
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function toHex2(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
}
function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return "#" + toHex2(lerp(A[0], B[0], t)) + toHex2(lerp(A[1], B[1], t)) + toHex2(lerp(A[2], B[2], t));
}

// TINT das janelas rumo à cor de destaque do perfil — SUTIL (não-neon). Sem
// accentHex, devolve o dourado padrão inalterado (SVG byte-idêntico ao de antes).
// Exportado pra os testes conferirem que o tom tingido de fato aparece no SVG.
export function accentedWindow(accentHex?: string | null): { warm: string; bright: string } {
  if (!accentHex) return { warm: WIN_WARM, bright: WIN_BRIGHT };
  return { warm: mixHex(WIN_WARM, accentHex, 0.22), bright: mixHex(WIN_BRIGHT, accentHex, 0.16) };
}

// ---------------------------------------------------------------------------
// FEATURES — derivam dos números. Exportado pra testes (limiares) sem parsear SVG.
// ---------------------------------------------------------------------------
export function cityFeatures(input: CityInput): CityFeatures {
  const tokens = Math.max(0, input.tokens || 0);
  const residents = Math.max(0, input.residents || 0);
  const buildings = Math.max(0, input.buildings || 0);
  return {
    garden: tokens >= TOKEN_GARDEN,
    ferry: tokens >= TOKEN_FERRY,
    lighthouse: tokens >= TOKEN_LIGHTHOUSE,
    towers: tokens >= TOKEN_TOWERS,
    // densidade: 0 (poucos prédios) .. 1 (~3000+). log pra crescer suave.
    density: clamp01(Math.log10(buildings + 1) / Math.log10(3000)),
    // janelas acesas: piso de 16% (nunca cidade morta), teto de 94%.
    litRatio: clamp(0.16 + (Math.log10(residents + 1) / Math.log10(400)) * 0.78, 0.16, 0.94),
  };
}

// ---------------------------------------------------------------------------
// pequeno "canvas" de retângulos -> vira <rect> na saída
// ---------------------------------------------------------------------------
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  op?: number;
  cls?: string; // classe opcional (ex.: tt-w1/tt-w2/tt-w3 pras janelas que piscam)
}
// Stream ORDENADO de operações: retângulos e formas cruas (lua, feixe, grupos
// <g class="tt-*">) saem exatamente na ordem em que foram desenhadas — z-order
// correto e grupos que de fato embrulham seus <rect> (contáveis por classe).
type Op = Rect | { raw: string };
class Painter {
  ops: Op[] = [];
  r(x: number, y: number, w: number, h: number, fill: string, op?: number, cls?: string) {
    if (w <= 0 || h <= 0) return;
    this.ops.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fill, op, cls });
  }
  raw(svg: string) {
    this.ops.push({ raw: svg });
  }
}

interface Placed {
  x: number;
  w: number;
  h: number;
  body: string;
}

// ---------------------------------------------------------------------------
// GERAÇÃO DA CENA — uma função, parametrizada por tamanho/detalhe.
// ---------------------------------------------------------------------------
interface SceneOpts {
  W: number;
  H: number;
  base: number; // linha d'água (y): céu 0..base, água base..H
  stars: number; // quantidade de estrelas
  reflection: boolean; // reflexo dos prédios na água
  lamps: number; // postes na orla da frente
  dither: number; // pixels de dithering no céu/água (0 = nenhum; mini fica leve)
}

// ---------------------------------------------------------------------------
// DETALHE DOS PRÉDIOS (aproxima o LOOK do app — reimplementação em SVG, não
// cópia 1:1). Estilos de janela variados, telhados com personalidade, cornija,
// caixa d'água e dithering sutil. Tudo puro/determinístico.
// ---------------------------------------------------------------------------
type WinShape = "std" | "narrow" | "square" | "arch";

// Estilo de janela por prédio: 2x3 padrão, estreita, quadrada (o arco é forçado
// à parte nos prédios "biblioteca"). Recebe um float 0..1 de uma rng dedicada.
function pickWinShape(r: number): WinShape {
  return r < 0.62 ? "std" : r < 0.81 ? "narrow" : "square";
}

// Desenha UMA janela conforme o estilo do prédio. `cls` (tt-w1/2/3) vai só no
// retângulo principal — o subconjunto que pisca continua igual ao de antes.
function paintWindow(
  p: Painter,
  x: number,
  y: number,
  winW: number,
  winH: number,
  shape: WinShape,
  fill: string,
  off: string,
  cls?: string
): void {
  if (shape === "narrow") {
    p.r(x, y, Math.max(1, winW - 2), winH, fill, undefined, cls); // fresta fina
  } else if (shape === "square") {
    const s = Math.max(2, winW - 1);
    p.r(x, y, s, s, fill, undefined, cls); // quadradinha
  } else if (shape === "arch") {
    const aw = Math.max(3, winW);
    p.r(x, y, aw, winH, fill, undefined, cls);
    p.r(x, y, 1, 1, off); // cantos apagados -> arco de 1px
    p.r(x + aw - 1, y, 1, 1, off);
  } else {
    p.r(x, y, winW, winH, fill, undefined, cls); // 2x3 padrão
  }
}

// Telhado com personalidade sobre um prédio já erguido (laje base + extra por
// estilo). watertank só no `full` (some detalhe fino demais na mini).
function drawRoof(
  p: Painter,
  x: number,
  top: number,
  w: number,
  roofCol: string,
  body: string,
  style: string,
  winH: number,
  full: boolean
): void {
  const rh = Math.max(1, Math.round(winH * 0.5));
  p.r(x, top - rh, w, rh, roofCol); // laje base (como antes)
  if (style === "parapet") {
    p.r(x, top - rh, 1, rh, mixHex(roofCol, "#ffffff", 0.2)); // mureta clara à esq
    p.r(x + w - 1, top - rh, 1, rh, mixHex(roofCol, "#000000", 0.2));
  } else if (style === "antenna") {
    const mx = x + Math.round(w / 2) - 1;
    const mh = Math.max(3, winH);
    p.r(mx, top - rh - mh, 1, mh, mixHex(roofCol, "#ffffff", 0.15)); // mastro
    p.r(mx, top - rh - mh - 1, 1, 1, ANTENNA_LIGHT); // luz na ponta
  } else if (style === "watertank" && full) {
    drawTank(p, x, top, w, winH, body);
  }
}

// Caixinha d'água sobre o telhado (topo mais claro, "perninhas" implícitas).
function drawTank(p: Painter, x: number, top: number, w: number, winH: number, body: string): void {
  const rh = Math.max(1, Math.round(winH * 0.5));
  const th = Math.max(3, winH);
  const tw = Math.max(3, Math.round(w * 0.32));
  p.r(x + Math.max(1, Math.round(w * 0.12)), top - rh - th, tw, th, mixHex(body, "#000000", 0.24));
  p.r(x + Math.max(1, Math.round(w * 0.12)), top - rh - th - 1, tw, 1, mixHex(body, "#000000", 0.08));
}

// FAROL listrado (marco `lighthouse`): quebra-mar + fuste branco com faixas
// vermelhas + lanterna acesa + feixe (mantém as classes tt-lighthouse/tt-beam).
// Compartilhado pelas duas cenas (seeded e cidade real) -> estilo idêntico.
function drawLighthouse(p: Painter, o: SceneOpts, winH: number): void {
  const { W, H, base } = o;
  const waterH = H - base;
  const lw = Math.max(4, Math.round(base * 0.08));
  const lh = Math.round(base * 0.5);
  const lx = Math.round(W - base * 0.16 - lw);
  const lt = base - lh;
  p.raw(`<g class="tt-lighthouse">`);
  // quebra-mar (molhe de pedras + estacas) -> o farol PERTENCE à ponta da costa.
  p.r(lx - 3, base, lw + 6, 2, mixHex(LH_ROCK, "#000000", 0.12));
  p.r(lx - 4, base + 2, lw + 8, 2, mixHex(LH_ROCK, "#000000", 0.34));
  for (let kk = 0; kk < lw + 6; kk += 3) p.r(lx - 3 + kk, base + 4, 1, 3, "#1c1620");
  // fuste BRANCO + FAIXAS VERMELHAS (listrado como o app).
  p.r(lx, lt, lw, lh, LH_TOWER);
  const stripeStep = Math.max(4, Math.round(lh / 6));
  const stripeH = Math.max(2, Math.round(stripeStep * 0.5));
  for (let k = 0; k < lh; k += stripeStep) p.r(lx, lt + k, lw, stripeH, LH_STRIPE);
  // sombreado cilíndrico por cima (realce à esq, sombra à dir) — vale p/ branco e vermelho.
  p.r(lx, lt, 1, lh, mixHex(LH_TOWER, "#ffffff", 0.3), 0.5);
  p.r(lx + lw - 1, lt, 1, lh, mixHex("#000000", LH_STRIPE, 0.2), 0.4);
  // lanterna acesa + base + teto.
  const lanW = lw + 2;
  p.r(lx - 1, lt - Math.max(2, winH), lanW, Math.max(2, winH), "#3a3a52");
  p.r(lx, lt - Math.max(4, winH * 2), lw, Math.max(3, winH), LH_LANTERN);
  p.r(lx - 1, lt - Math.max(5, winH * 2) - 2, lanW, 2, mixHex(LH_TRIM, "#3a2438", 0.5));
  // feixe de luz (triângulo) subindo pra esquerda — classe tt-beam (anima no CSS).
  const bx = lx + lw / 2;
  const by = lt - Math.max(3, winH * 1.5);
  const reach = Math.round(base * 1.1);
  p.raw(
    `<polygon class="tt-beam" points="${bx},${by} ${bx - reach},${by - base * 0.2} ${bx - reach},${by + base * 0.28}" fill="${LH_LANTERN}" opacity="0.12"/>`
  );
  if (o.reflection) p.r(lx, base + 1, lw, Math.min(lh, waterH - 1), mixHex(LH_TOWER, "#000000", 0.2), 0.22);
  p.raw(`</g>`);
}

// DITHERING sutil do CÉU — pixels esparsos perto das fronteiras das bandas pra
// quebrar o "listrado" do gradiente (textura retrô). Bounded por o.dither (mini
// = 0 -> nada muda na mini, performance do ranking preservada). rng dedicada.
function drawSkyDither(p: Painter, o: SceneOpts, seed: number): void {
  if (o.dither <= 0) return;
  const r = mulberry32((seed ^ 0x0da7ade7) >>> 0);
  const bands = 14;
  const bandH = Math.max(1, Math.round(o.base / bands));
  for (let k = 0; k < o.dither; k++) {
    const bi = 1 + Math.floor(r() * (bands - 2));
    const t = bi / (bands - 1);
    const seg = t * (SKY.length - 1);
    const idx = Math.min(SKY.length - 2, Math.floor(seg));
    const c1 = mixHex(SKY[idx], SKY[idx + 1], seg - idx);
    const x = Math.floor(r() * o.W);
    const y = Math.round((o.base * bi) / bands) - Math.floor(r() * bandH);
    p.r(x, y, 1, 1, r() < 0.5 ? mixHex(c1, "#ffffff", 0.07) : mixHex(c1, "#000000", 0.08), 0.5);
  }
}

// DITHERING sutil da ÁGUA — pouquíssimos brilhos de 1px (textura, não pisca).
function drawWaterDither(p: Painter, o: SceneOpts, seed: number): void {
  if (o.dither <= 0) return;
  const r = mulberry32((seed ^ 0x7a1e2b3c) >>> 0);
  const waterH = o.H - o.base;
  const n = Math.max(1, Math.round(o.dither * 0.4));
  for (let k = 0; k < n; k++) {
    const x = Math.floor(r() * o.W);
    const y = o.base + 2 + Math.floor(r() * Math.max(1, waterH - 2));
    p.r(x, y, 1, 1, mixHex(WATER_TOP, "#cfe0f0", 0.3), 0.12);
  }
}

// ---------------------------------------------------------------------------
// FOGOS DO FINALE — a ÚLTIMA noite da temporada, o site inteiro (mini e grande)
// solta fogos acima da skyline. DETERMINÍSTICO pela seed de cada cidade, num
// stream de rng PRÓPRIO (não perturba o layout dos prédios, então fora do finale
// o SVG é byte-idêntico ao de antes). Cores da paleta, sem neon. Cada rajada num
// grupo com classe de delay (tt-f1/2/3) pra estourarem em tempos diferentes (CSS).
// ---------------------------------------------------------------------------
const FW_COLS = ["#f2b47a", "#e08aa0", "#7fc7bf", "#ffd79a"]; // amber, rosa, teal, ouro
function drawFinaleFireworks(p: Painter, seed: number, o: SceneOpts, full: boolean): void {
  const { W, base } = o;
  const rng = mulberry32((seed ^ 0xf17e0a5e) >>> 0); // stream dedicado
  const bursts = full ? 4 : 2;
  p.raw(`<g class="tt-fogos tt-finale-fogos">`);
  for (let b = 0; b < bursts; b++) {
    p.raw(`<g class="tt-burst tt-f${(b % 3) + 1}">`);
    const cx = Math.round(base * 0.28 + rng() * (W - base * 0.56));
    const cy = Math.round(base * (0.06 + rng() * 0.2)); // alto, acima da skyline
    const rad = Math.max(3, Math.round(base * (0.06 + rng() * 0.06)));
    const col = FW_COLS[Math.floor(rng() * FW_COLS.length)];
    p.r(cx, cy, 1, 1, "#ffffff", 0.95); // núcleo
    const rays = 10;
    for (let a = 0; a < rays; a++) {
      const ang = (a / rays) * Math.PI * 2;
      p.r(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), 1, 1, col, 0.85);
      p.r(Math.round(cx + Math.cos(ang) * rad * 0.55), Math.round(cy + Math.sin(ang) * rad * 0.55), 1, 1, col, 0.55);
    }
    p.raw(`</g>`);
  }
  p.raw(`</g>`);
}

function buildScene(input: CityInput, o: SceneOpts, full: boolean, finale = false): Painter {
  const f = cityFeatures(input);
  const p = new Painter();
  const { W, H, base } = o;
  const win = accentedWindow(input.accent); // dourado tingido de leve pela cor do perfil

  const seed = hashSeed(input.username || "anon");
  const rng = mulberry32(seed);
  // stream separado pro céu (estrelas), pra layout de prédios não mudar a lua/estrelas
  const skyRng = mulberry32(hashSeed((input.username || "anon") + "~sky") >>> 0);

  // ---- CÉU: bandas horizontais interpoladas (gradiente pixelado, sem <defs>) ----
  const bands = 14;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    // topo escuro -> horizonte quente: percorre os stops de SKY
    const seg = t * (SKY.length - 1);
    const idx = Math.min(SKY.length - 2, Math.floor(seg));
    const col = mixHex(SKY[idx], SKY[idx + 1], seg - idx);
    const y = Math.round((base * i) / bands);
    const y2 = Math.round((base * (i + 1)) / bands);
    p.r(0, y, W, y2 - y + 1, col);
  }

  // ---- ESTRELAS (metade de cima do céu) ----
  for (let s = 0; s < o.stars; s++) {
    const sx = Math.floor(skyRng() * W);
    const sy = Math.floor(skyRng() * base * 0.62);
    const bright = skyRng();
    p.r(sx, sy, 1, 1, STAR, bright < 0.25 ? 0.9 : 0.5);
  }

  // ---- DITHERING sutil do céu (quebra o "listrado" das bandas) ----
  drawSkyDither(p, o, seed);

  // ---- LUA + halo (canto superior direito) ----
  const moonR = Math.max(3, Math.round(base * 0.12));
  const moonX = Math.round(W * 0.8);
  const moonY = Math.round(base * 0.26);
  p.raw(`<circle cx="${moonX}" cy="${moonY}" r="${moonR * 1.9}" fill="${MOON_HALO}" opacity="0.16"/>`);
  p.raw(`<circle cx="${moonX}" cy="${moonY}" r="${moonR}" fill="${MOON_CORE}" opacity="0.9"/>`);
  p.raw(
    `<circle cx="${moonX + moonR * 0.4}" cy="${moonY - moonR * 0.3}" r="${moonR * 0.8}" fill="${SKY[1]}" opacity="0.55"/>`
  );

  // ---- FINALE: fogos acima da skyline (seed do username) ----
  if (finale) drawFinaleFireworks(p, seed, o, o.W >= 400);

  // ---- SILHUETA DISTANTE (parallax, dá profundidade) ----
  const backCol = mixHex(SKY[2], "#000000", 0.25);
  const backStep = Math.max(6, Math.round(base * 0.16));
  for (let x = -backStep; x < W + backStep; x += backStep) {
    const bh = Math.round(base * (0.12 + skyRng() * 0.16));
    p.r(x, base - bh, backStep - 1, bh, backCol, 0.55);
  }

  // ---- PRÉDIOS DA FRENTE ----
  // largura/altura em função da densidade (mais prédios -> mais estreitos).
  const wLo = Math.max(3, Math.round(base * lerp(0.2, 0.1, f.density)));
  const wHi = Math.max(wLo + 2, Math.round(base * lerp(0.36, 0.17, f.density)));
  const hLo = Math.round(base * 0.18);
  const hHi = Math.round(base * (f.towers ? 0.86 : 0.66)); // marco torres: mais altos
  const gapBase = Math.max(1, Math.round(base * 0.03));

  // janelas: tamanho escala com a cena. Piso de 2px + divisor menor deixa a
  // janela LEGÍVEL (nunca 1px que some) e a arte lê como pixel-art nítida.
  const winW = Math.max(2, Math.round(base / 22));
  const winH = Math.max(3, winW + 1);
  const stepX = winW + Math.max(2, Math.round(winW * 0.9));
  const stepY = winH + Math.max(2, Math.round(winH * 0.8));

  const placed: Placed[] = [];
  let blinkN = 0; // rotaciona tt-w1/tt-w2/tt-w3 entre as janelas que piscam
  let x = Math.round(base * 0.04);
  let i = 0;
  const maxLoops = 400;
  while (x < W - wLo && i < maxLoops) {
    const w = Math.round(lerp(wLo, wHi, rng()));
    // onda suave no skyline + variação
    const wave = Math.max(0, Math.sin(i * 0.7)) * base * 0.08;
    let h = Math.round(lerp(hLo, hHi, rng()) + wave);
    const landmark = i % 9 === 4; // um prédio-marco de tempos em tempos
    if (landmark) h = Math.max(h, Math.round(base * 0.8));
    if (f.towers && rng() < 0.4) h += Math.round(base * 0.12);
    h = Math.min(h, base - 2);

    const body = BODY[i % BODY.length];
    const roof = ROOF[i % ROOF.length];
    const top = base - h;

    // PERSONALIDADE por prédio (rng dedicada -> não perturba layout/janelas). Em
    // cachos: ~1/3 dos prédios é "detalhado" e nunca dois vizinhos ao mesmo tempo.
    const dr = mulberry32((seed ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0);
    const detailed = !landmark && (((i % 3) + 3) % 3) === seed % 3;
    let shape: WinShape = pickWinShape(dr());
    const isLib = detailed && dr() < 0.3; // fachada "biblioteca" -> janelas em arco
    if (isLib) shape = "arch";
    const roofStyle = ROOF_STYLES[Math.floor(dr() * ROOF_STYLES.length)];
    const hasTank = full && !landmark && roofStyle !== "watertank" && dr() < 0.12;

    // corpo + aresta iluminada à esquerda + sombra à direita (separa os prédios
    // vizinhos -> a skyline lê como blocos distintos, não uma mancha só).
    p.r(x, top, w, h, body);
    p.r(x, top, 1, h, mixHex(body, "#ffffff", 0.2));
    p.r(x + w - 1, top, 1, h, mixHex(body, "#000000", 0.34));
    // telhado / antena nos prédios-marco; senão telhado COM PERSONALIDADE.
    if (landmark) {
      p.r(x - 1, top - Math.max(2, winH), w + 2, Math.max(2, Math.round(winH * 0.8)), roof);
      p.r(x + w / 2 - 1, top - Math.max(4, winH * 2), 2, Math.max(3, winH), roof);
      p.r(x + w / 2 - 1, top - Math.max(5, winH * 2), 2, 2, "#ffe6a8");
    } else {
      drawRoof(p, x, top, w, roof, body, roofStyle, winH, full);
      if (hasTank) drawTank(p, x, top, w, winH, body);
    }

    // janelas (acesas conforme litRatio; núcleo mais quente nas mais acesas).
    // unlit BEM escura -> contraste alto com o dourado das acesas (lê nítido).
    const off = mixHex(body, "#000000", 0.58);
    const cols = Math.max(1, Math.floor((w - 2) / stepX));
    const rows = Math.max(1, Math.floor((h - winH - 2) / stepY));
    const pad = Math.max(1, Math.round((w - (cols * stepX - (stepX - winW))) / 2));
    const acDetailed = full && detailed && shape !== "arch"; // ar-condicionado só no grande
    for (let c = 0; c < cols; c++) {
      for (let rr = 0; rr < rows; rr++) {
        const wl = rng();
        const wx = x + pad + c * stepX;
        const wy = top + winH + rr * stepY;
        if (wy + winH > base - 1) continue;
        const lit = wl < f.litRatio;
        const fill = lit ? (wl < f.litRatio * 0.3 ? win.bright : win.warm) : off;
        // só um subconjunto esparso pisca (calmo) — rotaciona os 3 delays.
        const cls = lit && wl < f.litRatio * 0.12 ? `tt-w${(blinkN++ % 3) + 1}` : undefined;
        paintWindow(p, wx, wy, winW, winH, shape, fill, off, cls);
        if (acDetailed && (c * 7 + rr * 13 + i) % 10 === 0 && wy + winH + 1 < base - 1) {
          p.r(wx, wy + winH, winW, 1, mixHex(body, "#000000", 0.1)); // caixinha de ar
          p.r(wx, wy + winH + 1, 1, 1, mixHex("#9ab0c0", body, 0.5)); // pingo
        }
      }
    }
    // CORNIJA: friso 1px mais claro a cada ~5 andares nos altos detalhados.
    if (full && detailed && h > base * 0.42) {
      const cc = mixHex(body, "#ffffff", 0.14);
      for (let cf = top + winH + stepY * 4; cf < base - 4; cf += stepY * 5) p.r(x, Math.round(cf), w, 1, cc);
    }

    placed.push({ x, w, h, body });
    x += w + gapBase + Math.round(rng() * gapBase * 1.6);
    i++;
  }

  // ---- MARCO: jardim na orla (esquerda), >= 100k ----
  if (f.garden) {
    const gw = Math.round(base * 0.5);
    const gx = Math.round(base * 0.05);
    const gy = base - Math.max(2, Math.round(base * 0.05));
    p.raw(`<g class="tt-garden">`);
    p.r(gx, gy, gw, base - gy, GRASS);
    const nFlowers = Math.max(4, Math.round(gw / Math.max(3, winW * 2)));
    for (let k = 0; k < nFlowers; k++) {
      const fx = gx + 1 + Math.round((k * (gw - 2)) / nFlowers);
      p.r(fx, gy - winH, Math.max(1, winW - 1), winH, mixHex(FLOWERS[k % FLOWERS.length], "#4a3a5a", 0.35));
    }
    // arvorezinhas
    for (let k = 0; k < 2; k++) {
      const tx = gx + Math.round(gw * (0.3 + k * 0.4));
      const th = Math.max(4, Math.round(base * 0.1));
      p.r(tx, gy - th, Math.max(1, Math.round(winW * 0.8)), th, mixHex("#4a3a3a", "#2a2230", 0.4));
      const cr = Math.max(3, Math.round(base * 0.07));
      p.r(tx - cr / 2, gy - th - cr, cr, cr, GRASS);
    }
    p.raw(`</g>`);
  }

  // ---- ÁGUA ----
  const waterH = H - base;
  p.r(0, base, W, 1, WATERLINE); // linha d'água quente
  p.r(0, base + 1, W, waterH, WATER_DEEP); // profundo
  p.r(0, base + 1, W, Math.max(2, Math.round(waterH * 0.34)), WATER_TOP); // banda de cima
  drawWaterDither(p, o, seed); // textura sutil na água

  // ---- REFLEXOS dos prédios ----
  if (o.reflection) {
    for (const b of placed) {
      const rh = Math.min(b.h, waterH - 1);
      if (rh <= 0) continue;
      p.r(b.x, base + 1, b.w, rh, mixHex(b.body, "#8a90c8", 0.12), 0.3);
    }
    // reflexo da lua
    p.r(moonX - Math.round(moonR * 0.4), base + 1, Math.max(1, Math.round(moonR * 0.8)), waterH - 1, MOON_CORE, 0.14);
    // brilhos horizontais na água (tt-water: tremulam de leve na cidade grande)
    p.raw(`<g class="tt-water">`);
    const shimmers = Math.max(2, Math.round(waterH / 9)); // menos linhas -> água mais limpa
    for (let sh = 0; sh < shimmers; sh++) {
      const sy = base + 2 + Math.round((sh + 0.5) * (waterH / (shimmers + 1)));
      p.r(0, sy, W, 1, mixHex(WATER_TOP, "#cfe0f0", 0.35), 0.1);
    }
    p.raw(`</g>`);
  }

  // ---- MARCO: FAROL (direita), >= 1M — listrado vermelho/branco, com feixe ----
  if (f.lighthouse) drawLighthouse(p, o, winH);

  // ---- MARCO: BALSA cruzando a água, >= 300k ----
  if (f.ferry) {
    const fw = Math.max(10, Math.round(base * 0.2));
    const fx = Math.round(W * 0.34);
    const fy = base + Math.max(3, Math.round(waterH * 0.42));
    p.raw(`<g class="tt-ferry">`);
    p.r(fx, fy, fw, Math.max(2, Math.round(fw * 0.2)), "#2e2440"); // casco
    p.r(fx + fw * 0.15, fy - Math.round(fw * 0.2), fw * 0.7, Math.round(fw * 0.2), "#3e3452"); // cabine
    p.r(fx + fw * 0.4, fy - Math.round(fw * 0.45), Math.max(1, Math.round(fw * 0.08)), Math.round(fw * 0.28), "#556"); // mastro
    p.r(fx + fw - 2, fy + 1, 1, 1, "#ff8a6a"); // luzinha estibordo
    p.r(fx, fy + 1, 1, 1, "#8affa0"); // luzinha bombordo
    p.raw(`</g>`);
  }

  // ---- POSTES na orla da frente (vida) ----
  for (let l = 0; l < o.lamps; l++) {
    const lx = Math.round(base * 0.16 + (l + 0.5) * ((W - base * 0.2) / o.lamps));
    const ph = Math.max(5, Math.round(base * 0.12));
    p.r(lx, base - ph, 1, ph, mixHex("#5a4a55", "#2a2230", 0.4));
    p.r(lx - 1, base - ph - 2, 3, 3, LAMP_ON);
    p.r(lx - 2, base - ph - 3, 5, 5, LAMP_ON, 0.28); // brilho
  }

  return p;
}

// ---------------------------------------------------------------------------
// GERAÇÃO DA CENA — CIDADE REAL. Tudo semeado por `city.seed` (mesma cidade
// sempre); `buildings` densidade; `pop` janelas acesas; `types` desenham as
// construções especiais RECONHECÍVEIS; `marcos` os enfeites ambientais; `era`
// muda o tom do céu/prédios e a altura média. Objetivo: DIVERSIDADE VISUAL REAL.
// ---------------------------------------------------------------------------
const KNOWN_MARCOS = new Set(["garden", "ferry", "lighthouse", "towers", "festival", "fireworks"]);

function buildRealScene(city: RealCity, o: SceneOpts, full: boolean, finale = false, accentHex?: string | null): Painter {
  const p = new Painter();
  const { W, H, base } = o;
  const waterH = H - base;
  const win = accentedWindow(accentHex); // dourado tingido de leve pela cor do perfil

  const seed = city.seed >>> 0;
  const rng = mulberry32(seed);
  const skyRng = mulberry32((city.seed ^ 0x9e3779b9) >>> 0);
  const has = (m: string) => city.marcos.includes(m);

  // densidade dos prédios / janelas acesas (mesmas curvas do fallback).
  const density = clamp01(Math.log10(city.buildings + 1) / Math.log10(3000));
  const litRatio = clamp(0.16 + (Math.log10(city.pop + 1) / Math.log10(400)) * 0.78, 0.16, 0.94);

  // ERA: tom (frio->quente) + altura média.
  const eraT = clamp01(city.era / 8);
  const eraCol = eraT < 0.5 ? "#243a6a" : "#5a2a48"; // era baixa = fria/antiga; alta = quente/moderna
  const eraAmt = Math.abs(eraT - 0.5) * 0.6; // 0..0.3
  const heightF = lerp(0.6, 1.02, eraT); // era baixa = cidade mais baixa

  // janelas: piso de 2px + divisor menor -> janela legível (nunca 1px que some).
  const winW = Math.max(2, Math.round(base / 22));
  const winH = Math.max(3, winW + 1);
  const stepX = winW + Math.max(2, Math.round(winW * 0.9));
  const stepY = winH + Math.max(2, Math.round(winH * 0.8));

  let blinkN = 0; // rotaciona tt-w1/tt-w2/tt-w3 entre as janelas que piscam
  // shape/acDetailed/bIdx opcionais -> especiais chamam com padrão (janelas 2x3);
  // prédios COMUNS passam o estilo do prédio + ar-condicionado nos detalhados.
  const lightWindows = (
    x: number,
    top: number,
    w: number,
    h: number,
    bodyCol: string,
    shape: WinShape = "std",
    acDetailed = false,
    bIdx = 0
  ) => {
    // unlit BEM escura -> contraste alto com o dourado das acesas (lê nítido).
    const off = mixHex(bodyCol, "#000000", 0.58);
    const cols = Math.max(1, Math.floor((w - 2) / stepX));
    const rows = Math.max(1, Math.floor((h - winH - 2) / stepY));
    const pad = Math.max(1, Math.round((w - (cols * stepX - (stepX - winW))) / 2));
    for (let c = 0; c < cols; c++) {
      for (let rr = 0; rr < rows; rr++) {
        const wl = rng();
        const wx = x + pad + c * stepX;
        const wy = top + winH + rr * stepY;
        if (wy + winH > base - 1) continue;
        const lit = wl < litRatio;
        const fill = lit ? (wl < litRatio * 0.3 ? win.bright : win.warm) : off;
        // só um subconjunto esparso pisca (calmo) — rotaciona os 3 delays.
        const cls = lit && wl < litRatio * 0.12 ? `tt-w${(blinkN++ % 3) + 1}` : undefined;
        paintWindow(p, wx, wy, winW, winH, shape, fill, off, cls);
        if (acDetailed && shape !== "arch" && (c * 7 + rr * 13 + bIdx) % 10 === 0 && wy + winH + 1 < base - 1) {
          p.r(wx, wy + winH, winW, 1, mixHex(bodyCol, "#000000", 0.1)); // caixinha de ar
          p.r(wx, wy + winH + 1, 1, 1, mixHex("#9ab0c0", bodyCol, 0.5)); // pingo
        }
      }
    }
  };

  // ---- CÉU tingido pela era ----
  const bands = 14;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const seg = t * (SKY.length - 1);
    const idx = Math.min(SKY.length - 2, Math.floor(seg));
    let col = mixHex(SKY[idx], SKY[idx + 1], seg - idx);
    col = mixHex(col, eraCol, eraAmt * 0.5);
    const y = Math.round((base * i) / bands);
    const y2 = Math.round((base * (i + 1)) / bands);
    p.r(0, y, W, y2 - y + 1, col);
  }

  // ---- ESTRELAS ----
  for (let s = 0; s < o.stars; s++) {
    const sx = Math.floor(skyRng() * W);
    const sy = Math.floor(skyRng() * base * 0.62);
    const b = skyRng();
    p.r(sx, sy, 1, 1, STAR, b < 0.25 ? 0.9 : 0.5);
  }

  // ---- DITHERING sutil do céu ----
  drawSkyDither(p, o, seed);

  // ---- LUA ----
  const moonR = Math.max(3, Math.round(base * 0.12));
  const moonX = Math.round(W * 0.8);
  const moonY = Math.round(base * 0.26);
  p.raw(`<circle cx="${moonX}" cy="${moonY}" r="${moonR * 1.9}" fill="${MOON_HALO}" opacity="0.16"/>`);
  p.raw(`<circle cx="${moonX}" cy="${moonY}" r="${moonR}" fill="${MOON_CORE}" opacity="0.9"/>`);
  p.raw(
    `<circle cx="${moonX + moonR * 0.4}" cy="${moonY - moonR * 0.3}" r="${moonR * 0.8}" fill="${SKY[1]}" opacity="0.55"/>`
  );

  // ---- FINALE: fogos acima da skyline (seed da cidade) ----
  if (finale) drawFinaleFireworks(p, city.seed >>> 0, o, full);

  // ---- MARCO: FOGOS (no céu, atrás da skyline) ----
  if (has("fireworks")) {
    p.raw(`<g class="tt-fogos">`);
    const bursts = full ? 3 : 2;
    const cols = ["#f2b47a", "#e08aa0", "#7fc7bf", "#ffd79a"];
    for (let b = 0; b < bursts; b++) {
      const cx = Math.round(base * 0.3 + rng() * (W - base * 0.6));
      const cy = Math.round(base * (0.12 + rng() * 0.24));
      const rad = Math.max(3, Math.round(base * (0.06 + rng() * 0.05)));
      const col = cols[Math.floor(rng() * cols.length)];
      p.r(cx, cy, 1, 1, "#ffffff", 0.9);
      const rays = 8;
      for (let a = 0; a < rays; a++) {
        const ang = (a / rays) * Math.PI * 2;
        p.r(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), 1, 1, col, 0.85);
        p.r(Math.round(cx + Math.cos(ang) * rad * 0.55), Math.round(cy + Math.sin(ang) * rad * 0.55), 1, 1, col, 0.5);
      }
    }
    p.raw(`</g>`);
  }

  // ---- SILHUETA DISTANTE ----
  const backCol = mixHex(mixHex(SKY[2], "#000000", 0.25), eraCol, eraAmt * 0.4);
  const backStep = Math.max(6, Math.round(base * 0.16));
  for (let x = -backStep; x < W + backStep; x += backStep) {
    const bh = Math.round(base * (0.12 + skyRng() * 0.16));
    p.r(x, base - bh, backStep - 1, bh, backCol, 0.55);
  }

  // ---- MARCO: JARDIM na orla esquerda ----
  if (has("garden")) {
    const gw = Math.round(base * 0.42);
    const gx = Math.round(base * 0.05);
    const gy = base - Math.max(2, Math.round(base * 0.05));
    p.raw(`<g class="tt-garden">`);
    p.r(gx, gy, gw, base - gy, GRASS);
    const nF = Math.max(4, Math.round(gw / Math.max(3, winW * 2)));
    for (let k = 0; k < nF; k++) {
      const fx = gx + 1 + Math.round((k * (gw - 2)) / nF);
      p.r(fx, gy - winH, Math.max(1, winW - 1), winH, mixHex(FLOWERS[k % FLOWERS.length], "#4a3a5a", 0.35));
    }
    p.raw(`</g>`);
  }

  // ---- CONSTRUÇÕES ESPECIAIS (types) — cada tipo com arte própria e classe tt-b-<slug> ----
  const specialWidth = (slug: string): number => {
    switch (slug) {
      case "torre":
        return Math.max(4, Math.round(base * 0.12));
      case "mirante":
        return Math.max(5, Math.round(base * 0.14));
      case "biblioteca":
        return Math.max(8, Math.round(base * 0.22));
      case "cais":
        return Math.max(10, Math.round(base * 0.24));
      case "parque":
      case "praca":
        return Math.max(10, Math.round(base * 0.26));
      default:
        return Math.max(6, Math.round(base * 0.18));
    }
  };

  const drawSpecial = (slug: string, x: number, w: number): { h: number; body: string } => {
    p.raw(`<g class="tt-b-${slug}">`);
    let refH = Math.round(base * 0.3);
    let refBody = mixHex(BODY[0], eraCol, eraAmt);
    switch (slug) {
      case "torre": {
        const th = Math.min(base - 2, Math.round(base * 0.72 * heightF));
        const top = base - th;
        const bt = mixHex("#4a4166", eraCol, eraAmt);
        p.r(x, top, w, th, bt);
        p.r(x, top, 1, th, mixHex(bt, "#ffffff", 0.12));
        p.r(x, top - 2, w, 2, "#8a6a9a"); // coroa
        p.r(x + w / 2 - 1, top - Math.max(4, winH * 2), 2, Math.max(3, winH * 2), "#6a5a7a"); // antena
        p.r(x + w / 2 - 1, top - Math.max(5, winH * 2) - 1, 2, 2, "#ff9a6a"); // luz de topo
        lightWindows(x, top, w, th, bt);
        refH = th;
        refBody = bt;
        break;
      }
      case "biblioteca": {
        const bh = Math.min(base - 2, Math.round(base * 0.36 * heightF));
        const top = base - bh;
        const bd = mixHex("#2e2440", eraCol, eraAmt);
        p.r(x, top, w, bh, bd);
        p.r(x, top, 1, bh, mixHex(bd, "#ffffff", 0.1));
        p.r(x - 1, top - 2, w + 2, 2, "#5a4030"); // cornija
        const nWin = 3;
        for (let k = 0; k < nWin; k++) {
          const wx2 = x + 2 + Math.round((k * (w - 4)) / nWin);
          p.r(wx2, top + 4, Math.max(2, Math.round(w / 8)), Math.max(3, bh - 8), "#ffdf9a"); // janelões dourados
        }
        p.r(x + w / 2 - 2, base - Math.max(4, Math.round(bh * 0.16)), 4, Math.max(4, Math.round(bh * 0.16)), "#2a1e1a"); // porta
        refH = bh;
        refBody = bd;
        break;
      }
      case "mirante": {
        const mh = Math.min(base - 2, Math.round(base * 0.44 * heightF));
        const top = base - mh;
        const mastFrom = Math.round(base * 0.05);
        p.r(x + w / 2 - 1, top + mastFrom, 2, Math.max(3, mh - mastFrom), "#342a40"); // mastro
        p.r(x - 1, top + 2, w + 2, Math.max(3, Math.round(base * 0.05)), "#3a2e44"); // plataforma
        for (let k = 0; k < w + 2; k += 3) p.r(x - 1 + k, top - 1, 1, 3, "#4a3e58"); // guarda-corpo
        p.r(x + w / 2 - 1, top - 3, 2, 2, "#ffe6a8"); // luzinha
        refH = mh;
        refBody = "#342a40";
        break;
      }
      case "cais": {
        const dh = Math.max(2, Math.round(base * 0.03));
        p.r(x, base - dh, w, dh, "#5a4530"); // deque
        for (let k = 0; k < w; k += 4) p.r(x + k, base, 1, Math.max(3, Math.round(base * 0.08)), "#241c1a"); // estacas na água
        const bw = Math.max(5, Math.round(w * 0.35));
        const bx = x + w - bw;
        p.r(bx, base + Math.round(base * 0.07), bw, 2, "#4a2a34"); // barquinho
        p.r(bx + Math.round(bw * 0.5), base + Math.round(base * 0.03), 1, Math.max(3, Math.round(base * 0.04)), "#556"); // mastro
        refH = dh;
        refBody = "#5a4530";
        break;
      }
      case "parque": {
        const gh = Math.max(3, Math.round(base * 0.06));
        p.r(x, base - gh, w, gh, GRASS); // gramado
        for (let k = 0; k < 2; k++) {
          const tx = x + Math.round(w * 0.28) + k * Math.round(w * 0.44);
          const th = Math.max(4, Math.round(base * 0.1));
          p.r(tx, base - gh - th, Math.max(1, Math.round(winW * 0.8)), th, "#2a2230"); // tronco
          const cr = Math.max(2, Math.round(base * 0.06));
          p.r(tx - Math.round(cr * 0.4), base - gh - th - cr, cr, cr, GRASS); // copa
        }
        p.r(x + Math.round(w / 2) - 2, base - gh - 2, 4, 2, "#3a2e2a"); // banco
        refH = gh;
        refBody = GRASS;
        break;
      }
      case "praca": {
        const ph = Math.max(2, Math.round(base * 0.04));
        p.r(x, base - ph, w, ph, "#332a3e"); // piso
        const fx = x + Math.round(w / 2);
        p.r(fx - 3, base - ph - 3, 6, 3, "#3a3a52"); // fonte
        p.r(fx - 1, base - ph - 6, 2, 3, "#4a5a7a"); // jato d'água
        const lampH = Math.round(base * 0.08);
        p.r(x + 2, base - ph - lampH, 1, lampH, "#2a2230"); // lampião
        p.r(x + 1, base - ph - lampH - 2, 3, 3, LAMP_ON); // luz
        refH = ph;
        refBody = "#332a3e";
        break;
      }
      default: {
        // GENÉRICO BONITO para tipos desconhecidos (vocabulário aberto): prédio
        // médio com telhado de cor própria derivada do nome do tipo.
        const gh = Math.min(base - 2, Math.round(base * (0.28 + rng() * 0.14) * heightF));
        const top = base - gh;
        const gb = mixHex("#524565", eraCol, eraAmt);
        p.r(x, top, w, gh, gb);
        p.r(x, top, 1, gh, mixHex(gb, "#ffffff", 0.1));
        p.r(x - 1, top - 2, w + 2, 3, ROOF[hashSeed(slug) % ROOF.length]); // telhado colorido por tipo
        lightWindows(x, top, w, gh, gb);
        refH = gh;
        refBody = gb;
        break;
      }
    }
    p.raw(`</g>`);
    return { h: refH, body: refBody };
  };

  // fila de especiais em round-robin (espalha os tipos), com tetos.
  const CAP_DRAW = 6; // instâncias desenhadas por tipo
  const CAP_TOTAL = full ? 18 : 6;
  const entries = Object.entries(city.types).map(([slug, count]) => ({ slug, left: Math.min(count, CAP_DRAW) }));
  const queue: string[] = [];
  let progress = true;
  while (queue.length < CAP_TOTAL && progress) {
    progress = false;
    for (const e of entries) {
      if (e.left > 0) {
        queue.push(e.slug);
        e.left--;
        progress = true;
        if (queue.length >= CAP_TOTAL) break;
      }
    }
  }

  // larguras/alturas dos prédios comuns.
  const wLo = Math.max(3, Math.round(base * lerp(0.2, 0.1, density)));
  const wHi = Math.max(wLo + 2, Math.round(base * lerp(0.36, 0.17, density)));
  const hLo = Math.round(base * 0.16);
  const hHi = Math.min(base - 2, Math.round(base * (has("towers") ? 0.9 : 0.66) * heightF));
  const gapBase = Math.max(1, Math.round(base * 0.03));

  // cadência: espalha os especiais pela skyline.
  const avgW = (wLo + wHi) / 2 + gapBase;
  const approxLots = Math.max(4, Math.floor((W - base * 0.08) / avgW));
  const cadence = queue.length > 0 ? Math.max(2, Math.floor(approxLots / (queue.length + 1))) : 999;
  const cadencePhase = Math.floor(cadence / 2);

  const placed: Placed[] = [];
  let x = Math.round(base * 0.04);
  let i = 0;
  let sIdx = 0;
  const maxLoops = 400;
  while (x < W - wLo && i < maxLoops) {
    // vez de um especial?
    if (sIdx < queue.length && i % cadence === cadencePhase) {
      const slug = queue[sIdx];
      const sw = specialWidth(slug);
      if (x + sw <= W - 2) {
        const ref = drawSpecial(slug, x, sw);
        placed.push({ x, w: sw, h: ref.h, body: ref.body });
        x += sw + gapBase + Math.round(rng() * gapBase);
        sIdx++;
        i++;
        continue;
      }
    }
    // prédio comum
    const w = Math.round(lerp(wLo, wHi, rng()));
    const wave = Math.max(0, Math.sin(i * 0.7)) * base * 0.08;
    let h = Math.round(lerp(hLo, hHi, rng()) + wave);
    if (has("towers") && rng() < 0.4) h += Math.round(base * 0.12);
    h = Math.min(h, base - 2);
    const body = mixHex(BODY[i % BODY.length], eraCol, eraAmt);
    const top = base - h;
    // PERSONALIDADE por prédio (rng dedicada -> não perturba layout/janelas).
    const dr = mulberry32((seed ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0);
    const detailed = (((i % 3) + 3) % 3) === seed % 3;
    let shape: WinShape = pickWinShape(dr());
    const isLib = detailed && dr() < 0.3; // fachada "biblioteca" -> janelas em arco
    if (isLib) shape = "arch";
    const roofStyle = ROOF_STYLES[Math.floor(dr() * ROOF_STYLES.length)];
    const hasTank = full && roofStyle !== "watertank" && dr() < 0.12;
    p.r(x, top, w, h, body);
    p.r(x, top, 1, h, mixHex(body, "#ffffff", 0.2)); // aresta iluminada à esquerda
    p.r(x + w - 1, top, 1, h, mixHex(body, "#000000", 0.34)); // sombra à direita (separa vizinhos)
    drawRoof(p, x, top, w, ROOF[i % ROOF.length], body, roofStyle, winH, full);
    if (hasTank) drawTank(p, x, top, w, winH, body);
    lightWindows(x, top, w, h, body, shape, full && detailed, i);
    // CORNIJA: friso 1px mais claro a cada ~5 andares nos altos detalhados.
    if (full && detailed && h > base * 0.42) {
      const cc = mixHex(body, "#ffffff", 0.14);
      for (let cf = top + winH + stepY * 4; cf < base - 4; cf += stepY * 5) p.r(x, Math.round(cf), w, 1, cc);
    }
    placed.push({ x, w, h, body });
    x += w + gapBase + Math.round(rng() * gapBase * 1.6);
    i++;
  }

  // ---- MARCO: TORRES — dois arranha-céus finos e altos (bairro das torres) ----
  if (has("towers")) {
    p.raw(`<g class="tt-towers">`);
    for (let k = 0; k < 2; k++) {
      const tw = Math.max(3, Math.round(base * 0.07));
      const tx = Math.round(W * (0.5 + k * 0.14));
      const th = Math.min(base - 2, Math.round(base * (0.9 + k * 0.05) * heightF));
      const top = base - th;
      const bt = mixHex("#4a4166", eraCol, eraAmt);
      p.r(tx, top, tw, th, bt);
      p.r(tx + tw / 2 - 1, top - Math.max(4, winH * 2), 2, Math.max(4, winH * 2), "#6a5a7a"); // antena
      p.r(tx + tw / 2 - 1, top - Math.max(5, winH * 2) - 1, 2, 2, "#ff9a6a"); // luz
      lightWindows(tx, top, tw, th, bt);
      placed.push({ x: tx, w: tw, h: th, body: bt });
    }
    p.raw(`</g>`);
  }

  // ---- ÁGUA ----
  p.r(0, base, W, 1, WATERLINE);
  p.r(0, base + 1, W, waterH, WATER_DEEP);
  p.r(0, base + 1, W, Math.max(2, Math.round(waterH * 0.34)), WATER_TOP);
  drawWaterDither(p, o, seed); // textura sutil na água

  // ---- REFLEXOS ----
  if (o.reflection) {
    for (const b of placed) {
      const rh = Math.min(b.h, waterH - 1);
      if (rh <= 0) continue;
      p.r(b.x, base + 1, b.w, rh, mixHex(b.body, "#8a90c8", 0.12), 0.3);
    }
    p.r(moonX - Math.round(moonR * 0.4), base + 1, Math.max(1, Math.round(moonR * 0.8)), waterH - 1, MOON_CORE, 0.14);
    // brilhos horizontais na água (tt-water: tremulam de leve na cidade grande)
    p.raw(`<g class="tt-water">`);
    const shimmers = Math.max(2, Math.round(waterH / 9)); // menos linhas -> água mais limpa
    for (let sh = 0; sh < shimmers; sh++) {
      const sy = base + 2 + Math.round((sh + 0.5) * (waterH / (shimmers + 1)));
      p.r(0, sy, W, 1, mixHex(WATER_TOP, "#cfe0f0", 0.35), 0.1);
    }
    p.raw(`</g>`);
  }

  // ---- MARCO: FAROL (direita) — listrado vermelho/branco, com feixe ----
  if (has("lighthouse")) {
    drawLighthouse(p, o, winH);
  }

  // ---- MARCO: BALSA cruzando a água ----
  if (has("ferry")) {
    const fw = Math.max(10, Math.round(base * 0.2));
    const fx = Math.round(W * 0.34);
    const fy = base + Math.max(3, Math.round(waterH * 0.42));
    p.raw(`<g class="tt-ferry">`);
    p.r(fx, fy, fw, Math.max(2, Math.round(fw * 0.2)), "#2e2440");
    p.r(fx + fw * 0.15, fy - Math.round(fw * 0.2), fw * 0.7, Math.round(fw * 0.2), "#3e3452");
    p.r(fx + fw * 0.4, fy - Math.round(fw * 0.45), Math.max(1, Math.round(fw * 0.08)), Math.round(fw * 0.28), "#556");
    p.r(fx + fw - 2, fy + 1, 1, 1, "#ff8a6a");
    p.r(fx, fy + 1, 1, 1, "#8affa0");
    p.raw(`</g>`);
  }

  // ---- MARCO: FESTIVAL de lanternas (fio de luzes na orla) ----
  if (has("festival")) {
    p.raw(`<g class="tt-festival">`);
    const ly = base + Math.max(2, Math.round(waterH * 0.12));
    p.r(0, ly - 1, W, 1, mixHex("#6a5a55", "#2a2230", 0.4), 0.5); // fio
    const cols = ["#f2b47a", "#e08aa0", "#7fc7bf", "#ffd79a"];
    const stepL = Math.max(8, Math.round(base * 0.18));
    let li = 0;
    for (let lx2 = stepL; lx2 < W; lx2 += stepL) {
      p.r(lx2, ly + (li % 2 ? 1 : 0), 2, 3, cols[li % cols.length]);
      li++;
    }
    p.raw(`</g>`);
  }

  // ---- POSTES na orla ----
  for (let l = 0; l < o.lamps; l++) {
    const lx = Math.round(base * 0.16 + (l + 0.5) * ((W - base * 0.2) / o.lamps));
    const ph = Math.max(5, Math.round(base * 0.12));
    p.r(lx, base - ph, 1, ph, mixHex("#5a4a55", "#2a2230", 0.4));
    p.r(lx - 1, base - ph - 2, 3, 3, LAMP_ON);
    p.r(lx - 2, base - ph - 3, 5, 5, LAMP_ON, 0.28);
  }

  // ---- MARCOS DESCONHECIDOS (vocabulário aberto): flâmula genérica tt-marco-<slug> ----
  let umk = 0;
  for (const m of city.marcos) {
    if (KNOWN_MARCOS.has(m)) continue;
    p.raw(`<g class="tt-marco-${m}">`);
    const mx = Math.round(W * 0.12 + umk * base * 0.14);
    const mh = Math.max(6, Math.round(base * 0.16));
    p.r(mx, base - mh, 1, mh, mixHex("#5a4a55", "#2a2230", 0.4)); // mastro
    p.r(mx + 1, base - mh, Math.max(3, Math.round(base * 0.06)), Math.max(2, Math.round(base * 0.04)), FLOWERS[umk % FLOWERS.length]); // flâmula
    p.raw(`</g>`);
    umk++;
  }

  return p;
}

// ---------------------------------------------------------------------------
// SERIALIZAÇÃO -> string <svg>
// ---------------------------------------------------------------------------
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serialize(p: Painter, W: number, H: number, label: string, klass: string): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" ` +
      `shape-rendering="crispEdges" class="${klass}" role="img" aria-label="${escapeAttr(label)}" ` +
      `style="width:100%;height:auto;display:block">`
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${WATER_DEEP}"/>`);
  for (const op of p.ops) {
    if ("raw" in op) {
      parts.push(op.raw);
      continue;
    }
    const opac = op.op != null && op.op < 1 ? ` opacity="${op.op}"` : "";
    const cls = op.cls ? ` class="${op.cls}"` : "";
    parts.push(`<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" fill="${op.fill}"${opac}${cls}/>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
export function citySvg(input: CityInput, variant: CityVariant = "mini", finale = false): string {
  const label = `city of ${input.username}`;
  const full = variant === "full";
  // grande (640x144) no /u; mini (200x48) em cada linha do ranking.
  const opts: SceneOpts = full
    ? { W: 640, H: 144, base: 108, stars: 40, reflection: true, lamps: 5, dither: 80 }
    : { W: 200, H: 48, base: 38, stars: 10, reflection: true, lamps: 2, dither: 0 };
  const kind = full ? "tt-city-full" : "tt-city-mini";
  // COM city -> desenha a cidade REAL da pessoa; SEM city -> fallback pela seed
  // do username (usuário antigo).
  const scene = input.city
    ? buildRealScene(input.city, opts, full, finale, input.accent)
    : buildScene(input, opts, full, finale);
  const origin = input.city ? "tt-city-real" : "tt-city-seeded";
  const fin = finale ? " tt-finale" : "";
  return serialize(scene, opts.W, opts.H, label, `tt-city ${kind} ${origin}${fin}`);
}
