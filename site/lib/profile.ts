// ---------------------------------------------------------------------------
// LIGHT PROFILE personalization — city name, motto and accent color.
//
// PURE (no I/O): HARD sanitization used by the API/store (on write) and
// re-validated on read, plus covered by tests. Rules:
//   - cityName: <= 24 chars; only letters (unicode, accents included), numbers,
//               space, hyphen and apostrophe. Anything else (markup, <, >, ",
//               etc.) becomes a space -> markup NEVER passes through.
//   - motto:    same, <= 48 chars.
//   - accent:   ONLY one of the 6 fixed slugs below; off-list -> ignored.
//
// CLEAR semantics (sanitizeProfile returns a PATCH): for cityName/motto, an
// explicit empty string "" is a CLEAR signal (marked as null in the patch),
// telling the store to DELETE the stored value. An ABSENT or INVALID field
// (non-string, or content that strips to empty like "<<<>>>") is left out of
// the patch entirely -> the store PRESERVES whatever was already there. Only a
// literal "" clears. accent has no clear (absent -> preserve, default is gold).
//
// The accent color maps to a hex from the existing palette (globals.css/city.ts)
// and tints page details + a light warm tint on the city windows.
// ---------------------------------------------------------------------------

export type AccentSlug = "dourado" | "teal" | "rosa" | "violeta" | "verde" | "ambar";

export const DEFAULT_ACCENT: AccentSlug = "dourado";

// Slugs -> hex (tirados da paleta do site: --gold/--teal/--amber e as FLOWERS
// do gerador de cidade). Tons calmos, coerentes com a cena noturna — sem neon.
export const ACCENTS: Record<AccentSlug, string> = {
  dourado: "#ffd79a", // --gold (default)
  teal: "#7fc7bf", // --teal
  rosa: "#e08aa0", // FLOWERS rosa
  violeta: "#c98ac4", // FLOWERS violeta
  verde: "#7fc79a", // verde-sálvia (família teal/grama, clareado)
  ambar: "#f2b47a", // --amber
};

export function isAccent(s: unknown): s is AccentSlug {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(ACCENTS, s);
}

// hex da cor de destaque (default dourado quando ausente/inválida).
export function accentHex(slug: string | null | undefined): string {
  return isAccent(slug) ? ACCENTS[slug] : ACCENTS[DEFAULT_ACCENT];
}

// STORED/CLEAN profile shape (what lives in Redis and gets rendered).
export interface Profile {
  cityName?: string;
  motto?: string;
  accent?: AccentSlug;
}

// A PATCH parsed from a raw report: for cityName/motto a string = SET, null =
// CLEAR, and an absent key = PRESERVE. accent is set-only (absent = preserve).
export interface ProfilePatch {
  cityName?: string | null;
  motto?: string | null;
  accent?: AccentSlug;
}

export const PROFILE_CAPS = { cityName: 24, motto: 48 };

// allowlist de texto: letras (\p{L}) + marcas de acento (\p{M}, pra "São") +
// números (\p{N}) + espaço + hífen + apóstrofo (reto e tipográfico). Tudo fora
// disso vira espaço — impossível injetar markup a partir daqui.
const TEXT_STRIP = /[^\p{L}\p{M}\p{N} '’-]+/gu;

function cleanText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .normalize("NFC")
    .replace(TEXT_STRIP, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned.length ? cleaned : undefined;
}

// Sanitiza um campo de texto DENTRO de um patch:
//   - raw === "" (string vazia EXPLÍCITA) -> null  (CLEAR: apaga o guardado)
//   - texto válido depois de limpo         -> string (SET)
//   - ausente / não-string / só-markup     -> não entra no patch (PRESERVE)
function applyText(out: ProfilePatch, key: "cityName" | "motto", raw: unknown, max: number): void {
  if (raw === "") {
    out[key] = null; // limpeza explícita
    return;
  }
  const cleaned = cleanText(raw, max);
  if (cleaned) out[key] = cleaned; // senão deixa de fora -> preserva
}

// Sanitiza o profile bruto -> PATCH (SET/CLEAR/PRESERVE por campo), ou null se
// nada relevante veio (o store trata null como "sem mudança" e preserva tudo).
export function sanitizeProfile(raw: unknown): ProfilePatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ProfilePatch = {};
  applyText(out, "cityName", r.cityName, PROFILE_CAPS.cityName);
  applyText(out, "motto", r.motto, PROFILE_CAPS.motto);
  if (isAccent(r.accent)) out.accent = r.accent;
  return Object.keys(out).length ? out : null;
}

// Aplica um patch sobre o profile guardado -> novo profile limpo (ou null se
// ficou vazio). null de patch preserva o prev. Campo com null no patch é apagado;
// campo ausente é preservado; string sobrescreve. Usado na ESCRITA (merge com o
// que já existe) e na LEITURA (mergeProfile(null, patch) = "limpa o patch").
export function mergeProfile(
  prev: Profile | null | undefined,
  patch: ProfilePatch | null
): Profile | null {
  if (!patch) return prev ?? null;
  const out: Profile = { ...(prev ?? {}) };
  for (const key of ["cityName", "motto"] as const) {
    if (key in patch) {
      const v = patch[key];
      if (v == null) delete out[key]; // CLEAR
      else out[key] = v; // SET
    }
  }
  if (patch.accent !== undefined) out.accent = patch.accent;
  return Object.keys(out).length ? out : null;
}

// Big title for /u and the og:image: cityName when present, else "city of X".
export function cityTitle(profile: Profile | null | undefined, username: string): string {
  return profile?.cityName || `city of ${username}`;
}
