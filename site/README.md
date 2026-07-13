# TOKENTOWN — leaderboard

The season leaderboard for **TOKENTOWN**: who built the biggest city by burning AI tokens.
The desktop overlay measures your **real** Claude Code token usage locally and reports the
season total; this site ranks everyone.

### Why the app (not just another token counter)

- **Your city grows while you code.** Live in the corner of your screen, a pixel city rises on
  the waterfront. Every token your AI agents burn becomes a building — in real time, no tab to check.
- **Play on your rooftops while the agent works.** A tiny platformer runs across your own city's
  rooftops; the moment the agent finishes (or needs a decision), the game auto-pauses so you get
  back to work.
- **28-day seasons**, **real-time day/night + weather**, and **local-first**: only your username
  and the numbers (tokens, estimated cost, residents, buildings) are ever reported — never prompts,
  code or project names.

### Run it

```bash
npm install
npm run dev            # http://localhost:3000
npm run test:lib       # lib test suite
```

> Building with the dev server running: use **`npm run build:prod`** (writes to a separate
> `.next-build` distDir via `NEXT_DIST_DIR`) so the build doesn't overwrite chunks the dev server
> is serving. Never run a plain `npm run build` while `npm run dev` is up.

Without Upstash configured, the app falls back to **in-memory** storage (data is lost on restart).
For production, add the Upstash Redis vars to `.env.local` (see `.env.example`).

### Get your city

- **`npx tokentown`** — coming soon: 10-second setup, no install.
- **Desktop overlay app** (macOS) — the floating window that lives in the corner while you code.
- **Just watch** — browse the cities other devs are growing; nothing to install.

### Personalization (city name, motto, color)

Each person can shape their own city by editing three optional fields in `~/.tokentown-placar.json`:
`cityName` (≤ 24 chars), `motto` (≤ 48 chars), and `accent` (one of `dourado` · `teal` · `rosa` ·
`violeta` · `verde` · `ambar`). The client sends them as `profile` on the report; the server
sanitizes hard (length, character allowlist, accent from the fixed list). A report **without** a
field **preserves** whatever was stored; setting a field to an **empty string `""`** explicitly
**clears** the stored value. An invalid value is ignored and the report still counts.

### Honor system & privacy

Numbers are **self-reported** by each person's app — like any community leaderboard, there's no
central check that they're real. Light per-`username` key auth (first report registers `sha256(key)`;
wrong key later → 403). The board stores only `username` + the numbers + the last-report time; it
never receives your content, prompts or code.

---

# TOKENTOWN — placar (pt-BR)

Leaderboard web por **temporada** do [TOKENTOWN](../tokentown): quem construiu a maior
cidade queimando tokens de IA. O overlay desktop mede o uso **real** de tokens do Claude
Code na máquina de cada pessoa e reporta o total da temporada; este site ranqueia.

- **Página `/`** — placar retrô em pt-BR: temporada atual, dias restantes, tabela
  ranqueada por tokens (top 100), seletor de temporadas passadas.
- **API `/api/report`** (POST) — o app manda o snapshot da temporada.
- **API `/api/placar`** (GET) — JSON ranqueado, pra qualquer um consumir.

Stack: **Next.js (App Router, TypeScript)** + **Upstash Redis** (`@upstash/redis`).
Sem nenhuma outra dependência de runtime.

---

## Temporadas

Temporadas globais de **28 dias**, iguais pra todo mundo (mesma fórmula do app):

```js
const SEASON_EPOCH = Date.UTC(2026, 0, 5);            // 05/01/2026 00:00 UTC
const seasonId = Math.floor((Date.now() - SEASON_EPOCH) / (28 * 86400000));
```

Cada temporada é um ranking independente. `GET /api/placar?season=N` mostra qualquer uma.

---

## Rodar local

```bash
npm install
npm run dev            # http://localhost:3000
```

> ⚠️ **Build local com o dev no ar:** NÃO rode `npm run build` enquanto o `npm run dev`
> estiver rodando — os dois usam o mesmo diretório `.next` e o build sobrescreve chunks
> que o dev está servindo, quebrando a página com
> `__webpack_modules__[moduleId] is not a function` (HTTP 500). Pra buildar sem derrubar
> o dev, use **`npm run build:prod`** (e `npm run start:prod`), que gravam num distDir
> separado `.next-build` (via `NEXT_DIST_DIR`). No Vercel isso não importa: cada deploy
> builda num ambiente próprio, sem dev server concorrente. Testes de lib: `npm run test:lib`.

**Sem Upstash configurado**, o app cai automaticamente num **storage em memória** (um
`Map` no processo) e imprime um aviso no console. Ótimo pra desenvolver — mas os dados
**somem quando o servidor reinicia**. Pra persistir de verdade, configure o Upstash
(abaixo) e coloque as variáveis num `.env.local` (veja `.env.example`).

Testando por curl:

```bash
# reportar
curl -X POST http://localhost:3000/api/report -H 'content-type: application/json' \
  -d '{"username":"mel-dev","key":"uma-key-secreta","seasonId":6,"tokens":5000000,"cost":42.5,"residents":18,"buildings":37}'

# ler o placar
curl 'http://localhost:3000/api/placar?season=6'
```

---

## Deploy no Vercel

O fluxo é **push = deploy** (cada push pra branch de produção republica).

1. **Criar o projeto**: importe este repositório no Vercel (New Project → seleciona o
   repo). O framework é detectado como Next.js automaticamente; não precisa mexer em
   build/output.
2. **Adicionar o Upstash Redis pelo Marketplace**: no dashboard do projeto →
   **Storage** (ou **Integrations → Marketplace**) → **Upstash** → **Redis** → criar/
   conectar um banco e ligar a este projeto. O Vercel injeta sozinho as variáveis
   **`UPSTASH_REDIS_REST_URL`** e **`UPSTASH_REDIS_REST_TOKEN`** em Production/Preview.
3. **Conferir as envs**: Project → **Settings → Environment Variables** — as duas do
   Upstash devem estar lá. Nada mais é necessário.
4. **Deploy**: dê push (ou clique em Deploy). Pronto. A URL de produção vira o destino
   do `url` no config do app: `https://SEU-PROJETO.vercel.app/api/report`.

> Se preferir CLI: `vercel link`, depois `vercel env pull .env.local` pra trazer as
> variáveis do Upstash pra máquina, e `vercel --prod` pra publicar.

---

## Como o app reporta (cliente)

O módulo [`client/placar.js`](client/placar.js) é **CommonJS puro, zero dependências**
(usa só `fetch`/`fs`/`path`/`crypto` do Node 18+). Copie ele pra dentro do app TOKENTOWN
e ligue no loop de polling. Ele:

- lê/cria um config JSON `{ enabled, username, key, url }` no caminho que você passar;
- gera uma **key secreta aleatória** na primeira ativação e guarda no config;
- faz **throttle interno de 10 min** e **retry silencioso** — falha de rede **nunca**
  quebra o app.

O snapshot que ele manda é o **total absoluto da temporada** (não é delta).

---

## Personalização leve (nome da cidade, lema, cor)

Cada pessoa pode dar uma cara pra própria cidade editando **três campos opcionais**
no config `~/.tokentown-placar.json`:

```jsonc
{
  "enabled": true,
  "username": "mel",
  "key": "…",
  "url": "https://SEU-PLACAR.vercel.app/api/report",

  "cityName": "Meltown",                    // título grande no /u (até 24 chars)
  "motto": "feita de tokens e teimosia",    // lema em itálico embaixo (até 48 chars)
  "accent": "dourado"                        // cor de destaque (ver lista abaixo)
}
```

- **`cityName`** — vira o título da página `/u/você` (sem ele, cai em "cidade de você")
  e aparece pequeno sob o username no ranking. Só letras, números, espaço, hífen e
  apóstrofo; o resto é limpo (nada de markup).
- **`motto`** — uma frase curta, em itálico, logo abaixo do nome.
- **`accent`** — tinge detalhes da página (borda do card, chips, o pulsinho do "ao vivo")
  e dá um leve tom nas janelas da cidade. Um de: **`dourado`** (padrão) · **`teal`** ·
  **`rosa`** · **`violeta`** · **`verde`** · **`ambar`**. Qualquer outro valor é ignorado.

O cliente manda esses campos como `profile` no POST; o servidor **sanitiza duro** (tamanho,
allowlist de caracteres, accent só da lista). Campo inválido é ignorado — o report continua
valendo. Um report **sem** `profile` **preserva** o que já estava salvo (não apaga). Tudo isso
também alimenta o **card de compartilhamento** (veja abaixo).

## Card de compartilhamento (og:image)

Colar o link `/u/você` no WhatsApp, X ou Discord mostra um cartão 1200×630 com **a sua
cidade renderizada**, o nome/lema/cor do perfil e os números da temporada. É gerado on-demand
por `next/og` (já vem no Next, zero dependência nova) nas rotas
`/u/[username]/opengraph-image` e `/u/[username]/twitter-image`; a página injeta as meta tags
`og:image` e `twitter:card` (summary_large_image) apontando pra elas.

---

## Honor system (leia isto)

Este placar é **auto-reportado**, como quase todo leaderboard de comunidade:

- **Não há verificação central** de que os números são reais. O app de cada pessoa
  mede o próprio uso e envia. Dá pra forjar — assim como dá pra mentir num ranking de
  passos ou num placar de jogo caseiro. A graça é a comunidade, não a auditoria.
- **Autenticação leve por key**: o primeiro report de um `username` registra o `sha256`
  de uma key secreta. Depois disso, reports com a key errada tomam **403** — então
  ninguém "rouba" teu nome nem sobrescreve teu número. (Mas o primeiro a registrar um
  nome fica com ele.)
- **Nunca regride**: cada valor é um snapshot absoluto e só sobe. Um report atrasado com
  número menor é ignorado (protege contra corrida entre reports).
- **Rate limit**: no máximo 1 report por minuto por username.
- **Teto de sanidade**: valores absurdos são limitados (ex.: tokens no teto de 10 bi).

## Privacidade

O placar recebe e guarda **só**: `username` e os **números** (tokens, custo estimado em
USD, moradores, prédios) mais o horário do último report. **Nunca** recebe teu conteúdo,
prompts, código, nomes de projeto ou qualquer texto do que você fez — o app calcula os
números localmente e manda só o resumo.

---

## Estrutura

```
tokentown-placar/
├─ app/
│  ├─ layout.tsx            # shell + metadata
│  ├─ globals.css           # estética retrô-calma (paleta do app, scanlines sutis)
│  ├─ page.tsx              # a página do placar (Server Component)
│  ├─ u/[username]/
│  │  ├─ page.tsx           # perfil /u: cidade grande + cityName/motto/accent
│  │  ├─ og-card.tsx        # arte compartilhada do card (next/og)
│  │  ├─ opengraph-image.tsx# rota og:image (1200×630 PNG on-demand)
│  │  └─ twitter-image.tsx  # rota twitter card (mesma arte)
│  └─ api/
│     ├─ report/route.ts    # POST — recebe o snapshot
│     └─ placar/route.ts    # GET  — devolve o ranking
├─ lib/
│  ├─ season.ts             # fórmula das temporadas de 28 dias
│  ├─ store.ts              # Upstash Redis + fallback em memória; regras do honor system
│  ├─ city.ts               # gerador da cidade em SVG (determinístico) + tint do accent
│  ├─ profile.ts            # personalização: sanitização de cityName/motto/accent
│  └─ format.ts             # formatação pt-BR (1,2M / US$ / "há 3 min")
├─ client/
│  └─ placar.js             # módulo CommonJS pro app integrar (zero deps)
└─ ...
```

### Estrutura no Redis

- `s{N}:rank` — **ZSET** (score = tokens) → ranqueamento da temporada `N`.
- `s{N}:u:{username}` — **HASH** com `tokens, cost, residents, buildings, lastReport`,
  mais `city` (JSON da cidade real) e `profile` (JSON de `cityName/motto/accent`), ambos
  opcionais e sanitizados.
- `users` — **HASH** `username → sha256(key)` (autenticação honor system).
- `rl:{username}` — chave com TTL de 60s (rate limit).
