import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · NORTOWN",
  description: "What NORTOWN reads locally, what it reports, and what it never collects.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <a className="privacy-back" href="/">&lsaquo; back to NORTOWN</a>
      <p className="privacy-kicker">NORTOWN · PRIVACY</p>
      <h1>Local usage stays local.</h1>
      <p className="privacy-lede">
        NORTOWN turns AI coding usage into a public pixel city. Its reporter is open source and
        aggregates usage on your own computer before sending anything.
      </p>

      <section>
        <h2>What the reporter reads</h2>
        <p>
          Local usage metadata written by Claude Code, Codex and OpenCode: timestamps, token counters,
          model/provider identifiers and tool names. These sources remain on your computer.
        </p>
      </section>

      <section>
        <h2>What reaches the board</h2>
        <p>
          Your chosen username and aggregate season numbers: tokens, estimated usage value, residents,
          buildings and daily totals. If you opt in to sharing setup, the board also receives names and
          counts for models, tools, skills and MCP servers.
        </p>
      </section>

      <section>
        <h2>What is never sent</h2>
        <p>
          Prompts, responses, source code, conversation content, file contents, project names and local
          paths are never included in a report. Your reporter key is generated and stored locally.
        </p>
      </section>

      <section>
        <h2>Public data and infrastructure</h2>
        <p>
          Leaderboard profiles are public by design. The website is hosted on Vercel and board records
          are stored with Upstash Redis. NORTOWN counts aggregate visitors and pageviews without
          behavioral advertising cookies. It does not create browsing profiles or track individual
          sponsor impressions and clicks. You can stop future reports at any time with <code>npx tokentown unschedule</code>.
        </p>
      </section>

      <section>
        <h2>Sponsored flights</h2>
        <p>
          Clearly labeled sponsors can appear in the website&apos;s flying airship and bottom sponsor strip. Sponsor submissions
          include a site name, short line, HTTPS destination and receipt email, and are stored for payment,
          moderation and scheduling. Campaigns run for 24 hours after manual approval, with a 30-minute
          sponsor-free interval between campaigns. Payment is handled
          by Stripe; NORTOWN never receives card details.
        </p>
      </section>

      <section>
        <h2>Inspect the code</h2>
        <p>
          The complete reporter and website source are available on{" "}
          <a href="https://github.com/AElise08/tokentown">GitHub</a>.
        </p>
      </section>
    </main>
  );
}
