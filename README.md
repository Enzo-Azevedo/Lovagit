# Lovagit

Extensão de navegador (Chrome MV3) que transforma cada repositório do GitHub em um
**chat de IA independente**. Você conecta um token PAT, escolhe os repositórios, e
cada um ganha sua própria conversa — com contexto mapeado automaticamente e
**isolamento total** entre repositórios.

Quando você pede uma alteração, a IA lê o código de verdade pela API do GitHub,
escreve os arquivos, **cria uma branch de backup da `main`** e commita na `main`.
Se quiser voltar atrás, a branch de backup é a referência da restauração.

---

## Como funciona

```
┌─ Side panel (chat) ─────────────────────────────────────────────┐
│  repo A │ repo B │ repo C     ← um chat por repositório          │
│                                                                  │
│  "adicione validação no formulário de cadastro"                   │
│         │                                                         │
│         ▼                                                         │
│   ┌──────────────┐   tools    ┌───────────────────────────────┐  │
│   │  Provedor IA │ ◄────────► │ list_directory · read_file    │  │
│   │  (BYOK/OAuth)│            │ search_code · write_file      │  │
│   └──────────────┘            │ delete_file · commit_changes  │  │
│                               └──────────────┬────────────────┘  │
└──────────────────────────────────────────────┼───────────────────┘
                                               ▼
                            GitHub API (somente o repo daquele chat)
                                               │
                     1. cria  lovagit/backup/main/<timestamp>
                     2. commita as alterações na main
```

### 1. Mapeamento automático ao conectar

Ao conectar um repositório, a extensão monta um mapa que vai no system prompt
daquele chat — é o que evita a IA "se perder" no contexto:

- árvore completa de arquivos (Git Trees API, recursiva);
- linguagens e stack detectada (React, Next.js, Supabase, Django, Go, Docker…);
- entrypoints prováveis (`src/main.tsx`, `app/page.tsx`, `manage.py`…);
- README e arquivos-manifesto já lidos e resumidos.

O conteúdo dos demais arquivos **não** é despejado no prompt: a IA lê sob demanda
via tools. Isso mantém o custo baixo e funciona em repositórios grandes.

### 2. Isolamento entre repositórios (4 camadas independentes)

O prompt do repositório X só conhece X. Isso é garantido por construção:

| Camada | Onde | O que faz |
|---|---|---|
| Armazenamento | `src/lib/storage.ts` | chaves namespaced (`repo:<owner/name>:chat`), leitura/escrita exigem `repoId` |
| Escopo | `src/lib/agent/isolation.ts` | `RepoScope` imutável; `owner`/`name` das tools vêm dele, nunca de argumento do modelo |
| Histórico | `historyToTurns` + filtro por `repoId` | mensagem de outro repo é descartada, não enviada |
| Canário | `assertNoForeignRepoLeak` | antes de cada request, varre o payload atrás do nome de qualquer outro repo conectado e **aborta** se achar |

### 3. Política de commit: backup antes, sempre

Como o Lovable só enxerga a `main`, as alterações vão para a `main` — mas nunca
sem rede de proteção:

1. cria `lovagit/backup/main/<timestamp>` apontando para o HEAD atual;
2. cria blobs → tree → commit → atualiza a ref da `main` (fast-forward, sem force);
3. registra um *checkpoint* no painel do chat.

**Restaurar** cria um commit novo na `main` com a árvore exata da branch de backup
— sem `force push`, sem reescrever histórico, e a própria restauração vira um
checkpoint (dá para desfazer a desfeita).

---

## Instalação

```bash
npm install
npm run build
```

No Chrome: `chrome://extensions` → ative **Modo do desenvolvedor** → **Carregar sem
compactação** → selecione a pasta `dist/`.

Clique no ícone da extensão para abrir o side panel.

> Também funciona em Edge, Brave e Opera (mesma base Chromium). Firefox não é
> suportado nesta versão: não tem `chrome.sidePanel`.

---

## Configuração

### GitHub

Em **Configurações → GitHub**, cole um Personal Access Token:

- **Fine-grained** (recomendado): selecione os repositórios desejados e dê
  `Contents: Read and write` + `Metadata: Read`.
- **Clássico**: escopo `repo`.

O token é cifrado com AES-GCM antes de ir para o `chrome.storage.local` — a chave
mestra é um `CryptoKey` **não exportável** guardado no IndexedDB da extensão.

### Inteligência artificial

Dois caminhos, ambos configuráveis em **Configurações → Inteligência artificial**:

**a) Chave de API (BYOK)** — Claude (Anthropic), OpenAI, OpenRouter, Groq ou
qualquer endpoint compatível com OpenAI (gateway próprio, LM Studio, etc.).
O provedor Claude usa o SDK oficial `@anthropic-ai/sdk` com
`dangerouslyAllowBrowser: true`, que envia o header
`anthropic-dangerous-direct-browser-access` exigido pela API para requisições
vindas do navegador. Modelo padrão: `claude-opus-5`.

**b) Login OAuth em provedor terceiro** — OAuth 2.0 com **PKCE** via
`chrome.identity.launchWebAuthFlow`. A extensão é um *public client*: não existe
`client_secret` embutido (num bundle de navegador, segredo nenhum é segredo).
Preencha `authorization_url`, `token_url`, `client_id` e escopos, e registre no
provedor a Redirect URI mostrada na tela — `https://<extension-id>.chromiumapp.org/`.
O access token é guardado cifrado e renovado por `refresh_token` quando o provedor
oferece um.

> A permissão de host da origem do endpoint é solicitada no momento em que você
> salva a chave/faz login (`optional_host_permissions`), então a extensão só
> alcança os domínios que você autorizou.

### Política de commit

Ligada por padrão: a IA cria o backup e commita sozinha ao terminar. Desligando,
as alterações ficam no painel do chat esperando seu clique em **Commitar** — com
diff arquivo a arquivo. Nos dois casos o backup é criado antes do commit.

---

## Uso

1. **Repos** → conecte um ou mais repositórios (o mapeamento roda na hora).
2. Escolha o repositório no seletor do topo — cada um tem seu próprio chat.
3. Peça a alteração em português mesmo: *"troque o botão de login por um menu"*.
4. Acompanhe as tools que a IA usou, revise o diff e o commit gerado.
5. **Histórico e backups** lista os checkpoints, com link para o commit e o botão
   **Voltar para este backup**.

**Remapear** refaz o mapa do repositório — útil quando alguém commitou por fora.

---

## Estrutura

```
src/
├─ background/index.ts        service worker (só abre o side panel)
├─ sidepanel/                 UI do chat (React)
│  ├─ App.tsx                 shell + seletor de repositório
│  ├─ ChatView.tsx            conversa, diffs pendentes, checkpoints
│  ├─ RepoPicker.tsx          lista e conecta repositórios
│  └─ DiffView.tsx            diff colapsável por arquivo
├─ options/Options.tsx        PAT, provedores de IA, política de commit
└─ lib/
   ├─ vault.ts                cofre AES-GCM (chave não exportável no IndexedDB)
   ├─ storage.ts              estado namespaced por repositório
   ├─ diff.ts                 diff de linhas por LCS
   ├─ github/
   │  ├─ client.ts            REST + cache por ETag + rate limit
   │  ├─ mapper.ts            mapeamento e detecção de stack
   │  └─ writer.ts            branch de backup, commit e restauração
   ├─ ai/
   │  ├─ anthropic.ts         Claude via SDK oficial
   │  ├─ openai-compatible.ts endpoints estilo OpenAI (streaming SSE)
   │  ├─ oauth.ts             OAuth 2.0 + PKCE
   │  └─ registry.ts          fábrica de provedores
   └─ agent/
      ├─ isolation.ts         firewall de contexto
      ├─ prompt.ts            system prompt por repositório
      ├─ tools.ts             tools do agente
      └─ loop.ts              laço agêntico
```

## Scripts

| Comando | O que faz |
|---|---|
| `npm run build` | typecheck + build de produção em `dist/` |
| `npm run dev` | build em watch (recarregue a extensão no Chrome) |
| `npm test` | suíte Vitest (isolamento, mapeamento, escrita, diff, streaming) |
| `npm run typecheck` | só o `tsc --noEmit` |

## Limites conhecidos

- **Rate limit do GitHub**: 5.000 req/h por token. O cliente usa ETag, então
  releituras não gastam cota; ainda assim, repositórios enormes consomem mais no
  primeiro mapeamento.
- **Arquivos grandes** (> 200 KB) não são lidos inteiros — use `search_code`.
- **Árvore truncada**: acima de ~100.000 entradas ou 7 MB a Git Trees API trunca;
  o mapa marca isso e a IA navega com `list_directory`.
- **Busca de código** do GitHub tem atraso de indexação e não cobre repositórios
  vazios; nesse caso o fallback é casar pelo nome do arquivo.
- O laço do agente roda no documento do side panel. Fechar o painel no meio de
  uma execução cancela o turno (as mensagens já produzidas são preservadas).
- O build emite avisos de `node:fs`/`node:path` externalizados pelo SDK da
  Anthropic: são o caminho de credenciais em Node, que nunca executa aqui porque
  a chave é passada explicitamente.
