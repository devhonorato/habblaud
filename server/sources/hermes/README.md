# Fonte do Hermes Agent

Mostra no escritório os perfis do [Hermes Agent](https://github.com/NousResearch/hermes-agent) (NousResearch): cada
perfil vira uma **sala** com um agente principal **permanente** (o "funcionário" do perfil), que não sai entre uma
rotina do cron e outra.

## Ligar

| Variável | O quê |
| --- | --- |
| `HABBLAUD_HERMES_DIR` | Diretório de dados do Hermes (no container dele, `/opt/data`; no host, a pasta montada lá). Sem ela, a fonte fica desligada. |
| `HABBLAUD_OMNIROUTE_URL` | (Opcional) Link "Abrir o OmniRoute" na aba Cotas de IA. |
| `HABBLAUD_BESZEL_URL` | (Opcional) Link "Abrir o Beszel" na aba Servidor. |
| `HABBLAUD_HERMES_SALAS` | (Opcional) Nome exibido da sala de cada perfil: `crypto=Kairo,finance=Finanças`. Ver "Nomes da sala e dos agentes". |
| `HABBLAUD_HERMES_NOMES` | (Opcional) Nome do agente principal (`perfil`) e do Vigia de uma rotina (`perfil/<rotina>`): `crypto=Hermes,crypto/vigia-mercado=Sentinela,finance=Atlas`. |
| `HABBLAUD_HERMES_LEITURAS_DIAS` | (Opcional) Dias de leituras do monitor guardadas pelo Habblaud (padrão `7`; `0` desliga). Ver "Histórico das leituras". |
| `HABBLAUD_CLIMA` | `0` desliga o tempo lá fora (open-meteo, sem chave, no máximo a cada 10 min). Lugar: `HABBLAUD_CLIMA_LAT`, `HABBLAUD_CLIMA_LON`, `HABBLAUD_CLIMA_LOCAL` (padrão: São Paulo). |

No Docker, monte o diretório **só para leitura** (ex.: `-v /srv/ai/apps/hermes/data:/hermes:ro` e
`HABBLAUD_HERMES_DIR=/hermes`). Sem nenhuma conta do Claude Code nem do Codex o servidor sobe normalmente, só com o
Hermes (o aviso "Nenhuma pasta do Claude Code" vira informação). Recomendado no container: `HABBLAUD_WORLD=0` (ver
Limitações).

## O que é lido (nada é escrito)

Nada é escrito no diretório do Hermes. O Habblaud só escreve no diretório de dados dele (`HABBLAUD_DATA_DIR`): as
cópias dos bancos em `hermes-cache/` (último recurso, abaixo) e o histórico das leituras em `hermes-leituras/`.

| Arquivo (por perfil) | Para quê |
| --- | --- |
| `profiles/<perfil>/` (e a raiz, como perfil `default`, se tiver `state.db` ou `cron/`) | Descoberta dos perfis, a cada 10 s |
| `state.db` → `sessions`, `messages` | Atividades (cursor pelo `id` da mensagem), título, modelo, tokens, custo, subagentes |
| `cron/executions.db` → `executions` | Rotina rodando agora (`status` `claimed`/`running`) |
| `cron/jobs.json` | Nome das rotinas; rotina que falhou (`last_status` + `last_error`) |
| `gateway_state.json` | Gateway rodando ou não (`gateway_state`) |
| `cron/ticker_heartbeat` | Sem o `gateway_state.json`: batimento do agendador (parado há mais de 10 min = gateway parado) |
| `profile.yaml` | `description:` (título do agente quando não há sessão; aba Equipe) |
| `cron/executions.db` → execuções terminadas das rotinas com monitor | Checagens do Vigia (curtas = sem mudança) |
| `cron/output/<job>/*.md` | Terminal (rodadas que já saíram da janela do banco), terminal do Vigia, aba Conversas |
| `cron/output/<job>/monitor_last_output.txt` | Última leitura do monitor: terminal do Vigia, aba Mercado, efeitos da sala |
| `cron/usage_audit.jsonl` (últimos 4 MB) | Tokens e rodadas do dia (UTC) |
| `state.db` → `session_model_usage` | Chamadas e tokens do dia por modelo, provedor e tarefa |
| `logs/agent.log` (raiz e `profiles/<perfil>/logs/`, últimos 3 MB) | Chamadas por modelo/provedor (`API call #N: model=… provider=…`) e limites (`RateLimitError`, `429`, cota) do dia |
| `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`, `/sys/class/thermal/*/temp`, `statfs(HABBLAUD_HERMES_DIR)` | O computador (aba Servidor) |

**SQLite.** Lido com o `node:sqlite` do próprio Node (22.13+ sem flag; o Dockerfile usa o 24): nada de dependência
nativa. O aviso "ExperimentalWarning" do módulo é engolido ao carregar. Cada leitura abre, consulta e fecha, e só
acontece quando o tamanho ou a hora do banco (ou do `-wal`) mudaram. O jeito de abrir depende do que existe ao lado do
banco (`sqlite.ts`):

- `-wal` e `-shm` presentes (Hermes rodando): abre direto com `readOnly`. Vê o que ainda está só no WAL; com a pasta
  montada `:ro` o SQLite lê o índice do WAL na memória. Testado no `node:24-alpine`, usuário `10000:10000`,
  `--read-only` e a pasta `:ro`, com outro processo gravando: as mensagens novas aparecem a cada segundo e nada é
  criado na pasta;
- sem `-wal` (Hermes parado): `file:...?immutable=1` (abrir direto criaria `-wal`/`-shm` ou falharia numa pasta só
  leitura);
- se nada disso der (ex.: Node 22, que não aceita URI no SQLite): copia o banco e o `-wal` para `<HABBLAUD_DATA_DIR>/hermes-cache`
  e lê a cópia (refeita só quando os arquivos mudam; apagada ao parar).

Banco ausente, ocupado ou ilegível não derruba nada: o perfil continua na sala e o motivo vai para `/api/health`
(`sources[].error`).

## Nomes da sala e dos agentes

A sala de um perfil continua identificada pela pasta dele (`profiles/<perfil>`): mudar o nome não muda a vaga, o
histórico nem o personagem guardado. As duas variáveis aceitam pares `chave=valor` separados por vírgula (ou ponto e
vírgula); pares fora do formato são ignorados com um aviso no log.

**Sala (`HABBLAUD_HERMES_SALAS`).** `crypto=Kairo` faz a sala do perfil `crypto` aparecer como "Kairo" na placa, na
barra lateral, no feed, nos avisos ("chegou em Kairo"), na gaveta do agente, no histórico do terminal e na janela do
Hermes (abas Equipe, Conversas, Cotas e Mercado; a aba Equipe mostra "sala Kairo (perfil crypto)"). Até 40
caracteres. O nome entra como o padrão da pasta (`RoomAliases.setDefault`, o mesmo mecanismo que chama a pasta de
assets de "Arquiteto"), então o **Renomear** do menu da sala (guardado em `rooms.json`) vale por cima; apagar o nome
escolhido no menu volta ao da variável.

**Agentes (`HABBLAUD_HERMES_NOMES`).** A chave `perfil` dá o nome do agente principal; `perfil/<rotina>` (o nome da
rotina no `jobs.json`, ex. `vigia-mercado`, ou o id dela) dá o nome do Vigia daquela rotina. Um `:f` ou `:m` no fim
do nome escolhe o visual (`Sentinela:f`); sem ele, vale o do nome se ele for do pool de nomes do Habblaud (Ana = `f`),
senão `m`. O visual continua estável: a semente da aparência é a do id do agente (`hermes:<perfil>`), que não muda
entre execuções nem reinícios.

Precedência do nome de um agente do Hermes (`Office.addMain`):

1. o personagem feito no **editor de personagem** (`names.json`, por sala), quando a dona dele é este agente — vale
   também depois de reiniciar o servidor;
2. o nome de `HABBLAUD_HERMES_NOMES`;
3. sem nada configurado: o principal recebe o nome sorteado (e guardado por sessão em `names.json`), o Vigia
   "Vigia".

"Voltar ao sorteio" no editor apaga o personagem e volta ao nome configurado (ou ao sorteio, sem configuração).
Nomes são únicos no escritório (sem diferenciar maiúsculas): a variável ignora um nome repetido (fica o primeiro), e um
nome configurado que já está em uso por outro agente (ou é o personagem do editor de outra sala) ganha a sala entre
parênteses, como o "Vigia" já fazia ("Hermes (Kairo)"). O editor recusa um nome em uso, como antes.



| Status | Quando |
| --- | --- |
| `working` | Rotina do cron rodando há mais de 3 s (as checagens do monitor que não acham mudança duram menos e não acordam ninguém; marcas com mais de 3 h são sobra de crash) **ou** mensagem nova nos últimos 60 s numa sessão que não terminou o turno |
| `waiting` | A última chamada é um `clarify` (pergunta a você) sem resposta ("responder uma pergunta") |
| `offline` | Gateway parado (`gateway_state.json` diferente de `running`; sem ele, batimento parado há mais de 10 min). O personagem sai pelo elevador e volta com o gateway (ou com uma mensagem nova) |
| `idle` | O resto |

Título: `Rotina: <nome>` da rotina rodando (ou a da última sessão), senão o título da sessão, senão a descrição do
perfil. Números (ferramentas, tokens, custo) e modelo: os da sessão mais recente.

## Atividades

Mensagens novas (polling de ~1 s; no boot, as últimas 80 de cada perfil entram só como histórico), em `describe.ts`:

| Mensagem | Atividade |
| --- | --- |
| `user` de rotina do cron | `prompt` "Rotina: vigia-mercado" |
| `user` de conversa | `prompt` "Nova tarefa: …" |
| `assistant.reasoning` | `think` "Pensando…" (o raciocínio no detalhe) |
| `assistant.tool_calls` | uma por chamada; `tool_call` (MCP carregada sob demanda) é descrita pela ferramenta de dentro |
| `assistant` com `finish_reason` `stop` | `respond` + `done` "Concluiu em 27s"; `[SILENT]` = "Nada a relatar" |
| `tool` com erro | `error` "Erro em kairo_criar_instancia" (`{"error": …}`, ferramenta inexistente, `exit_code` ≠ 0) |
| rotina com `last_status` de erro no `jobs.json` | `error` "Rotina falhou: <nome>" |

Ferramentas: `mcp__kairo__kairo_*`/`mcp_kairo_*`/`kairo_*` → `mcp` com rótulo próprio ("Consultando estado do
mandato", "Lendo o radar", "Lendo os eventos do Kairo", "Rodando backtest de UNIUSDT", "Criando instância UNIUSDT",
"Encerrando instância …", "Conferindo o sinal de …"); outros MCP → o texto do Claude Code (GitHub, navegador, banco...);
`terminal` → o mesmo resumo do Bash (`run`, `test`, `git`...); `read_file` → `read`; `write_file`/`patch` →
`write`/`edit`; `search_files` → `search`; `web_*` → `web`; `browser_*` → `browser`; `delegate_task` → `delegate`;
`skill_*` → `skill`; `tool_search`/`tool_describe` → "Procurando ferramentas". Textos até 46 caracteres, detalhes até
300, segredos mascarados (`maskSecrets`).

Sessões filhas (`parent_session_id`, ex.: `delegate_task`) viram **subagentes** enquanto não terminam (e entregam ao
terminar ou depois de 5 min sem mensagem). A amostra usada no desenvolvimento não tinha nenhuma; a tabela
`async_delegations` ainda não é lida.

## Vigia

Cada rotina com `monitor_script` ou `monitor_url` no `jobs.json` (ex.: `vigia-mercado`) ganha um segundo agente
**permanente** na sala do perfil, chamado "Vigia" (ou o nome de `HABBLAUD_HERMES_NOMES`; papel "Vigia do mercado" quando o nome da rotina fala de mercado ou
Kairo; senão "Vigia da rotina <nome>"; se já houver outro "Vigia", vira "Vigia (<sala>)"). Ele fica ocioso (ou sai com
o gateway parado) e:

| Quando | O quê |
| --- | --- |
| Execução terminada da rotina no `executions.db` | "Checagem: sem mudança" (ou "mudou, chamou o agente"/"falhou"), **só no histórico dele** |
| Sessão nova do cron daquela rotina (o pedido traz a diferença do monitor) | "Chamou <principal>: <motivo>" **no feed**; motivo = a linha nova mais importante da diferença ("evento VENDA", "CRCLBUSDT 1h sem posição (+2)") |
| `monitor_last_output.txt` mudou | "Leitura nova do monitor", só no histórico; no Kairo, festa na sala com uma venda com lucro (posição positiva que fechou) e alarme com o mandato desligado ou um evento de pausa/risco/perda |

O terminal do Vigia mostra cada checagem (com a diferença, quando chamou o principal) e, por último, a leitura
completa do monitor (radar, instâncias, posições, eventos, avisos).

### Histórico das leituras

O Hermes só guarda a última leitura (`monitor_last_output.txt`, reescrito a cada checagem). O Habblaud guarda uma
cópia de cada checagem que viu (`readings.ts`) em
`<HABBLAUD_DATA_DIR>/hermes-leituras/<perfil>/<id da rotina>/<AAAA-MM-DD>.jsonl` (dia UTC), uma linha por checagem:

- `{"at": <hora da leitura, ms>, "sig": "<hash>", "lines": [...]}` quando o conteúdo mudou (e sempre na primeira linha
  de cada dia, para cada arquivo se ler sozinho);
- `{"at": ..., "sig": ..., "same": true}` quando é igual à anterior: fica a hora da checagem, sem repetir o conteúdo.

A hora é a do arquivo do monitor; a mesma hora não entra duas vezes (nem depois de reiniciar). As linhas já saem com
os segredos mascarados. Os dias mais velhos que `HABBLAUD_HERMES_LEITURAS_DIAS` (padrão 7) são apagados ao subir e a
cada hora; `0` desliga a gravação. Se o arquivo de um dia passar de 32 MB, o resto do dia não é guardado (aviso no log). Se a pasta cair
dentro do diretório do Hermes, a gravação fica desligada.

No terminal do Vigia, cada checagem (as saídas do cron) abre em **detalhes** a diferença para a leitura anterior (a do
Hermes, quando chamou o principal; senão a calculada pelas linhas que saíram e entraram) e a leitura completa daquela
hora ("igual à anterior" quando não mudou). A checagem casa com a leitura guardada mais próxima até 2 min; ao vivo,
uma checagem nova espera até 20 s pela leitura. Só há leitura para as checagens vistas com o Habblaud ligado.

## Terminal e histórico

O terminal do Habblaud segue arquivos JSONL; a conversa do Hermes está no SQLite. A fonte implementa
`AgentSource.terminalFeed` (`server/sources/source.ts`), um provedor de conversa sem arquivo que o terminal usa no lugar
do transcript (`terminal.ts`):

- principal: as últimas 1.200 mensagens do `state.db` (começando no início de uma sessão) e, antes delas, as rodadas
  das saídas do cron (`## Prompt`, a diferença do monitor e `## Response`); cada sessão abre com um cabeçalho (rotina
  ou conversa, sessão, modelo, início, duração). O pedido sai sem o aviso padrão do Hermes ("[IMPORTANT: …]"); cada
  chamada mostra os argumentos e o resultado (sem o envelope `<untrusted_tool_result>`; o JSON de `{"result": "…"}`
  indentado; erros em vermelho); o raciocínio e a resposta final completos; `[SILENT]` = "Nada a relatar". Ao vivo,
  só as mensagens novas (o banco relido quando ele ou o `-wal` mudam);
- histórico do terminal (`/api/sessions/recent`): as sessões dos últimos dias de todos os perfis
  (`sessionId` = `<perfil>~<id da sessão>`), abertas pelo mesmo conversor (`HistoryProvider` da fonte).

## Painel (`GET /api/hermes/painel`)

`HermesSource.panel()` (cache de 5 s; tipos em `shared/hermes.ts`): o computador, as cotas do dia (UTC), as rotinas
de cada perfil, as últimas 30 saídas, as leituras dos monitores (com o mercado do Kairo já separado em mandato,
instâncias, radar, eventos e avisos), o tempo lá fora e os links. Sem a trava do terminal (ex.: celular sem
`terminal` liberado), as respostas das rotinas ficam de fora. No cliente (`client/src/ui/hermes.ts`):

- **cartão "Hermes · IA hoje"** na barra de uso (no lugar das janelas de 5 h/semana, que o Hermes não tem): chamadas e
  tokens do dia e o estado (OmniRoute ativo, limites hoje, 429 há pouco); clique abre Cotas de IA;
- **janela "Servidor do Hermes"**: botão do computador na barra superior, clique no **computador (balcão) da
  recepção**, na **TV do lounge** (aba Mercado), no **quadro branco** da sala de um perfil (aba Equipe daquele perfil)
  e o botão "Rotinas, conversas e cotas" na gaveta de um agente do Hermes. Abas: Servidor (CPU, RAM, disco,
  temperatura, carga, ligado há), Cotas de IA (chamadas por modelo/provedor, uso por tarefa, limites/429 do dia),
  Equipe (descrição, estado, tokens de hoje e rotinas com próxima/última execução, status, erro, pausada e monitor),
  Conversas (a resposta completa de cada rodada) e Mercado;
- **janelas e relógios** do escritório: o tempo lá fora e a hora, num aviso rápido.

No container, `/proc/loadavg` e `/proc/meminfo` mostram a carga e a memória do computador (o kernel é o mesmo); o
uso de CPU é amostrado entre duas leituras (sem amostra, a carga de 1 min dividida pelos núcleos); o disco é o da
pasta montada; a temperatura só aparece se `/sys/class/thermal` estiver visível.

## Limitações

- **Provedor real atrás do OmniRoute:** o combo "kairo" aparece como `model=kairo provider=custom`. O provedor de
  verdade só aparece se o log tiver `upstream=`/`routed_to=`/`served_by=` (lido quando houver); senão, o detalhe por
  provedor fica no painel do próprio OmniRoute (link).
- A amostra usada no desenvolvimento não tinha `logs/agent.log`; a leitura dele segue o formato do escritório antigo
  (`API call #N: model=… provider=…` e `WARNING … RateLimitError …`) e, sem log, as chamadas vêm do
  `session_model_usage`.
- **Habblaud World:** o protocolo do mundo só conhece `claude` e `codex`; a projeção (`shared/world/projection.ts`, não
  alterada) mandaria os agentes do Hermes como `claude`. Até o protocolo ganhar o Hermes, use `HABBLAUD_WORLD=0` onde a
  fonte estiver ligada.
- Sem uso de plano (5h/semanal): o cartão da conta "Hermes" mostra as cotas de IA do dia, sem barras de limite (os
  limites dos provedores não são publicados no diretório do Hermes).
- Sem `HABBLAUD_HERMES_SALAS`, o nome da sala é o do perfil; a descrição do `profile.yaml` vai no título do agente.
- O editor de personagem guarda **um** personagem por sala (`names.json`), e o principal e o Vigia dividem a sala do
  perfil: se os dois forem editados, o último fica com o personagem e o outro, depois de reiniciar, volta ao nome
  configurado (ou ao sorteado).
