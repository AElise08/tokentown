// ---------------------------------------------------------------------------
// CARD DE COMPARTILHAMENTO (og:image / twitter card) da página /u/[username].
//
// Colar o link /u/mel no WhatsApp/X/Discord mostra A CIDADE da pessoa com stats.
// 1200x630, fundo #141019, paleta dourada, com a MESMA cidade renderizada pelo
// lib/city.ts (reaproveitada como SVG e embutida via <img data:image/svg+xml…>,
// que o satori/resvg do next/og rasteriza). Usa cityName/motto/accent do perfil.
//
// NOTA satori: a fonte embutida é só latina, então evitamos glifos fora dela
// (a marca ◍ vira um anel desenhado com <div>); e TODA <div> com mais de um
// filho precisa de display:flex explícito.
//
// Módulo compartilhado por opengraph-image.tsx e twitter-image.tsx (mesma arte).
// ---------------------------------------------------------------------------
import { ImageResponse } from "next/og";
import { getUserWithRank } from "@/lib/store";
import { currentSeasonId } from "@/lib/season";
import { citySvg } from "@/lib/city";
import { cityTitle, accentHex } from "@/lib/profile";
import { formatCount } from "@/lib/format";
import { topSkills, modelDonut } from "@/lib/setup-view";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const VOID = "#141019";
const GOLD = "#ffd79a";
const AMBER = "#f2b47a";
const MUTE = "#a99bb0";
const FAINT = "#6b5f76";
const TEAL = "#7fc7bf";

// marca ◍ TOKENTOWN desenhada (anel) — sem depender de glifo/fonte externa.
function brandMark(color: string, d = 26) {
  return (
    <div
      style={{
        display: "flex",
        width: d,
        height: d,
        borderRadius: d,
        border: `${Math.max(2, Math.round(d / 8))}px solid ${color}`,
      }}
    />
  );
}

function brandRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 26, letterSpacing: 4, color: AMBER }}>
      {brandMark(AMBER, 26)}
      <div style={{ display: "flex" }}>TOKENTOWN</div>
      <div style={{ display: "flex", color: FAINT, letterSpacing: 2 }}>· leaderboard</div>
    </div>
  );
}

function statBlock(label: string, value: string, color: string) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", fontSize: 20, letterSpacing: 2, color: FAINT }}>{label}</div>
      <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export async function renderOgImage(usernameRaw: string): Promise<ImageResponse> {
  const u = decodeURIComponent(usernameRaw).toLowerCase();
  const season = currentSeasonId();
  const entry = await getUserWithRank(season, u);

  // moldura/detalhes na cor de destaque (default dourado); tint das janelas só
  // quando a pessoa escolheu um accent (senão, cidade no dourado padrão).
  const accentSlug = entry?.profile?.accent;
  const accent = accentSlug ? accentHex(accentSlug) : GOLD;
  const cityAccent = accentSlug ? accent : undefined;

  // CIDADE NÃO ENCONTRADA -> ainda devolve uma imagem (nunca quebra o preview).
  if (!entry) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: VOID,
            padding: 64,
            justifyContent: "space-between",
          }}
        >
          {brandRow()}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", fontSize: 64, fontWeight: 800, color: GOLD }}>{`city of ${u}`}</div>
            <div style={{ display: "flex", fontSize: 30, color: MUTE }}>
              no city this season yet — build yours by burning tokens.
            </div>
          </div>
          <div style={{ display: "flex", fontSize: 24, color: FAINT }}>tokentown · community leaderboard</div>
        </div>
      ),
      { ...size }
    );
  }

  const title = cityTitle(entry.profile ?? null, u);
  const motto = entry.profile?.motto;
  const pop = entry.city ? entry.city.pop : entry.residents;

  // SETUP strip — top skills + the model "power sources" (names/counts only).
  const skills = topSkills(entry.setup, 3);
  const power = modelDonut(entry.setup);

  const svg = citySvg(
    { username: u, tokens: entry.tokens, residents: entry.residents, buildings: entry.buildings, city: entry.city, accent: cityAccent },
    "full"
  );
  const cityUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: VOID,
          padding: 56,
          justifyContent: "space-between",
        }}
      >
        {/* topo: marca + posição */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {brandRow()}
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, color: entry.position === 1 ? AMBER : MUTE }}>
            {entry.position === 1 ? "at the top of the board" : `#${entry.position} on the board`}
          </div>
        </div>

        {/* a cidade, emoldurada na cor de destaque */}
        <div
          style={{
            display: "flex",
            width: 1120,
            height: 252,
            borderRadius: 16,
            border: `2px solid ${accent}`,
            overflow: "hidden",
          }}
        >
          <img src={cityUri} width={1120} height={252} />
        </div>

        {/* título + lema */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 60, fontWeight: 800, color: GOLD }}>{title}</div>
            <div style={{ display: "flex", fontSize: 26, color: FAINT }}>{u}</div>
          </div>
          {motto ? (
            <div style={{ display: "flex", fontSize: 30, color: MUTE }}>{`"${motto}"`}</div>
          ) : (
            <div style={{ display: "flex" }} />
          )}
        </div>

        {/* stats + how it was built */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 40 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 56 }}>
            {statBlock("Season tokens", formatCount(entry.tokens), GOLD)}
            {statBlock("Residents", formatCount(pop), TEAL)}
            {statBlock("Buildings", formatCount(entry.buildings), TEAL)}
          </div>
          {(skills.length > 0 || power.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
              {skills.length > 0 && (
                <div style={{ display: "flex", gap: 8 }}>
                  {skills.map((s) => (
                    <div
                      key={s}
                      style={{
                        display: "flex",
                        fontSize: 20,
                        color: GOLD,
                        border: `1px solid ${accent}`,
                        borderRadius: 8,
                        padding: "4px 12px",
                      }}
                    >
                      {s}
                    </div>
                  ))}
                </div>
              )}
              {power.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", fontSize: 18, letterSpacing: 2, color: FAINT }}>
                    power
                  </div>
                  {power.map((d) => (
                    <div
                      key={d.slug}
                      style={{ display: "flex", width: 16, height: 16, borderRadius: 4, background: d.color }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    ),
    { ...size }
  );
}
