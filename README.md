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

### Build pronto, sem compilar nada

Cada push na `main` dispara o workflow `Build`, que roda os testes, compila e
publica o zip:

- **[Release `latest`](../../releases/tag/latest)** — sempre o último build da
  `main`, com URL de download estável.
- **`v<versão>`** — release estável, publicada quando o número de versão do
  `package.json` muda.

Baixe o zip, extraia e carregue a pasta em `chrome://extensions`.

> Se a publicação da release falhar com `403`, o repositório está com as
> permissões de workflow em modo leitura: **Settings → Actions → General →
> Workflow permissions → Read and write permissions**.

### Atualizar a partir do próprio painel

A faixa no topo do side panel mostra a versão instalada e o último build
publicado da `main`, com um botão que abre o zip numa guia nova. Quando a versão
publicada difere da instalada, a faixa acende nas cores da marca.

A comparação é por **versão anunciada nas notas do build**, não pelo commit: a
release `latest` reaponta a cada push na `main` mantendo o mesmo número, então
comparar commits acenderia o alerta para sempre. Sem versão nas notas, a faixa
fica neutra — nunca inventa novidade.

A resposta do GitHub é cacheada por 6 horas, e a chamada funciona **sem PAT**
(o repositório é público) — quem ainda não configurou o token também precisa
conseguir atualizar.

> **Por que não atualiza sozinha.** O MV3 proíbe código remoto, e extensão
> carregada sem compactação nunca se auto-atualiza. Atualização automática de
> verdade exigiria publicar na Chrome Web Store. Apontar o download é o máximo
> honesto daqui.

Clique no ícone da extensão para abrir o side panel.

> Também funciona em Edge, Brave e Opera (mesma base Chromium). Firefox não é
> suportado nesta versão: não tem `chrome.sidePanel`.

---

## Configuração

### GitHub

Em **Configurações → GitHub**, cole um Personal Access Token:

- **Fine-grained** (recomendado): selecione os repositórios desejados e dê
  `Contents: Read and write` + `Metadata: Read`. Para o relato automático de
  erros, inclua também `Issues: Read and write` no repositório de destino.
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

Ao salvar, a chave é **validada na hora** contra a API do provedor: a extensão
lista os modelos que a sua conta enxerga e os sugere no campo de modelo. Descobrir
que a chave está errada na primeira mensagem do chat é o pior momento possível.

**b) Login OAuth em provedor que ofereça OAuth para a própria API** — OAuth 2.0
com **PKCE** via `chrome.identity.launchWebAuthFlow`, sem `client_secret` embutido
(num bundle de navegador, segredo nenhum é segredo).

### Modelos `:free` do OpenRouter

Modelos com sufixo `:free` roteiam por provedores que podem treinar com o que
você envia, e a conta precisa liberar isso explicitamente. Sem a liberação,
nenhum endpoint casa com a política da conta e a resposta é:

```
404 No endpoints available matching your guardrail restrictions and data policy
```

A correção é na sua conta, em <https://openrouter.ai/settings/privacy> — ou use
um modelo pago. A extensão trata esse caso como configuração, não como defeito:
ele aparece no chat e não abre issue.

### Modelos de raciocínio

Modelos que separam raciocínio do conteúdo mandam a linha de pensamento em
`delta.reasoning`, `reasoning_content`, `reasoning_text` ou no array
`reasoning_details` — o nome varia por provedor. A extensão lê os quatro. Se o
modelo encerrar produzindo **apenas** raciocínio, ele é exibido no chat com um
aviso, em vez de o turno terminar em branco.

O raciocínio aparece **enquanto chega** e depois fica guardado **no passo que o
gerou**, não num painel único do turno. A leitura é cronológica: o que ela pensou
antes de ler o arquivo aparece junto daquela leitura, não misturado com o
pensamento inicial. Não é enfeite: em modelo lento, a fase de pensamento é
justamente o trecho em que a tela fica parada e parece travada.

O raciocínio é cortado em 4.000 caracteres por passo e **nunca é reenviado ao
modelo** — ele já sabe o que pensou, e devolver o campo dobraria o custo do
histórico (alguns provedores chegam a recusá-lo de volta).

### Ações clicáveis

Cada ação da IA é uma linha com o verbo e o alvo (`leu src/App.tsx`), e clicar
abre o resultado: o conteúdo do arquivo que ela leu, o retorno da busca. O corte
é em 20.000 caracteres — um `read_file` pode trazer 200 KB, e isso no DOM trava
o painel.

Antes a mesma ação aparecia duas vezes: uma linha com o caminho e uma badge só
com o verbo, e o conteúdo não aparecia em lugar nenhum.

No OpenRouter a extensão pede o raciocínio explicitamente (`reasoning:
{ enabled: true }`), porque um stream com tráfego é menos suscetível ao
`Upstream idle timeout exceeded` — ver abaixo. O parâmetro é específico do
OpenRouter e só sai quando o endpoint é o dele; a API da OpenAI recusa argumento
desconhecido com `400`. Se ainda assim um modelo recusar o campo, a chamada é
refeita sem ele: um extra nosso nunca pode ser o motivo de a conversa não sair.

E se um turno não produzir texto nem chamada de ferramenta, isso é dito
explicitamente. Conversa que para sozinha, sem resposta e sem erro, é o pior
tipo de falha: parece que o programa travou.

### Quando o streaming cai

Queda de conexão no meio de uma geração longa é comum com agregadores. O que a
extensão faz:

- **Texto parcial é preservado.** O que já chegou fica no chat e o turno encerra
  com um aviso, em vez de a resposta inteira sumir.
- **Tool call truncado é descartado.** Se a queda pegou uma chamada de ferramenta
  pela metade, ela nunca é executada — um `write_file` com JSON cortado gravaria
  um arquivo truncado no seu repositório.
- **Erro em banda vira erro de verdade.** Agregadores podem responder `HTTP 200`
  e reportar a falha *dentro* do stream, num frame com `error` e `choices` vazio.
  Sem tratar isso, o turno termina vazio e parece sucesso — o pior modo de falha,
  porque nada aparece para o usuário.
- Nenhuma dessas situações abre issue: são falhas passageiras, não defeitos.

#### `Upstream idle timeout exceeded` (504)

Esse erro **não vem da extensão**. É o OpenRouter reportando que *o provedor
dele* ficou tempo demais em silêncio: a requisição foi aceita, o stream abriu, e
o relógio que estourou fica entre o OpenRouter e quem hospeda o modelo. Aparece
com modelos lentos — a família Nemotron Ultra Free e o MiMo v2.5 Pro são os
casos mais relatados — e nenhum parâmetro do cliente estende esse tempo limite.

O que dá para fazer do lado de cá é pedir o raciocínio, para o stream não ficar
mudo durante o pensamento (acima), e reenviar a mensagem (abaixo). Se o modelo
for lento demais, a solução real é trocar de modelo.

### Reenvio automático (desligado por padrão)

Em **Configurações → Falha passageira do provedor**, a extensão pode reenviar a
mensagem sozinha 5 segundos depois de uma falha. Três barreiras, cada uma por um
motivo diferente:

- **Só falha passageira.** Queda de conexão, `429` e `5xx` do provedor. Chave
  inválida, modelo inexistente e erro da própria extensão não são reenviados,
  porque a segunda tentativa daria exatamente no mesmo.
- **Uma vez por mensagem.** Sem isso, um provedor com problema persistente vira
  laço infinito queimando tokens.
- **Nunca depois de um commit.** Repetir o turno repetiria trabalho que já está
  gravado no repositório.

Durante a contagem aparece um botão para cancelar, e mandar qualquer mensagem na
mão também cancela. Fica desligado por padrão porque reenviar gasta tokens, e
essa decisão é sua.

> **Anthropic e OpenAI não entram aqui.** A Anthropic restringe o OAuth ao Claude
> Code e ao claude.ai e [não registra `client_id` para terceiros](https://claude.com/docs/connectors/building/authentication);
> desde fevereiro de 2026 os termos [proíbem explicitamente](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)
> usar token OAuth de plano de consumo em ferramenta de terceiro, e o bloqueio é
> aplicado. O "Sign in with ChatGPT" da OpenAI é identidade, não acesso à API na
> conta do usuário. Para essas duas, chave de API é o caminho suportado — e é por
> isso que o login de um clique existe no Lovagit para **servidores MCP**, não
> para o modelo.

> A permissão de host da origem do endpoint é solicitada no momento em que você
> salva a chave/faz login (`optional_host_permissions`), então a extensão só
> alcança os domínios que você autorizou.

### Memória por repositório

O `system prompt` descreve o repositório, mas não o que já aconteceu nele. A
memória cobre isso: **o que você pediu e o que já foi aplicado**, disponível nas
conversas seguintes.

**O que entra** — e só isso:

| Tipo | Quem grava | Quando |
|---|---|---|
| `action` | a extensão, sozinha | a cada commit aplicado **e a cada restauração de backup**, pelos dois caminhos: o commit do agente e o aprovado no botão |
| `request` | a extensão, sozinha | seu pedido, **apenas quando o turno teve consequência** — mexeu em arquivo |
| `decision` | o modelo, pela ferramenta `remember` | algo combinado ou recusado que ainda valerá daqui a semanas |

Turno de pergunta e resposta não vira memória. Memória cheia de ruído atrapalha
tanto quanto memória nenhuma — por isso o registro automático exige consequência,
e o resto depende de o modelo achar que vale.

**O que a IA vê.** Não é a memória inteira: é um recorte de até 3.000 caracteres
(~750 tokens), escolhido do mais recente para o mais antigo e apresentado em
ordem cronológica. O que limita aqui não é o disco, é a janela de contexto do
modelo — memória demais no prompt empurra para fora o código que ele precisa ler.
O recorte vem com duas regras explícitas para o modelo: **o código vence a
memória** (ela pode estar velha) e **pedido antigo registrado não é ordem**.

**Um único escritor.** O commit vira memória em `persistCheckpoint`, por onde
passam tanto o commit do agente quanto o aprovado no botão. Até a v0.3.9 quem
gravava era o laço do agente — então **todo commit aprovado à mão passava sem
virar memória**, que é o caminho de quem revisa o diff antes de commitar. A
restauração de um backup também é registrada: sem isso a memória continuaria
afirmando que um trabalho existe depois de ele ter sido desfeito.

**Onde fica.** Em `chrome.storage.local`, na chave `repo:<owner/name>:memory` —
mesmo namespacing do chat. Sobrevive a fechar o navegador; some quando você
desconecta o repositório ou clica em esquecer.

**Isolamento.** Duas barreiras além do namespacing: o render recusa qualquer
entrada cujo `repoId` não seja o da conversa, e a compressão nunca funde entradas
de repositórios diferentes — fundir seria vazamento, não compressão.

**Você revisa.** O painel "Memoria deste repositorio" fica fixo no topo do chat,
fora da área que rola — sempre a um clique. Ele mostra cada linha
com botão de esquecer, e um botão para limpar tudo. Isso não é enfeite: uma
conclusão errada gravada na memória é repetida em todo prompt seguinte, e sem
como apagar ela envenena o repositório inteiro.

#### Teto e compressão

O teto padrão é **1 GiB para o conjunto de todos os repositórios**, configurável
em Configurações. Um projeto sozinho pode ocupar quase tudo; a pressão só aparece
quando o total passa do limite — e aí o que perde resolução é **o mais antigo, de
qualquer repositório**, não necessariamente o que acabou de escrever.

Nada é apagado. A compressão tem dois estágios, ambos determinísticos (sem
chamada ao modelo, sem custo de token):

1. **Sai o detalhe verbatim**, do mais antigo para o mais novo. A linha de resumo
   fica.
2. **Entradas do mesmo repositório e do mesmo tipo se fundem** numa linha contada
   (`12 alteracoes entre 02/09 e 05/09 — src/a.ts, src/b.ts`), começando pelo
   grupo mais antigo.

No limite sobra uma linha por (repositório, tipo): a linha do tempo continua
inteira, com menos resolução no passado distante — que é onde ela importa menos.

#### `unlimitedStorage`

Sem essa permissão o Chrome dá **10 MB para tudo** que a extensão guarda — mapa,
conversas, histórico, memória. A memória então se limita sozinha a 4 MB para o
resto continuar cabendo, **independente do teto configurado**: passar da cota
faria a gravação falhar e derrubar coisas que não têm nada a ver com memória.

A permissão é **obrigatória**, concedida na instalação. Ela está entre as que o
Chrome não aceita em `optional_permissions`: pedi-la em tempo de execução com
`chrome.permissions.request` falha sempre. Até a v0.4.0 ela estava como opcional
e havia um botão para concedê-la — o botão não funcionava, e o erro era engolido
por um `catch` vazio, então ele não fazia nada nem avisava nada.

Ela cobre `chrome.storage.local`, IndexedDB, Cache Storage e OPFS, e isenta a
extensão da limpeza automática do navegador — que é o que faz a memória ser
realmente permanente.

> Vindo de uma versão anterior, a permissão só passa a valer depois de recarregar
> a extensão em `chrome://extensions`. Até lá o teto de 4 MB continua em vigor, e
> as Configurações dizem isso.

### Política de commit

Ligada por padrão: a IA cria o backup e commita sozinha ao terminar. Desligando,
as alterações ficam no painel do chat esperando seu clique em **Commitar** — com
diff arquivo a arquivo. Nos dois casos o backup é criado antes do commit.

---

## Detecção e relato de erros

Um módulo interno captura as falhas, classifica, **redige** e abre issue em
`Enzo-Azevedo/Lovagit` (configurável). Erros da própria extensão entram como
prioridade máxima.

### O que vira issue

Só defeito. A classificação decide:

| Situação | Categoria | Vira issue? | Labels |
|---|---|---|---|
| Exceção não tratada no código da extensão | bug / extensão | sim | `Alta Prioridade` + `lovagit:erro-extensao` |
| Vazamento de contexto entre repositórios | bug / extensão | sim | `Alta Prioridade` + `lovagit:erro-extensao` |
| GitHub recusa payload que a extensão montou (422) | bug / extensão | sim | `Alta Prioridade` + `lovagit:erro-extensao` |
| Provedor de IA responde fora do contrato | bug / integração | sim | `lovagit:erro-integracao` |
| Token inválido, sem permissão, 404 | configuração | não | — |
| Offline, rate limit, 5xx, conflito de ref | transitório | não | — |
| Conexão com o provedor caiu (inclusive no meio do streaming) | transitório | não | — |
| Servidor MCP fora do ar ou sessão expirada | transitório | não | — |
| Servidor MCP exigindo autorização | configuração | não | — |
| Modelo indisponível para a conta (sem crédito, modelo inexistente, política de dados) | configuração | não | — |
| Servidor MCP fora do protocolo | bug / integração | sim | `lovagit:erro-integracao` |
| Firewall barrou mensagem citando outro repo | esperado | não | — |
| Cancelamento pelo usuário | ignorado | não | — |

Erro de configuração e falha passageira ficam só na interface e no histórico
local: no tracker eles enterrariam o defeito de verdade.

### O que sai da máquina

O repositório de destino é público, então o relatório é redigido na origem:

| Dado | Como sai |
|---|---|
| Nome do repositório | `repo#a1b2c3d4` (hash estável — agrupa sem revelar) |
| Caminho de arquivo | `<arquivo .tsx>` |
| PAT, chave de API, Bearer, JWT | `<token-github>`, `<chave-api>`, `<credencial>` |
| E-mail | `<email>` |
| URL da API | `api.github.com/repos/<repo>/...`, query string vira `?<params>` |
| ID da extensão | `chrome-extension://<id>` |
| Prompt, mensagem do chat, código | **não é enviado** |

Sai: classe do erro, mensagem redigida, stack (até 20 quadros), módulo, versão,
motor do navegador e a classificação.

### Controle de volume

- **Janela de 10s para cancelar** — o aviso mostra o issue que será aberto, com
  `Cancelar envio`, `Ver o que será enviado` e `Enviar agora`.
- **Fingerprint estável** (origem + módulo + classe + mensagem normalizada +
  quadro de topo): a mesma falha comenta no issue existente em vez de abrir
  outro, e reincidência dentro de 1h nem chega a fazer requisição.
- **Teto de issues novos por hora** (padrão 5).
- Issue fechado que volta a acontecer é reaberto com um comentário.

Sem push access no repositório de destino o GitHub descarta as labels em
silêncio — por isso a prioridade também vai escrita no corpo do issue.

Tudo isso é configurável (ou desligável) em **Configurações → Detecção e relato
de erros**, que também mostra o histórico local dos últimos 50 relatórios.

---

## Servidores MCP (ferramentas extras)

Um servidor MCP dá **ferramentas** ao agente — consultar um banco, ler o estado de
um projeto, abrir um chamado. Ele não substitui o provedor de IA: o modelo continua
vindo da chave configurada acima.

### Login de um clique, sem configuração

Aqui o padrão MCP entrega o que a API da Anthropic não permite:

1. a extensão tenta conectar e leva `401`;
2. lê a dica do `WWW-Authenticate` e descobre os metadados do recurso protegido
   ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)) e do authorization
   server ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414));
3. **se registra sozinha** ([RFC 7591, Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591))
   — nada de `client_id` digitado à mão;
4. abre a página de consentimento do provedor com PKCE e `resource` ([RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707));
5. guarda o token cifrado e renova por `refresh_token`.

Você cola a URL do servidor, clica em **Adicionar e conectar**, autoriza na página
do provedor e pronto.

### Isolamento: habilitado por repositório

O servidor é cadastrado uma vez e **habilitado por repositório**. O chat de X só
enxerga as ferramentas marcadas para X.

Isso não é preciosismo: um servidor MCP com memória guardaria contexto de um
repositório e o entregaria no chat de outro — um canal lateral que o firewall de
contexto não consegue vigiar, porque o vazamento aconteceria fora do nosso
processo. Por isso um servidor nasce sem repositório algum habilitado, e
desconectar um repositório o remove de todos os servidores.

A checagem é dupla: a lista já chega filtrada por repositório, e o executor
confere de novo antes de chamar. Se a segunda checagem falhar, o erro **escala
como defeito de alta prioridade** em vez de virar um erro de ferramenta — é
exatamente o tipo de falha que precisa aparecer.

### Detalhes de implementação

- Transporte **Streamable HTTP**: `initialize` → `notifications/initialized` →
  `tools/list` → `tools/call`, com `Mcp-Session-Id` ecoado e `MCP-Protocol-Version`
  negociada (o servidor pode responder com versão diferente da pedida — é normal).
- A resposta pode vir como JSON puro **ou** SSE; o cliente entende as duas.
  Um cliente que só entende JSON quebra em metade dos servidores.
- `404` numa requisição com sessão significa sessão expirada: limpa e reconecta.
- As ferramentas entram no prompt como `mcp__<servidor>__<tool>`, sem colidir com
  as nativas.
- **CORS não é obstáculo**: páginas de extensão ignoram CORS para hosts em
  `host_permissions` — diferente de content scripts. Servidor que não libera nossa
  origem funciona do mesmo jeito.

---

## Imagens no chat

Anexe pelo botão **Anexar** ou **cole uma captura de tela** direto no campo de
texto. Até 4 imagens por mensagem, 5 MB cada, em PNG, JPEG, WebP ou GIF.

**A imagem vale só no turno em que você anexa.** Nos turnos seguintes ela vira
uma marca de texto (`[1 imagem(ns) enviada(s) neste turno: tela.png — não estão
mais visíveis]`). O motivo é duplo: uma captura em base64 pesa centenas de KB, e
reenviá-la a cada turno multiplicaria o custo em tokens e estouraria a cota de
10 MB do `chrome.storage.local`. A marca existe para o modelo saber que houve
uma imagem e poder pedir de novo, em vez de responder no chute.

### O modelo enxerga?

| Provedor | Como se sabe |
|---|---|
| Claude (Anthropic) | `yes` — a família inteira aceita imagem |
| OpenRouter | o catálogo publica `input_modalities` por modelo |
| Qualquer outro endpoint | `unknown` |

Com `no` **confirmado**, o anexo é bloqueado e o botão de enviar explica por quê:
a chamada falharia ou, pior, o modelo responderia ignorando a imagem em silêncio.
Com `unknown` a extensão avisa mas deixa enviar — dizer "não" a um gateway
próprio ou a um modelo recém-lançado que enxerga bem seria pior que o aviso.

### Isolamento e imagens

O canário de vazamento passou a serializar o payload **trocando o base64 por um
marcador**. O alfabeto do base64 inclui `/`, então uma imagem grande pode conter
por puro acaso algo com a forma `dono/projeto` e abortar o turno com um vazamento
que nunca existiu. De quebra, evita varrer megabytes com regex a cada passo.

---

## Aparência

A paleta segue o [Lovable](https://lovable.dev): laranja `#FE7B02`, azul
`#4B73FF`, rosa `#EA8AAB`. Botões primários usam o gradiente laranja→rosa da
logo, e o anel de carregamento é um gradiente cônico nas três cores — cônico
porque precisa dar a volta no círculo, e recortado por máscara radial porque
borda não aceita gradiente.

### Contraste do texto da IA

As superfícies são translúcidas para o brilho passar por trás, mas **texto
corrido não**: a resposta da IA fica sobre `ink-850` (90% opaco) com texto
`ink-100`, ~15:1 de contraste. Sem essa superfície, a mesma frase mudava de
legibilidade conforme o cursor passava atrás dela.

### Markdown

A resposta da IA é renderizada com títulos, listas, citações, régua, negrito,
ênfase, código inline e blocos de código. O parser (`src/lib/markdown.ts`) é
próprio e não conhece React — devolve estrutura, e quem desenha é o componente,
o que permite testar a gramática inteira sem montar nada na tela.

Nada vira HTML por string: cada trecho vira elemento React. Resposta de modelo é
texto de terceiro, e `dangerouslySetInnerHTML` transformaria uma resposta hostil
em execução dentro da extensão. Link com protocolo fora de `http(s)` vira texto,
nunca algo clicável.

O fundo é vidro: as superfícies são translúcidas e, atrás delas, um brilho
radial nas cores da marca segue o cursor. A posição chega por variável CSS
atualizada dentro de um `requestAnimationFrame` — guardá-la em estado do React
re-renderizaria a árvore a cada pixel de movimento do mouse. O efeito respeita
`prefers-reduced-motion`.

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
   │  ├─ validate.ts          valida a chave e lista os modelos da conta
   │  └─ registry.ts          fábrica de provedores
   ├─ mcp/
   │  ├─ protocol.ts          JSON-RPC, SSE, namespace de ferramentas
   │  ├─ client.ts            transporte Streamable HTTP
   │  ├─ auth.ts              descoberta, registro dinâmico, PKCE
   │  ├─ registry.ts          cadastro e escopo por repositório
   │  └─ types.ts
   ├─ telemetry/
   │  ├─ classify.ts          bug vs. configuração vs. transitório
   │  ├─ redact.ts            redação antes de publicar
   │  ├─ fingerprint.ts       agrupamento estável de ocorrências
   │  ├─ format.ts            título, corpo e labels do issue
   │  ├─ issues.ts            Issues API (labels, dedupe, comentário)
   │  └─ reporter.ts          fila, janela de desfazer, cotas
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
| `npm test` | suíte Vitest (isolamento, mapeamento, escrita, diff, streaming, relato de erros, MCP) |
| `npm run test:ci` | a suíte + o piso de `.github/test-floor.json` — o que o CI roda |
| `npm run typecheck` | só o `tsc --noEmit` |

### Piso de testes

`.github/test-floor.json` guarda a contagem mínima de testes e de arquivos de
teste. O CI reprova se a suíte encolher. Adicionar testes não exige mexer no
arquivo; **só reduzir exige** — e aí a redução vira uma decisão explícita,
visível no diff.

Isso existe por um motivo concreto: um agente pediu para "remover complexidade
desnecessária", apagou 8 arquivos de teste, e o CI passou — os 9 que sobraram
rodaram e passaram. Apagar teste é a forma mais silenciosa de ficar verde.

O workflow `.github/workflows/build.yml` roda exatamente `npm run test:ci` e
`npm run build` — o que reprova localmente reprova no CI, e vice-versa. Ele ainda
confere que todo caminho citado no `manifest.json` existe no `dist/`, porque um
manifest apontando para arquivo inexistente só falha na hora de carregar a
extensão.

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
