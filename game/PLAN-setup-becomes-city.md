# PLANO — "Teu setup vira cidade"

**Objetivo:** transformar o TOKENTOWN de um placar de *quanto* você gasta em um lugar que mostra *com o quê* você constrói — skills, MCP, ferramentas e modelos viram os **prédios e distritos nomeados** da tua cidade. Copiar a *filosofia* do tokenmaxxing (transparência de setup, aprendizado coletivo) expressa do jeito TOKENTOWN (cidade + jogo), que ninguém tem.

> **Régua-mãe:** a cidade e o jogo são o fosso. Nada aqui pode virar "tokenmaxxing com pixel". Setup entra como *lugar*, não como planilha.

---

## Decisões (confirmar antes da Fase 1)

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Compartilhar setup no placar é **opt-in**? | **Sim** — `shareSetup: true` no config, padrão `false`. Só nomes e contagens, nunca prompt/código/nome de projeto/caminho. |
| D2 | Prédios-skill têm **letreiro** na cidade do app? | Só os **~6 principais** ganham placa pixel (detalhe em cachos); o resto existe sem nome. Lista completa fica na `/u`. |
| D3 | Escopo dos dados (ferramentas/modelos) | **Temporada atual** — coerente com tokens/prédios. |
| D4 | Polish visual | Mantém **escuro-retrô**; adiciona **acento serifado** só nos títulos + hero mais editorial. NADA de creme+serifa (clichê de IA). |
| D5 | Tua **própria** cidade mostra teu setup mesmo SEM compartilhar? | **Sim** — o overlay local sempre mostra teu stack (é teu). Opt-in controla só o que sobe pro site. |

---

## Modelo de dados

O app já lê quase tudo de `~/.claude`. Novidade = ler nomes de skills/MCP/hooks (baratos, só nomes).

| Sinal | Origem | Já lido? |
|---|---|---|
| Skills | nomes de dir em `~/.claude/skills/` | novo (nomes) |
| MCP servers | chaves `mcpServers` em `~/.claude.json` / settings | novo (nomes) |
| Hooks | eventos em `~/.claude/settings.json` | novo (nomes) |
| Ferramentas | `tool_use.name` nos transcripts (Bash/Edit/Agent/WebSearch…) | **já conta** |
| Modelos | `message.model` por linha de usage | **já lê (custo)** |

**Payload novo (opt-in, sanitizado ≤~3KB, mesmo rigor do `city`):**
```json
setup: {
  "v": 1,
  "skills": ["copy-mel", "superpowers", "flow-broll-palmier"],   // ≤40 slugs
  "mcp":    ["palmier-pro", "claude-in-chrome"],                  // ≤20
  "hooks":  ["Stop", "PostToolUse"],                              // ≤12
  "tools":  [["Bash",1859],["Edit",846],["Agent",100]],          // top 10, temporada
  "models": [["opus-4-8",0.71],["sonnet-5",0.20],["haiku-4-5",0.09]] // frações, ≤6
}
```
Sanitização: slug `[a-z0-9-]`, caps por lista, contagens não-negativas, JSON serializado ≤3KB senão descarta o `setup` (report segue). Report sem `setup` **preserva** o guardado; `setup:null` explícito limpa (igual ao profile).

---

## Mapa: setup → cidade

- **Skills = prédios-marco nomeados.** Top ~6 skills viram prédios distintos com placa pixel abreviada (ex.: uma editora "copy-mel", uma torre "superpowers"). Colocação determinística por hash do nome. Demais skills = prédios comuns extras (densidade).
- **MCP = fábricas/estações** com letreiro na orla.
- **Ferramentas = as "indústrias"** — barras na `/u` (Bash 40%, Edit 22%…).
- **Modelos = fontes de energia** — donut pequeno (opus/sonnet/haiku/fable) na `/u` e no 💸 do topo.

---

## Fases

### Fase 0 — Travar decisões (Mel)
Confirmar D1–D5. Sem código.

### Fase 1 — Fundação: dados + contrato *(pré-requisito de tudo)*
**Arquivos:** `~/app/tokentown/main.js`, `placar.js`, `~/app/tokentown-placar/client/placar.js`, `app/api/report/route.ts`, `lib/store.ts`, novo `lib/setup.ts` (+testes).
- `collectSetup()` em `main.js`: lê skills/mcp/hooks (best-effort, degrada pra vazio se path não existe); reusa as tallies de ferramentas/modelos que já calculamos; monta o blob.
- Expor ao renderer via IPC (`onSetup` no preload) — pra Fase 3.
- Reporter (`placar.js` + canônico) inclui `setup` no POST **só se `config.shareSetup`**.
- Server: `sanitizeSetup` em `lib/setup.ts`; `store.ts` grava/preserva/limpa; GET expõe.
- **Aceite:** report com `shareSetup:true` grava e GET devolve; padrão off; sanitizer capa/escapa; report sem setup preserva; `""`/null limpa. Testes de lib passam.

### Fase 2 — Site *(paralela à Fase 3)*
**Arquivos:** `~/app/tokentown-placar/` — `lib/city.ts`/novo `lib/setup-view.ts`, `app/page.tsx`, `app/u/[username]/page.tsx`, `app/globals.css`, og-card.
- **Leaderboard:** chips das top-3 skills sob o username (à la tokenmaxxing, mas discreto e na paleta).
- **/u "How this city was built":** chips de skills/MCP + barras de ferramentas + donut de modelos.
- **Heatmap semanal:** 7 quadradinhos "as luzes da cidade na semana" (dos snapshots diários que já guardamos).
- **Polish editorial:** acento serifado nos títulos, hero com mockup do produto, card "Why TOKENTOWN" com a demo/gif, busca de perfis. Mantém escuro-retrô.
- **Aceite:** `/u` mostra painel de setup + heatmap + donut; board com chips; 200 em tudo; og:image inclui setup; sem string pt-BR; testes.

### Fase 3 — Cidade do app *(depois da Fase 1)*
**Arquivos:** `~/app/tokentown/game.js` (só a cidade calma; recreio intocado), `preload.js` (onSetup).
- Renderer recebe `setup` e desenha os prédios-marco de skill (top ~6 com placa, determinístico), MCP como estações. Tua cidade local mostra teu stack **sempre** (D5).
- **Aceite:** teus prédios-skill aparecem nomeados; determinístico; sem poluir (só top-N com placa); reduced-motion ok; cidade calma sem regressão; testes.

**Sequência:** Fase 1 → ( Fase 2 ∥ Fase 3 ). Fase 1 e 3 mexem em arquivos do app (main/preload/game) → **serializar** (1 antes de 3, relançamentos em fila). Fase 2 é só site → paralela.

---

## Privacidade (inegociável)
Só **nomes e contagens** de configuração saem. NUNCA prompt, código, conteúdo de conversa, nome/caminho de projeto. Opt-in explícito (`shareSetup`). Sanitização dura no cliente E no servidor. Documentar no README e num "what's shared" clicável na `/u`.

## Riscos & mitigação
- **Parecer clone do tokenmaxxing** → cidade primeiro, tabela nunca é o herói; skills são prédios, não tags cruas.
- **Poluir a cidade** → só top-N com placa; resto é densidade.
- **MCP/hooks em locais variáveis** → best-effort, degrada gracioso pra vazio.
- **Privacidade** → opt-in + nomes-only + sanitização dupla + "what's shared" transparente.

## Testes
Cada fase roda as suítes do seu lado (app: test-main/test-game/test-preview; site: lib) sem afrouxar, com testes novos por feature. Relançamento do app confirmado por fase.

---

## Perguntas abertas pra Mel
1. Confirma D1–D5 (principalmente **opt-in** e **letreiro só no top-6**)?
2. Ordem de execução: **(1) setup→cidade** primeiro (o diferencial), depois heatmap + donut? Ou quer o **polish editorial** junto do primeiro pra já ter cara de lançamento?
3. O "Why TOKENTOWN" no topo do site: card com a **demo interativa** (já existe) ou você quer gravar um **vídeo/gif** curto (como o tokenmaxxing)?
