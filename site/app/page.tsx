import { getLeaderboard, type WindowKind } from "@/lib/store";
import { currentSeasonId, daysRemaining, seasonRange, projectAnnualCost, isFinale } from "@/lib/season";
import { formatCount, formatCost, formatAgo, formatAnnualCost, formatDate } from "@/lib/format";
import { citySvg } from "@/lib/city";
import { accentHex } from "@/lib/profile";
import LiveBoard from "./LiveBoard";
import ProfileSearch from "./ProfileSearch";

export const dynamic = "force-dynamic";

// A deterministic mockup skyline for the hero — evokes the corner overlay
// (built from a seed, not a real user). Rendered once per request.
const HERO_CITY = citySvg(
  { username: "tokentown", tokens: 2_400_000, residents: 44, buildings: 1280 },
  "full"
);

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; window?: string }>;
}) {
  const sp = await searchParams;
  const cur = currentSeasonId();
  const parsed = sp?.season != null ? parseInt(sp.season, 10) : cur;
  const season = Number.isInteger(parsed) && parsed >= 0 && parsed <= cur ? parsed : cur;
  const isCurrent = season === cur;

  // ranking window: default is the season. "7d" = gain over the last 7 days.
  const window: WindowKind = sp?.window === "7d" ? "7d" : "season";

  const now = Date.now();
  // we always fetch the season ranking (for the headline); only refetch for 7d.
  const seasonRanking = await getLeaderboard(season, { window: "season", limit: 100 });
  const ranking =
    window === "7d" ? await getLeaderboard(season, { window: "7d", limit: 100 }) : seasonRanking;
  const range = seasonRange(season);
  const days = daysRemaining(now);
  // FINALE: last night of the CURRENT season -> fireworks over every city + banner.
  const finale = isCurrent && isFinale(now);

  // 💸 HEADLINE — annualized projection of the summed cost of the season's TOP N.
  // (>= 2 users; hidden otherwise.) Always by SEASON, never by the window.
  let headline: { topN: number; label: string } | null = null;
  if (seasonRanking.length >= 2) {
    const topN = Math.min(5, seasonRanking.length);
    const sumCost = seasonRanking.slice(0, topN).reduce((a, r) => a + (r.seasonCost || 0), 0);
    const annual = projectAnnualCost(sumCost, season, now);
    if (annual > 0) headline = { topN, label: formatAnnualCost(annual) };
  }

  // window-toggle hrefs (preserve the season when it isn't the current one).
  const winHref = (w: WindowKind) => {
    const p = new URLSearchParams();
    if (season !== cur) p.set("season", String(season));
    if (w === "7d") p.set("window", "7d");
    const q = p.toString();
    return q ? `/?${q}` : "/";
  };

  // seasons for the picker (newest first), at most 12 chips.
  const seasonIds: number[] = [];
  for (let s = cur; s >= 0 && seasonIds.length < 12; s--) seasonIds.push(s);

  return (
    <main className="wrap">
      <header className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Token city · community leaderboard</div>
          <h1>
            <span className="mark">◍</span> TOKENTOWN <span className="sub">— leaderboard</span>
          </h1>
          <p className="lede">
            Every token your AI burns raises a building — here&apos;s who built the biggest city this
            season. <a href="#why">How it works &rsaquo;</a>
          </p>
          {headline && (
            <p className="burn" aria-label="Estimated annualized cost of the season's biggest cities">
              the top {headline.topN} devs here burn <span className="burn-val">≈ {headline.label}/yr</span>{" "}
              <span className="burn-emoji" aria-hidden="true">💸</span> in AI tokens
              <span className="burn-sub"> · self-reported season projection</span>
            </p>
          )}
        </div>
        <aside className="hero-mock" aria-hidden="true">
          <div className="mock-win">
            <div className="mock-bar">
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-title">◍ your city</span>
            </div>
            <div className="mock-city" dangerouslySetInnerHTML={{ __html: HERO_CITY }} />
            <div className="mock-cap">grows in the corner while you code</div>
          </div>
        </aside>
      </header>

      <section className="season-bar">
        <div className="season-now">
          <span className="label">You&apos;re viewing</span>
          <span className="value">
            Season <b>{season}</b>
            {isCurrent ? " (current)" : ""}
          </span>
          <span className="range">
            {formatDate(range.start)} — {formatDate(range.end)} · 28 days (UTC)
          </span>
        </div>
        {isCurrent ? (
          <div className="days">
            <div className="n">{days}</div>
            <div className="u">{days === 1 ? "day left" : "days left"}</div>
          </div>
        ) : (
          <div className="days closed">
            <div className="n">season closed</div>
            <div className="u">leaderboard frozen</div>
          </div>
        )}
      </section>

      <nav className="seasons" aria-label="Choose a season">
        <span className="cap">Seasons</span>
        {seasonIds.map((s) => {
          const p = new URLSearchParams();
          if (s !== cur) p.set("season", String(s));
          if (window === "7d") p.set("window", "7d");
          const q = p.toString();
          const past = s !== cur;
          return (
            <a
              key={s}
              href={q ? `/?${q}` : "/"}
              className={`chip${s === season ? " active" : ""}${
                s === season && past ? " past" : ""
              }${past ? " album" : ""}`}
              title={past ? `view the season ${s} album` : undefined}
            >
              T{s}
              {s === cur ? (
                <span className="chip-tag"> · current</span>
              ) : (
                <span className="chip-tag"> · album</span>
              )}
            </a>
          );
        })}
      </nav>

      <div className="window-row">
        <div className="window-tabs" role="tablist" aria-label="Ranking window">
          <a
            href={winHref("season")}
            role="tab"
            aria-selected={window === "season"}
            className={`wtab${window === "season" ? " on" : ""}`}
          >
            season · 28d
          </a>
          <a
            href={winHref("7d")}
            role="tab"
            aria-selected={window === "7d"}
            className={`wtab${window === "7d" ? " on" : ""}`}
          >
            7 days
          </a>
        </div>
        <span className="window-hint">
          {window === "7d" ? "tokens & cost over the last 7 days" : "season running total"}
        </span>
        <ProfileSearch />
        {isCurrent && <LiveBoard renderedAt={now} />}
      </div>

      <section className="board" id="board">
        {finale && (
          <div className="finale-banner board-banner" role="status">
            <span className="fb-spark" aria-hidden="true">🎆</span> last night of season {season}
          </div>
        )}
        {!isCurrent && (
          <div className="album-banner board-banner" role="status">
            <span className="ab-cap">album</span> season closed · final podium
          </div>
        )}
        {ranking.length === 0 ? (
          <div className="empty">
            <b>Nobody on the board yet</b> this season.
            <br />
            Be the first to build — see how to get your city below.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="l">#</th>
                  <th className="l">Dev</th>
                  <th className="l">City</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Residents</th>
                  <th>Buildings</th>
                  <th>Last report</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => {
                  const href = isCurrent
                    ? `/u/${r.username}`
                    : `/u/${r.username}?season=${season}`;
                  const champion = !isCurrent && r.position === 1;
                  const rowClass =
                    `${r.position <= 3 ? `top${r.position}` : ""}${champion ? " champ" : ""}`.trim() ||
                    undefined;
                  const accent = r.profile?.accent ? accentHex(r.profile.accent) : undefined;
                  return (
                    <tr key={r.username} className={rowClass}>
                      <td className="pos">{r.position}</td>
                      <td className="user">
                        {champion && (
                          <span className="crown" title="Season champion" aria-hidden="true">
                            ♛
                          </span>
                        )}
                        <a href={href} className="userlink">
                          {r.username}
                        </a>
                        {r.profile?.cityName && (
                          <span className="rank-cityname">{r.profile.cityName}</span>
                        )}
                      </td>
                      <td className="city">
                        <a
                          href={href}
                          className="city-link"
                          aria-label={`View ${r.username}'s city`}
                          dangerouslySetInnerHTML={{
                            __html: citySvg(
                              {
                                username: r.username,
                                tokens: r.seasonTokens,
                                residents: r.residents,
                                buildings: r.buildings,
                                city: r.city,
                                accent,
                              },
                              "mini",
                              finale
                            ),
                          }}
                        />
                      </td>
                      <td className="tokens">
                        {formatCount(r.tokens)}
                        {window === "7d" && r.sinceRegister && (
                          <span className="since" title="No 7-day history yet — showing the total since sign-up">
                            since sign-up
                          </span>
                        )}
                      </td>
                      <td className="cost">{formatCost(r.cost)}</td>
                      <td className="res">{formatCount(r.city ? r.city.pop : r.residents)}</td>
                      <td className="build">{formatCount(r.buildings)}</td>
                      <td className="ago">{formatAgo(r.lastReport, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* WHY THE APP — the pitch comes AFTER the board: it's not another tokenmaxxing counter. */}
      <section className="why" id="why">
        <h2 className="why-h">Why the app</h2>
        <div className="why-grid">
          <div className="why-card">
            <div className="why-n">01</div>
            <h3>Your city grows while you code</h3>
            <p>
              While you code, your city grows live in the corner of your screen — a little pixel
              town on the waterfront. Every token your AI agents burn becomes a building; you watch
              it rise in real time, no tab to check.
            </p>
          </div>
          <div className="why-card">
            <div className="why-n">02</div>
            <h3>Play on your rooftops while the agent works</h3>
            <p>
              While the agent is busy, you can play a tiny platformer across your own city&apos;s
              rooftops. The moment the agent finishes — or needs a decision from you — the game
              auto-pauses so you get straight back to work.
            </p>
          </div>
        </div>
        <ul className="why-more">
          <li>
            <b>28-day seasons.</b> Everyone&apos;s city resets on the same global clock — then you
            build again.
          </li>
          <li>
            <b>Real-time day &amp; night + weather.</b> The sky follows your local hour; windows
            light up at dusk, it rains, it snows.
          </li>
          <li>
            <b>Local-first.</b> It reads your usage on your machine. Only your username and the
            numbers are ever reported — never prompts, code or project names.
          </li>
        </ul>

        {/* EMBEDDED DEMO — the overlay, running simulated, right on the page. Opens
            straight into the rooftops platformer in auto-play (attract mode). */}
        <div className="demo-card">
          <div className="demo-head">
            <span className="demo-cap">play the rooftops — right here</span>
            <span className="demo-badge">simulated demo — the real app reads your actual usage</span>
          </div>
          <div className="demo-frame">
            <iframe
              src="/demo/index.html"
              title="TOKENTOWN overlay — rooftops platformer, simulated demo"
              width={340}
              height={380}
              loading="lazy"
            />
          </div>
        </div>
      </section>

      {/* GET YOUR CITY — three ways in. */}
      <section className="get" id="get">
        <h2>Get your city</h2>
        <div className="tiers">
          <div className="tier">
            <div className="tier-top">
              <span className="tier-name">npx tokentown</span>
              <span className="tier-badge soon">coming soon</span>
            </div>
            <p>
              10-second setup, no install. One command drops the overlay onto your desktop and points
              it at this leaderboard.
            </p>
            <code className="tier-cmd">npx tokentown</code>
          </div>

          <div className="tier">
            <div className="tier-top">
              <span className="tier-name">Desktop overlay app</span>
              <span className="tier-badge">macOS</span>
            </div>
            <p>
              The floating window that lives in the corner while you code. The game itself is tiny; a
              lighter native shell is coming.
            </p>
            <a className="tier-link" href="#">
              Download &rsaquo;
            </a>
          </div>

          <div className="tier">
            <div className="tier-top">
              <span className="tier-name">Just watch</span>
              <span className="tier-badge ghost">nothing to install</span>
            </div>
            <p>
              Not ready to build? Browse the cities other devs are growing this season and come back
              when you want your own.
            </p>
            <a className="tier-link" href="#board">
              Browse cities &rsaquo;
            </a>
          </div>
        </div>

        <p className="honor">
          <b>Honor system.</b> The numbers are self-reported by each person&apos;s app — like any
          community leaderboard, there&apos;s no central check that they&apos;re real. The board only
          stores your <b>username and the numbers</b> (tokens, estimated cost, residents, buildings).
          It never receives your content, prompts or code.
        </p>
      </section>

      <p className="foot">
        TOKENTOWN — leaderboard · season {cur} in progress · data at{" "}
        <code>
          /api/placar?season={season}
          {window === "7d" ? "&window=7d" : ""}
        </code>
      </p>
    </main>
  );
}
