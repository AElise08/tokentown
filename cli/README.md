# `npx tokentown`

Put your city on the [**TOKENTOWN**](https://tokentown-gamma.vercel.app) leaderboard from the terminal — **no app to install.**

TOKENTOWN turns your real Claude Code token usage into a pixel city: every token your agents burn raises a building. This little CLI reads your usage on your own machine and reports this season's numbers to the leaderboard, so you get a city at `/u/<name>` in about ten seconds.

## Use it

```bash
npx tokentown
```

First run asks for a username, generates a private key, and saves a tiny config to `~/.tokentown-placar.json`. Every run after that just reports and prints your city URL.

```
npx tokentown            report your season once, print your city URL
npx tokentown watch      keep running, report every ~10 minutes
npx tokentown --dry-run  read & print exactly what WOULD be sent — nothing leaves your machine
npx tokentown --help
```

Requires **Node 18+**. Zero dependencies.

## What it reads

Your Claude Code session transcripts under `~/.claude/projects/**/*.jsonl` — token usage, tool calls and models — with the same per-message de-duplication and per-season backfill the desktop app uses, so the numbers are accurate whether or not you were running the app, and sub-agent usage is counted too.

- **Tokens → buildings** — `input + output + cache_creation` tokens.
- **Honest cost** — every field (including cache reads) at real per-model pricing.
- **Residents** — the sub-agents your sessions spawned.
- **Landmarks** — a waterfront garden at 100k tokens, a ferry at 300k, a lighthouse at 1M, a tower district at 3M.

## Privacy

**Local-first.** Everything is read on your machine. Only your **username and the numbers** are ever sent — **never** prompts, code, conversation content, or project names.

Sharing your **setup** (the skills, MCP servers, tools and models you actually use — *names and counts only*) is **opt-in**: the first run asks, and you can flip `shareSetup` in `~/.tokentown-placar.json` anytime. Run `npx tokentown --dry-run` to see the exact payload before anything is sent.

## Config

`~/.tokentown-placar.json` (override the path with `TOKENTOWN_CONFIG=/path/to.json` for testing). Shared with the desktop app — same file, same account. You can hand-edit a few cosmetics:

| field | what |
|---|---|
| `cityName` | your city's name on `/u/<name>` (≤ 24 chars) |
| `motto` | a line in italics under it (≤ 48 chars) |
| `accent` | `dourado` · `teal` · `rosa` · `violeta` · `verde` · `ambar` |
| `shareSetup` | `true`/`false` — share your stack |

---

Part of the [TOKENTOWN](https://github.com/AElise08/tokentown) monorepo. Not affiliated with Anthropic.
