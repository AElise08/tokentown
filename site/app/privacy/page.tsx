import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · TOKENTOWN",
  description: "What TOKENTOWN reads locally, what it reports, and what it never collects.",
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <a className="privacy-back" href="/">&lsaquo; back to TOKENTOWN</a>
      <p className="privacy-kicker">TOKENTOWN · PRIVACY</p>
      <h1>Local usage stays local.</h1>
      <p className="privacy-lede">
        TOKENTOWN turns AI coding usage into a public pixel city. Its reporter is open source and
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
          are stored with Upstash Redis. TOKENTOWN counts aggregate visitors and pageviews without
          behavioral advertising cookies. It does not create browsing profiles or track individual
          sponsor impressions and clicks. You can stop future reports at any time with <code>npx tokentown unschedule</code>.
        </p>
      </section>

      <section>
        <h2>Sponsored flights</h2>
        <p>
          Clearly labeled sponsors can appear in the website&apos;s side dock and airship. Sponsor submissions
          include a site name, short line, HTTPS destination and receipt email, and are stored for payment,
          moderation and scheduling. Campaigns run for 24 hours after manual approval. Payment is handled
          by Stripe; TOKENTOWN never receives card details.
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
