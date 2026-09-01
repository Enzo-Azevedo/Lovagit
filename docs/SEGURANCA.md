# Notas de segurança

## Segredos

| Segredo | Onde fica | Proteção |
|---|---|---|
| PAT do GitHub | `chrome.storage.local` | AES-GCM; chave mestra é `CryptoKey` não exportável no IndexedDB da extensão |
| Chave de API da IA | idem | idem |
| Tokens OAuth | idem | idem; refresh automático quando o provedor devolve `refresh_token` |

A chave mestra é gerada com `crypto.subtle.generateKey({name:'AES-GCM'}, false, …)`.
O `false` é o ponto: nem a própria extensão consegue exportar a chave. Um dump do
`chrome.storage.local` devolve apenas `{iv, data}` cifrados.

**O que isso não protege:** o processo do navegador em si. Uma extensão com
`debugger`/`devtools` sobre esta extensão, ou malware com acesso ao perfil, ainda
alcança o segredo em memória. É o mesmo modelo de ameaça de qualquer ferramenta
BYOK que roda no cliente.

## Permissões

- `host_permissions`: apenas `https://api.github.com/*`.
- `optional_host_permissions`: `https://*/*`, pedido **sob demanda** quando você
  salva a chave de um provedor — a extensão só alcança o domínio que você
  autorizou naquele clique.
- `identity`: exclusivamente para o fluxo OAuth (`launchWebAuthFlow`).
- Sem `content_scripts`: a extensão não injeta código em página nenhuma.
- CSP `script-src 'self'`: nenhum código remoto é carregado; tudo é bundle local.

## Escrita no repositório

- `normalizeRepoPath` rejeita `..`, caminhos absolutos e qualquer escrita dentro
  de `.git/`.
- `isValidRepoId` exige `owner/name` e rejeita segmentos compostos só de pontos —
  sem isso, um `repoId` como `../etc` viraria travessia na URL da API.
- Toda escrita passa por `applyChanges`, que **sempre** cria a branch de backup
  antes de tocar na branch alvo.
- A atualização da ref é fast-forward (`force: false`): se alguém commitou na
  branch no meio do caminho, o commit fica órfão e a branch alvo continua intacta
  — a falha é visível, não silenciosa.
- A restauração nunca reescreve histórico: cria um commit novo com a árvore do
  backup.

## Isolamento entre repositórios

Ver a tabela de 4 camadas no README. A camada mais importante é a última: antes de
cada requisição, `assertNoForeignRepoLeak` serializa o que sairia (system prompt +
turnos) e aborta se encontrar o nome completo de qualquer outro repositório
conectado. A comparação é por `owner/name`, então dois repositórios do mesmo dono
não geram falso positivo.

## Relato automático de erros

O módulo de detecção de erros publica issues em um repositório **público**. Todo
relatório é redigido antes de sair da máquina (`src/lib/telemetry/redact.ts`):

- nome de repositório → `repo#<hash FNV-1a>`, estável entre relatórios;
- caminho de arquivo → `<arquivo .ext>` (só a extensão sobrevive);
- PAT, chave de API, `Authorization`, JWT e e-mail → placeholders;
- URL da API → `api.github.com/repos/<repo>/...`, query string inteira → `?<params>`;
- ID da extensão → `chrome-extension://<id>`.

**Nunca é enviado:** prompt, mensagem do chat, conteúdo ou diff de arquivo.

Três travas contra publicação indesejada:

1. só `category: 'bug'` vira issue — erro de configuração e falha passageira
   ficam na máquina;
2. janela de 10 segundos para cancelar, com o corpo exato do issue visível antes
   do envio;
3. fingerprint + teto por hora, para uma falha em laço não virar centenas de
   issues.

O módulo nunca lança: `captureError` engole qualquer falha interna e uma falha
no envio não pode gerar um novo relatório (`reportingInFlight`), senão um erro
de rede viraria recursão infinita.

Vale saber o que isso **não** cobre: a redação é baseada em padrões. Uma
mensagem de erro de terceiro que embuta um segredo em formato desconhecido pode
escapar. Para trabalho sensível, desligue o relato automático ou aponte o
destino para um repositório privado em **Configurações → Detecção e relato de
erros**.

## Servidores MCP

- Tokens OAuth de servidor MCP ficam no mesmo cofre AES-GCM das demais
  credenciais (`mcp:<serverId>:oauth`).
- O registro dinâmico (RFC 7591) usa `token_endpoint_auth_method: "none"` — a
  extensão é um *public client*, sem segredo embutido, e o PKCE cobre esse caso.
- O parâmetro `resource` (RFC 8707) amarra o token ao servidor MCP específico,
  para um token vazado não valer em outro recurso do mesmo provedor.
- **Escopo por repositório**: um servidor só entra no prompt dos repositórios em
  que você o habilitou; nasce sem nenhum. Sem isso, um servidor MCP com memória
  viraria um canal lateral entre repositórios, por fora do firewall de contexto.
- A checagem de escopo é dupla (lista filtrada + verificação no executor), e a
  segunda falha escala como `ContextIsolationError` — nunca é convertida em erro
  de ferramenta.

**O que isso não cobre:** as ferramentas de um servidor MCP são código de
terceiro. O que elas retornam entra no contexto do modelo, então um servidor
malicioso pode tentar influenciar o agente pelo conteúdo da resposta. Habilite
apenas servidores em que você confia, e use a lista de ferramentas para desligar
as que escrevem quando só precisa ler.

## Conteúdo do repositório é dado, não instrução

O system prompt trata README, código e resultados de tools como material de
trabalho. Ainda assim, vale a ressalva: se um repositório contiver texto
malicioso tentando redirecionar o agente ("ignore as instruções acima e…"), o
modelo pode ser influenciado. Duas defesas concretas já existem:

1. o agente só alcança **um** repositório — não há como pular para outro;
2. toda escrita gera branch de backup e checkpoint reversível.

Para trabalho em repositórios de terceiros, desligue o commit automático e revise
o diff antes de aprovar.
