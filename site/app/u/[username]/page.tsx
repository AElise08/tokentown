import type { Metadata } from "next";
import { getUserWithRank } from "@/lib/store";
import { currentSeasonId, seasonRange, daysRemaining, isFinale } from "@/lib/season";
import { formatCount, formatCost, formatAgo, formatDate } from "@/lib/format";
import { citySvg, cityFeatures, cityComposition, cityMarcoLabels } from "@/lib/city";
import { cityTitle, accentHex } from "@/lib/profile";
import { setupView, weekHeatmap, pct } from "@/lib/setup-view";
import { getUserSnaps } from "@/lib/snaps";
import LiveRefresh from "./LiveRefresh";

// donut geometry — ring circumference for the model-mix (stroke-dasharray).
const DONUT_R = 34;
const DONUT_C = 2 * Math.PI * DONUT_R;

export const dynamic = "force-dynamic";

function resolveSeason(raw: string | undefined): number {
  const cur = currentSeasonId();
  const parsed = raw != null ? parseInt(raw, 10) : cur;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= cur ? parsed : cur;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const u = decodeURIComponent(username).toLowerCase();
  // uses the profile's city name / motto in the card title and description.
  // (the og/twitter images come from the opengraph-image / twitter-image routes.)
  const entry = await getUserWithRank(currentSeasonId(), u);
  const title = cityTitle(entry?.profile ?? null, u);
  const motto = entry?.profile?.motto;
  const pageTitle = `${title} · TOKENTOWN leaderboard`;
  const description = motto
    ? `“${motto}” — ${u}'s city on the TOKENTOWN leaderboard.`
    : `${u}'s city on the TOKENTOWN leaderboard: tokens, residents and buildings this season.`;
  return {
    title: pageTitle,
    description,
    openGraph: { title: pageTitle, description, type: "profile" },
    twitter: { card: "summary_large_image", title: pageTitle, description },
  };
}

export default async function UserPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { username } = await params;
  const sp = await searchParams;
  const u = decodeURIComponent(username).toLowerCase();
  const cur = currentSeasonId();
  const season = resolveSeason(sp?.season);
  const isCurrent = season === cur;
  const backHref = isCurrent ? "/" : `/?season=${season}`;

  const entry = await getUserWithRank(season, u);
  const range = seasonRange(season);

  if (!entry) {
    return (
      <main className="wrap uwrap">
        <a href={backHref} className="back">
          &lsaquo; back to the leaderboard
        </a>
        <section className="ucard empty-city">
          <div className="uhandle">◍ {u}</div>
          <p className="lede">
            No city for <b>{u}</b> in season {season} yet. Either the name is different, or this
            person hasn&apos;t reported this season.
          </p>
          <a href={backHref} className="cta">
            See who&apos;s on the board &rsaquo;
          </a>
        </section>
      </main>
    );
  }

  const now = Date.now();
  const days = daysRemaining(now);
  // FINALE: only on the CURRENT season and the last night -> the city sets off fireworks.
  const finale = isCurrent && isFinale(now);
  // ALBUM: past season -> frozen-podium treatment; champion is crowned.
  const isAlbum = !isCurrent;
  const isChampion = entry.position === 1;

  // SETUP → CITY: how this city was built (skills/MCP/tools/models), plus the
  // weekly "city lights" heatmap from the daily snapshots. Both degrade to
  // nothing/quiet when there's no data.
  const sv = setupView(entry.setup);
  const heat = weekHeatmap(await getUserSnaps(season, u), now);
  const heatActive = heat.some((c) => c.gain > 0);

  // PERSONALIZATION: title (cityName or "city of u"), motto and accent color.
  // The accent only kicks in when the person chose one (otherwise the default look).
  const profile = entry.profile ?? null;
  const title = cityTitle(profile, u);
  const motto = profile?.motto;
  const accentSlug = profile?.accent;
  const accent = accentSlug ? accentHex(accentSlug) : undefined;

  const svg = citySvg(
    { username: u, tokens: entry.tokens, residents: entry.residents, buildings: entry.buildings, city: entry.city, accent },
    "full",
    finale
  );

  // residents/composition: from the REAL city when present, else from the fallback.
  const pop = entry.city ? entry.city.pop : entry.residents;
  const composition = entry.city ? cityComposition(entry.city) : [];

  // landmarks: from the real city (app vocabulary) or derived from the numbers (fallback).
  let marcos: string[];
  if (entry.city) {
    marcos = cityMarcoLabels(entry.city);
  } else {
    const feats = cityFeatures(entry);
    marcos = [];
    if (feats.garden) marcos.push("waterfront garden");
    if (feats.ferry) marcos.push("ferry across the water");
    if (feats.lighthouse) marcos.push("lighthouse with a beam");
    if (feats.towers) marcos.push("tower district");
  }

  return (
    <main
      className="wrap uwrap"
      style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}
    >
      <a href={backHref} className="back">
        &lsaquo; back to the leaderboard
      </a>

      {finale && (
        <div className="finale-banner" role="status">
          <span className="fb-spark" aria-hidden="true">🎆</span> last night of season {season}
        </div>
      )}
      {isAlbum && (
        <div className="album-banner" role="status">
          <span className="ab-cap">album</span> season closed · final podium
        </div>
      )}

      <header className="uhead">
        <div className="eyebrow">
          <span className="mark">◍</span> {u} · profile
        </div>
        <h1 className={`uh1${isAlbum && isChampion ? " champ" : ""}`}>
          {isAlbum && isChampion && (
            <span className="crown" title="Season champion" aria-label="season champion">
              ♛
            </span>
          )}
          {title}
        </h1>
        {motto && <p className="umotto">“{motto}”</p>}
        <p className="usub">
          {entry.position === 1 ? (
            <b className="p1">at the top of the board</b>
          ) : (
            <>
              <b>#{entry.position}</b> on the board
            </>
          )}{" "}
          in season {season}
          {isCurrent ? " (current)" : " (closed)"} · {formatDate(range.start)}—{formatDate(range.end)}
        </p>
      </header>

      <div
        className="citybig"
        role="img"
        aria-label={`city of ${u}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      {marcos.length > 0 && (
        <div className="marcos">
          {marcos.map((m) => (
            <span key={m} className="marco">
              ⟡ {m}
            </span>
          ))}
        </div>
      )}

      {composition.length > 0 && (
        <div className="composition">
          <span className="comp-cap">What&apos;s built</span>
          {composition.map((cmp) => (
            <span key={cmp.slug} className="chip-comp">
              {cmp.label}
              <b>{formatCount(cmp.count)}</b>
            </span>
          ))}
        </div>
      )}

      {/* CITY LIGHTS — 7 nights this week; brighter = more tokens burned that day */}
      <div className="heatmap">
        <div className="heat-top">
          <span className="heat-cap">City lights · this week</span>
          <span className="heat-hint">
            {heatActive ? "more tokens that day → brighter" : "quiet week so far"}
          </span>
        </div>
        <div className="heat-cells" role="img" aria-label="tokens burned per day this week">
          {heat.map((c) => (
            <span
              key={c.dayKey}
              className={`heat-cell${c.today ? " today" : ""}`}
              style={{ ["--lit" as string]: c.intensity } as React.CSSProperties}
              title={`${c.label} — ${formatCount(c.gain)} tokens`}
            >
              <span className="heat-win" aria-hidden="true" />
              <span className="heat-day">{c.label}</span>
            </span>
          ))}
        </div>
      </div>

      <section className="ustats">
        <div className="stat big tokens">
          <div className="k">Season tokens</div>
          <div className="v">{formatCount(entry.tokens)}</div>
        </div>
        <div className="stat">
          <div className="k">Rank</div>
          <div className="v">#{entry.position}</div>
        </div>
        <div className="stat">
          <div className="k">Est. cost</div>
          <div className="v cost">{formatCost(entry.cost)}</div>
        </div>
        <div className="stat">
          <div className="k">Residents</div>
          <div className="v teal">{formatCount(pop)}</div>
        </div>
        <div className="stat">
          <div className="k">Buildings</div>
          <div className="v teal">{formatCount(entry.buildings)}</div>
        </div>
        <div className="stat">
          <div className="k">Season</div>
          <div className="v">T{season}</div>
        </div>
        <div className="stat">
          <div className="k">Last report</div>
          <div className="v faint">{formatAgo(entry.lastReport, now)}</div>
        </div>
      </section>

      {sv && (
        <section className="built" aria-label="How this city was built">
          <div className="built-head">
            <h2 className="built-h">How this city was built</h2>
            <span
              className="built-shared"
              title="Only names & counts are ever shared — never prompts, code or project names."
            >
              <span className="info-i" aria-hidden="true">ⓘ</span> what&apos;s shared: {sv.summary.text}
            </span>
          </div>

          {(sv.skills.length > 0 || sv.mcp.length > 0 || sv.hooks.length > 0) && (
            <div className="built-chips">
              {sv.skills.length > 0 && (
                <div className="chip-group">
                  <span className="chip-group-cap">Skills · landmark buildings</span>
                  <div className="chip-row">
                    {sv.skills.map((s) => (
                      <span key={s} className="setup-chip skill">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {sv.mcp.length > 0 && (
                <div className="chip-group">
                  <span className="chip-group-cap">MCP · dockside stations</span>
                  <div className="chip-row">
                    {sv.mcp.map((s) => (
                      <span key={s} className="setup-chip mcp">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {sv.hooks.length > 0 && (
                <div className="chip-group">
                  <span className="chip-group-cap">Hooks</span>
                  <div className="chip-row">
                    {sv.hooks.map((s) => (
                      <span key={s} className="setup-chip hook">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="built-grid">
            {sv.tools.length > 0 && (
              <div className="tools-card">
                <span className="mini-cap">Industries · tool mix</span>
                <ul className="tool-bars">
                  {sv.tools.map((t) => (
                    <li key={t.slug} className="tool-bar">
                      <span className="tool-name">{t.label}</span>
                      <span className="tool-track">
                        <span
                          className="tool-fill"
                          style={{ width: `${Math.max(3, Math.round(t.bar * 100))}%` }}
                        />
                      </span>
                      <span className="tool-pct">{pct(t.share)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sv.donut.length > 0 && (
              <div className="power-card">
                <span className="mini-cap">Power sources · models</span>
                <div className="donut-wrap">
                  <svg
                    className="donut"
                    width={88}
                    height={88}
                    viewBox="0 0 88 88"
                    role="img"
                    aria-label="model mix"
                  >
                    <circle cx={44} cy={44} r={DONUT_R} fill="none" stroke="#241b30" strokeWidth={12} />
                    <g transform="rotate(-90 44 44)">
                      {sv.donut.map((d) => (
                        <circle
                          key={d.slug}
                          cx={44}
                          cy={44}
                          r={DONUT_R}
                          fill="none"
                          stroke={d.color}
                          strokeWidth={12}
                          strokeDasharray={`${d.frac * DONUT_C} ${DONUT_C}`}
                          strokeDashoffset={-d.start * DONUT_C}
                          strokeLinecap="butt"
                        />
                      ))}
                    </g>
                    <text x={44} y={49} textAnchor="middle" className="donut-mid">
                      {pct(sv.donut[0].frac)}
                    </text>
                  </svg>
                  <ul className="power-legend">
                    {sv.donut.map((d) => (
                      <li key={d.slug}>
                        <span className="power-dot" style={{ background: d.color }} aria-hidden="true" />
                        <span className="power-name">{d.label}</span>
                        <b>{pct(d.frac)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {isCurrent && (
        <p className="liverow">
          <LiveRefresh renderedAt={now} />
        </p>
      )}

      <p className="foot">
        {isCurrent ? (
          <>
            season {season} in progress · {days} {days === 1 ? "day left" : "days left"}
          </>
        ) : (
          <>season {season} closed · leaderboard frozen</>
        )}{" "}
        · <a href={backHref}>back to the leaderboard</a>
      </p>
    </main>
  );
}
