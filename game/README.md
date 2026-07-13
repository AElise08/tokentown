# TOKENTOWN

> *where prompts become skyline*

An **ambient idle game that runs while you use AI coding agents.** Every token your
agents burn raises a building in a little pixel city that lives in the corner of your
screen. Leave it open while you work — it grows on its own, day turns to night on your
real clock, and at the end of the season you look over and see the city your work built.

There's a leaderboard too: [see who built the biggest city this season](#the-leaderboard).

---

## What it is

A tiny always-on-top overlay (the *janelinha*) that reads your **real** Claude Code
usage on your machine and turns it into a place:

- **Tokens → buildings.** Every token your AI agents burn becomes a building. Watch the
  skyline rise in real time — no tab to check.
- **A game while the agent works.** Press `▶ recreio` for a Mario-style platformer
  across your own city's rooftops. It's playable **only while the agent is busy** — the
  moment it finishes, or needs a decision from you, the game auto-pauses so you get
  straight back to work. Each run is a fresh map.
- **It knows when it's your turn.** Live / *your decision* / done — a calm chime,
  a border pulse, and a system notification when the agent is waiting on you, even when
  several sub-agents are running.
- **28-day seasons.** Everyone's city resets on the same global clock, then you build
  again. Population, cost, and buildings all carry the season.
- **Real-time day & night + weather.** The sky follows your local hour; windows light up
  at dusk, it rains, it snows in December. Cats on rooftops, a ferry, a rare blimp.

## The leaderboard

A companion web app — a **leaderboard of AI-token cities**.

- Every dev is a real pixel city, generated from their own numbers. Share yours at
  `/u/<name>`.
- Rank by **7 days** or the **28-day season**.
- **How this city was built** — an opt-in panel showing the *setup* behind the city:
  the skills, MCP servers, tools and models you actually use. Names and counts only —
  it's about learning each other's stacks, not just who spent most.

## Privacy

**Local-first.** The overlay reads your usage on your own machine. Only your **username
and the numbers** are ever reported — **never** prompts, code, conversation content, or
project names. Sharing your setup is **opt-in** (`shareSetup` in the config).

## Run it

### The overlay (desktop app)

macOS. Ships as an Electron app today (a lighter native shell is planned):

```bash
cd tokentown
npm install
npm start
```

A frameless, transparent, always-on-top window appears in the bottom-right corner. Drag
it by the title bar; close with the ×.

### The leaderboard (web app)

```bash
cd tokentown-placar
npm install
npm run dev        # http://localhost:3000
```

Deploy to Vercel + Upstash Redis — see `tokentown-placar/README.md`.

## Join the board

Three ways in, lightest first:

| Tier | Friction | You get |
|---|---|---|
| `npx tokentown` *(coming soon)* | 10 seconds, no install | your city on the site, updates when you run it |
| The desktop overlay (this repo) | download | the live HUD + the rooftop game + the states |
| Just watch | nothing | browse everyone's cities on the leaderboard |

## How it works

- Reads the Claude Code session transcripts under `~/.claude/projects/**/*.jsonl`
  (token usage, tool calls, models) with per-message **de-duplication** and a
  **per-season backfill** from timestamps — so it's accurate whether the app was open or
  not, and counts sub-agent usage too.
- Tokens that grow the city = `input + output + cache_creation` (the "new" tokens);
  the honest **cost** estimate uses every field, including cache reads, with real
  per-model pricing.
- The city (`game.js`) is a hand-rolled canvas pixel renderer — no external assets, no
  dependencies beyond Electron. The site draws each city as a deterministic SVG.

## Tech

- **Overlay:** Electron + a single hand-written `game.js` canvas engine.
- **Site:** Next.js (App Router) + Upstash Redis, with an in-memory fallback for local
  dev. Cities are pure server-rendered SVG.
- No telemetry, no accounts on the overlay. The leaderboard is honor-system
  (self-reported), like any community board.

## Status

**v1.** Feature-complete for a launch; the pieces above all work and are covered by tests.
Next up: `npx tokentown`, a lighter native shell for the overlay, and a public deploy.

---

*Built by [@AElise08](https://github.com/AElise08). Not affiliated with Anthropic.*
