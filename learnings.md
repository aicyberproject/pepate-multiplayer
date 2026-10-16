# Learnings, memória de aprendizados do agente

Registro de lições de execuções passadas neste projeto. Cada entrada descreve um
erro real e como evitá-lo. Mantenha limpo: remova o que virou convenção fixa ou
ficou obsoleto.

---

## [2026-08-10] Script de teste fora do projeto não resolve `ws`

Contexto: ppt-multiplayer, Node.js 24, dependência `ws` instalada apenas em
`node_modules/` na raiz do projeto.
Problema: um script de smoke test escrito em diretório temporário falhou com
`Error: Cannot find module 'ws'`.
Causa raiz: a resolução de módulos do Node sobe a árvore de diretórios a partir
do arquivo que faz o `require`, não a partir do diretório de trabalho. Um script
em `/tmp` nunca alcança o `node_modules/` do projeto, mesmo rodando com `cd` no
projeto.
Resolução: `NODE_PATH=<raiz>/node_modules node /caminho/script.js`.
Prevenção: escrever scripts auxiliares dentro da árvore do projeto, ou exportar
`NODE_PATH` explicitamente ao rodá-los de fora.
Arquivos afetados: nenhum do repositório; apenas script auxiliar descartável.

---

## [2026-08-10] `.gitignore` do projeto ignora `.claude` — confirmar antes de publicar

Contexto: primeira publicação do repositório em
`github.com/aicyberproject/pedra-papel-tesoura`.
Problema: risco de subir `.claude/settings.local.json` (configuração local do
agente) junto com o código-fonte, poluindo o repositório público.
Causa raiz: diretórios de ferramentas de IA são gerados no meio do projeto e
passam despercebidos no primeiro `git add .`.
Resolução: o `.gitignore` já cobria `.claude`, `.gemini` e `.opencode`. Foi
confirmado com `git status --porcelain` antes do primeiro commit.
Prevenção: em qualquer primeira publicação, conferir a lista completa de
arquivos rastreados (`git ls-files`) antes do push, e não apenas confiar no
`.gitignore`.
Arquivos afetados: `.gitignore`.

---

## [2026-08-10] Estado das salas é só em memória

Contexto: `server.js`, `rooms` é um `Map` no processo.
Problema: não é um bug, mas uma restrição fácil de esquecer. Reiniciar o
servidor derruba todas as salas em andamento, e nenhuma instância adicional
compartilha estado.
Causa raiz: decisão de projeto — sem banco, sem cache externo.
Resolução: documentado no `README.md`.
Prevenção: antes de propor deploy com múltiplas réplicas ou autoscaling,
lembrar que o WebSocket exige sessão presa à instância (sticky session) ou um
backend de estado compartilhado. Qualquer feature de persistência precisa desta
decisão resolvida primeiro.
Arquivos afetados: `server.js`, `README.md`.

---

## [2026-08-10] `data/` criado por root deixa o SQLite somente-leitura e derrubava o servidor

Contexto: primeira execução com persistência; `data/` e `data/ppt.sqlite` ficaram
com dono `root:root` de um start anterior feito com privilégio elevado.
Problema: rodando como usuário comum, o servidor subia normalmente, aceitava
partidas e só morria no primeiro encerramento de partida, com
`Error: attempt to write a readonly database`. Todas as salas caíam junto.
Causa raiz: duas falhas somadas. (1) O dono do arquivo impedia a escrita.
(2) O `try/catch` de `db.js` cobria apenas o `init()`; qualquer erro de escrita em
runtime subia como exceção não tratada de dentro do handler de WebSocket e
encerrava o processo.
Resolução: `chown` no diretório e um wrapper `guard()` em `db.js` que envolve
todas as operações do store, devolve valor neutro e registra o erro no log.
Prevenção: tratar persistência como best-effort — nenhuma operação de banco deve
poder derrubar o loop de jogo. Ao verificar features de gravação, testar também o
caminho de falha (banco somente-leitura), não só o caminho feliz. Erro que só
aparece na primeira gravação passa por qualquer smoke test que não conclua uma
partida.
Arquivos afetados: `db.js`, `data/`.

---

## [2026-08-10] `pkill -f "server.js"` matou um processo não relacionado

Contexto: limpeza de servidores de teste locais na porta 8099.
Problema: `pkill -9 -f "server.js"` derrubou também
`/home/stenio/bingo-server/server.js`, um serviço sem relação com este projeto
(o pm2 o reiniciou automaticamente, sem dano permanente).
Causa raiz: `server.js` é um nome genérico; o padrão do `pkill -f` casa com a
linha de comando inteira de qualquer processo do usuário.
Resolução: matar pelo PID resolvido a partir da porta —
`ss -ltnp | grep ':<porta>' | grep -oP 'pid=\K[0-9]+'`.
Prevenção: nunca usar `pkill -f` com nome de arquivo genérico nesta máquina, que
hospeda vários serviços Node. Preferir a porta como identificador, e conferir com
`pgrep -af` antes de matar.
Arquivos afetados: nenhum.

---

## [2026-08-10] Fallback silencioso do SQLite quebrava o estado global entre replicas

Contexto: rota de escalonamento com Redis; duas replicas do servidor na mesma
maquina, compartilhando `data/ppt.sqlite`.
Problema: um ban global emitido pela replica B era aceito (`ok: true`) mas nao
bloqueava a entrada pela replica A, e a tabela `bans` do arquivo ficava vazia.
Causa raiz: com as replicas subindo juntas, uma colidia no `CREATE TABLE`
(`database is locked`) e o `catch` largo do `db.js` a rebaixava **em silencio**
para o backend JSON em memoria. As duas passavam a ter placar e lista de bans
proprios. Como e uma corrida, num start limpo as duas escolhiam sqlite e o
problema sumia.
Resolucao: `PRAGMA busy_timeout` antes de `PRAGMA journal_mode = WAL` (na ordem
inversa o timeout nao vale para a propria troca de modo), e um `console.warn`
explicito quando o fallback acontece. Validado com 5 replicas simultaneas em 3
execucoes: 5/5 em sqlite.
Prevencao: um `catch` que troca de backend nunca pode ser silencioso. E ao
compartilhar estado entre processos, verificar **todas** as camadas: aqui as salas
foram para o Redis, mas a persistencia continuou single-process, e o furo so
apareceu num teste que exercitava ban global cruzado.
Arquivos afetados: `db.js`, `DEPLOY.md`.

---

## [2026-08-10] Verificar o ambiente antes de confiar no resumo de uma execucao

Contexto: recebi um resumo afirmando que havia replicas Redis ativas em :8081 e
:8082, Redis em :6379, e quatro arquivos de teste com todos os checks passando.
Problema: nada disso correspondia a maquina. Redis nao estava instalado, a 8081
nao tinha ninguem escutando, a 8080 era o `bingo-server` e a 8082 era um container
Docker de outro projeto. Os quatro arquivos de teste nao existiam no repositorio,
e o `ioredis` estava declarado no `package.json` mas nao instalado, entao o modo
Redis nem iniciava.
Causa raiz: resumo escrito a partir de um ambiente diferente do atual, sem
reconferir o estado final.
Resolucao: checar porta a porta (`ss` + `curl` para ver **o que** responde, nao so
se responde), conferir `node_modules` alem do `package.json`, e reescrever os
testes que faltavam.
Prevencao: antes de afirmar que servicos estao no ar, identificar o que atende em
cada porta — portas ocupadas por outros projetos dao falso positivo facil. E
tratar "os testes passaram" como nao verificado enquanto os testes nao estiverem
no repositorio e rodarem de novo.
Arquivos afetados: `tests/redis-cross-replica.js` (criado).

---

## [2026-08-10] Servico de producao apontado para a arvore de desenvolvimento

Contexto: `ppt.service` com `WorkingDirectory` na arvore de trabalho do git e
`Restart=always`.
Problema: qualquer reinicio carregava o que estivesse no disco naquele instante,
inclusive alteracoes ainda nao commitadas e trocas de branch. E, como o banco
ficava em `<projeto>/data`, testes rodados no diretorio gravavam partidas
ficticias no placar da instancia em uso.
Causa raiz: producao e desenvolvimento compartilhando o mesmo diretorio de codigo
e o mesmo diretorio de dados.
Resolucao: clone proprio em `~/apps/pepate/ppt-prod` fixado na `main`, dados em
`~/apps/pepate/ppt-data` via `PPT_DATA_DIR`, e o unit apontando para os dois.
Atualizacao passa a ser `git -C ~/apps/pepate/ppt-prod pull --ff-only` seguido de
`sudo systemctl restart ppt`.
Prevencao: servico de producao nunca aponta para arvore de trabalho. Ao verificar
isolamento, provar com escrita real e comparar os dois bancos — nao presumir pelo
caminho configurado.
Arquivos afetados: `db.js`, `DEPLOY.md`, unit do systemd (fora do repositorio).

---

<!-- Copie o formato acima e acrescente cada novo aprendizado ao fim deste arquivo. -->
