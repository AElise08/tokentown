# TOKENTOWN

> *where prompts become skyline*

An **ambient idle game that runs while you use AI coding agents.** Every token your
agents burn raises a building in a little pixel city that lives in the corner of your
screen. Leave it open while you work — it grows on its own, day turns to night on your
real clock, and at the end of the season you look over and see the city your work built.

There's a **leaderboard** too, where devs compare their token-cities and — opt-in — the
skills, MCP servers and models behind them. Not "who spent most", but *what stack built
that*.

---

## This repo

A monorepo with two parts:

| Folder | What it is | Runs on |
|---|---|---|
| [`game/`](game/) | The desktop **overlay** — a native macOS app (Swift + WKWebView, ~384 KB) that reads your real Claude Code usage locally and renders the city + the rooftop mini-game. | your Mac |
| [`site/`](site/) | The **leaderboard** — a Next.js web app (deployed to Vercel + Upstash Redis) showing everyone's cities. | the web |

Each folder has its own README with details.

## Quick start

**The overlay (macOS):**
```bash
cd game/swift
./build.sh
open TokenTown.app
```

**The leaderboard (local):**
```bash
cd site
npm install
npm run dev        # http://localhost:3000
```

## Privacy

**Local-first.** The overlay reads your usage on your own machine. Only your **username
and the numbers** are ever reported — **never** prompts, code, conversation content, or
project names. Sharing your setup is **opt-in**.

---

*Built by [@AElise08](https://github.com/AElise08). Not affiliated with Anthropic.*
