// ---------------------------------------------------------------------------
// SETUP — "teu setup vira cidade". Payload OPT-IN, só NOMES e CONTAGENS da
// configuração (skills / MCP / hooks / ferramentas / modelos). NUNCA prompt,
// código, conteúdo de conversa ou caminho de projeto.
//
// PURO (sem I/O): sanitização DURA usada pela API/store (na escrita) e
// revalidada na leitura, coberta pelos testes de lib. Espelha o rigor do
// `city`/`profile`. Regras:
//   - v === 1 obrigatório (senão o setup é ignorado -> PRESERVA o guardado);
//   - skills <= 40 / mcp <= 20 / hooks <= 12 slugs [a-z0-9-]{1,32} — acentos e
//     markup viram slug ("<script>" -> "script", "coração" -> "coracao"),
//     duplicatas removidas;
//   - tools: top 10 pares [slug, int >= 0] (ordem por contagem desc);
//   - models: top 6 pares [slug, fração 0..1] NORMALIZADOS (somam ~1);
//   - JSON do setup sanitizado <= 3KB, senão DESCARTA o setup (o report segue
//     sem ele -> preserva o guardado).
//
// SEMÂNTICA tri-estado de sanitizeSetup(raw) (igual ao profile, no nível do
// objeto inteiro):
//   - Setup      -> SET  (veio um setup válido);
//   - null       -> CLEAR (o report mandou `setup: null` explícito -> apaga);
//   - undefined  -> PRESERVE (ausente OU inválido/grande demais -> mantém o
//                   guardado). O store trata undefined como "não mexe".
// ---------------------------------------------------------------------------

// STORED/CLEAN setup shape (o que vive no Redis e vira cidade/painel).
export interface Setup {
  v: 1;
  skills: string[];
  mcp: string[];
  hooks: string[];
  tools: [string, number][]; // [slug, contagem >= 0], desc por contagem
  models: [string, number][]; // [slug, fração 0..1], normalizados
}

// Tetos de sanidade do setup.
export const SETUP_CAPS = {
  skills: 40,
  mcp: 20,
  hooks: 12,
  tools: 10,
  models: 6,
  slugLen: 32,
  toolCount: 1_000_000_000, // teto de contagem por ferramenta (evita Infinity/absurdo)
  jsonBytes: 3072, // 3KB — setup serializado acima disso é descartado
};

// ---------------------------------------------------------------------------
// UTILIDADES puras
// ---------------------------------------------------------------------------
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Slug seguro [a-z0-9-]{1,32}: tira diacríticos (acentos), baixa a caixa e
// troca QUALQUER run de não-alfanumérico por um hífen ("copy mel" -> "copy-mel",
// "<script>" -> "script"), apara hífens das pontas e corta em 32. null se vazio.
function slugName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos (coração -> coracao)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // qualquer não-alfanumérico -> hífen
    .replace(/^-+|-+$/g, "") // apara hífens das pontas
    .slice(0, SETUP_CAPS.slugLen)
    .replace(/-+$/g, ""); // apara hífen que sobrou no corte
  return s.length ? s : null;
}

function nnInt(n: unknown, cap: number): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.floor(v), cap);
}

// Lista de slugs (skills/mcp/hooks): slug seguro, sem duplicata, capada.
function slugList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= cap) break;
    const slug = slugName(item);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

// Um par de entrada [name, value] — tolera array ou objeto {0,1}.
function pairOf(item: unknown): [unknown, unknown] | null {
  if (Array.isArray(item)) return item.length >= 2 ? [item[0], item[1]] : null;
  return null;
}

// tools: [name, count] -> [slug, int>=0]; colisão de slug SOMA; top 10 por
// contagem (desc, desempate slug asc).
function sanitizeTools(raw: unknown): [string, number][] {
  if (!Array.isArray(raw)) return [];
  const map = new Map<string, number>();
  for (const item of raw) {
    const pair = pairOf(item);
    if (!pair) continue;
    const slug = slugName(pair[0]);
    if (!slug) continue;
    const count = nnInt(pair[1], SETUP_CAPS.toolCount);
    if (count === null) continue; // negativo/NaN/Infinity -> descarta o par
    map.set(slug, Math.min((map.get(slug) ?? 0) + count, SETUP_CAPS.toolCount));
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SETUP_CAPS.tools);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// models: [name, frac] -> [slug, frac 0..1]; colisão SOMA; top 6 por fração
// (desc, desempate slug asc); NORMALIZA os 6 pra somarem ~1 (arredonda em 4).
function sanitizeModels(raw: unknown): [string, number][] {
  if (!Array.isArray(raw)) return [];
  const map = new Map<string, number>();
  for (const item of raw) {
    const pair = pairOf(item);
    if (!pair) continue;
    const slug = slugName(pair[0]);
    if (!slug) continue;
    const f = typeof pair[1] === "number" ? pair[1] : Number(pair[1]);
    if (!Number.isFinite(f)) continue;
    const frac = clamp01(f);
    if (frac <= 0) continue; // fração nula não vira fatia do donut
    map.set(slug, Math.min(1, (map.get(slug) ?? 0) + frac));
  }
  const top = [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SETUP_CAPS.models);
  const sum = top.reduce((acc, [, f]) => acc + f, 0);
  if (sum <= 0) return [];
  return top.map(([slug, f]) => [slug, round4(f / sum)] as [string, number]);
}

// ---------------------------------------------------------------------------
// SANITIZAÇÃO PÚBLICA — tri-estado (Setup | null | undefined). Ver o cabeçalho.
// ---------------------------------------------------------------------------
export function sanitizeSetup(raw: unknown): Setup | null | undefined {
  if (raw === null) return null; // CLEAR explícito (apaga o guardado)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined; // PRESERVE
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined; // versão obrigatória -> PRESERVE

  const setup: Setup = {
    v: 1,
    skills: slugList(r.skills, SETUP_CAPS.skills),
    mcp: slugList(r.mcp, SETUP_CAPS.mcp),
    hooks: slugList(r.hooks, SETUP_CAPS.hooks),
    tools: sanitizeTools(r.tools),
    models: sanitizeModels(r.models),
  };

  // backstop de tamanho: setup serializado acima de 3KB -> descarta (preserva).
  let json: string;
  try {
    json = JSON.stringify(setup);
  } catch {
    return undefined;
  }
  if (byteLen(json) > SETUP_CAPS.jsonBytes) return undefined;
  return setup;
}
