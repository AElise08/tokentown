# `npx tokentown`

Put your city on the [TOKENTOWN](https://tokentown-gamma.vercel.app) leaderboard from the terminal. No permanent npm install is required.

TOKENTOWN turns local **Claude Code, Codex and OpenCode** usage into a pixel city. Every run backfills the current season, so usage is not lost while the reporter is closed.

## Commands

```bash
npx tokentown             # read once, report and print your city URL
npx tokentown --models    # report and show the complete cost/model breakdown
npx tokentown schedule    # macOS: report every 10 minutes in the background
npx tokentown status      # show background reporter status
npx tokentown unschedule  # remove the background reporter
npx tokentown --dry-run   # print exactly what would be sent; send nothing
npx tokentown watch       # optional foreground compatibility mode
```

The first run asks for a username and stores a private key in `~/.tokentown-placar.json`. Requires Node 18+. The package has zero npm dependencies. OpenCode reading uses the system `sqlite3` executable and is skipped safely when it is unavailable.

## Local sources

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- OpenCode: `~/.local/share/opencode/opencode.db`

Only timestamps, usage counters, model/provider identifiers and tool names are aggregated. Prompts, code, conversation text and project names are never copied or sent.

## Tokens and cost

- City growth excludes cache reads so repeated context does not inflate buildings.
- Cost includes input, cached input, cache writes and output when the client exposes those fields.
- OpenCode's own recorded cost is preferred. When Codex or an OpenAI-backed OpenCode session exposes tokens but no bill, TOKENTOWN shows an **official API-equivalent estimate**, not a subscription invoice.
- `--models` prints the local breakdown by provider and model. The server still receives only aggregate numbers and the optional setup summary.

## Background mode

On macOS, `schedule` installs a small user LaunchAgent. It runs a copied, version-pinned CLI every ten minutes, including after login, without keeping Terminal or `npx tokentown watch` open. Run `schedule` again after upgrading the npm package so the background copy is refreshed.

On Linux, use cron or a systemd user timer to run `npx tokentown` periodically. Windows background scheduling is not yet built in.

## Privacy and config

Only your username and aggregate numbers are reported. Sharing setup names/counts is opt-in. Use `--dry-run` to inspect the payload.

Config: `~/.tokentown-placar.json` (override with `TOKENTOWN_CONFIG=/path/to.json`). Supported cosmetic fields are `cityName`, `motto`, `accent` and `shareSetup`.

Part of the [TOKENTOWN](https://github.com/AElise08/tokentown) monorepo. Not affiliated with Anthropic or OpenAI.
