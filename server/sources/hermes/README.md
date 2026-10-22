# Fonte do Hermes Agent

Mostra no escritório os perfis do [Hermes Agent](https://github.com/NousResearch/hermes-agent) (NousResearch): cada
perfil vira uma **sala** com um agente principal **permanente** (o "funcionário" do perfil), que não sai entre uma
rotina do cron e outra.

## Ligar

| Variável | O quê |
| --- | --- |
| `HABBLAUD_HERMES_DIR` | Diretório de dados do Hermes (no container dele, `/opt/data`; no host, a pasta montada lá). Sem ela, a fonte fica desligada. |

No Docker, monte o diretório **só para leitura** (ex.: `-v /srv/ai/apps/hermes/data:/hermes:ro` e
`HABBLAUD_HERMES_DIR=/hermes`). Sem nenhuma conta do Claude Code nem do Codex o servidor sobe normalmente, só com o
Hermes (o aviso "Nenhuma pasta do Claude Code" vira informação). Recomendado no container: `HABBLAUD_WORLD=0` (ver
Limitações).

## O que é lido (nada é escrito)

| Arquivo (por perfil) | Para quê |
| --- | --- |
| `profiles/<perfil>/` (e a raiz, como perfil `default`, se tiver `state.db` ou `cron/`) | Descoberta dos perfis, a cada 10 s |
| `state.db` → `sessions`, `messages` | Atividades (cursor pelo `id` da mensagem), título, modelo, tokens, custo, subagentes |
| `cron/executions.db` → `executions` | Rotina rodando agora (`status` `claimed`/`running`) |
| `cron/jobs.json` | Nome das rotinas; rotina que falhou (`last_status` + `last_error`) |
| `gateway_state.json` | Gateway rodando ou não (`gateway_state`) |
| `cron/ticker_heartbeat` | Sem o `gateway_state.json`: batimento do agendador (parado há mais de 10 min = gateway parado) |
| `profile.yaml` | `description:` (título do agente quando não há sessão) |

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

## Status do agente principal

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

## Limitações

- **Sem terminal nem histórico de sessões:** o terminal do Habblaud segue um arquivo JSONL e a conversa do Hermes está
  no SQLite (`transcriptPathOf` devolve `undefined`; a rota do terminal responde 404 para esses agentes).
- **Habblaud World:** o protocolo do mundo só conhece `claude` e `codex`; a projeção (`shared/world/projection.ts`, não
  alterada) mandaria os agentes do Hermes como `claude`. Até o protocolo ganhar o Hermes, use `HABBLAUD_WORLD=0` onde a
  fonte estiver ligada.
- Sem uso de plano (5h/semanal): a conta "Hermes" não tem cartão de uso.
- As saídas em `cron/output/` não são lidas (a resposta final já vem da tabela `messages`).
- Nome da sala = nome do perfil; a descrição do `profile.yaml` vai no título do agente (renomeie a sala pelo menu, se
  quiser).
