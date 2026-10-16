# Pedra, Papel e Tesoura — Multiplayer

O clássico jogo em modo multiplayer online e em tempo real, jogável no navegador.
Servidor Node.js sem framework, comunicação por WebSocket, front-end em HTML, CSS
e JavaScript puros — sem build, sem bundler, sem dependência de front-end.

## Como funciona a partida

Diferente do duelo tradicional de dois jogadores, cada rodada tem um jogador de
**referência** (o "da vez"). Todos escolhem ao mesmo tempo, e cada escolha é
comparada contra a do jogador de referência:

- O jogador de referência ganha 1 ponto por adversário que ele vencer.
- Cada adversário ganha 1 ponto se vencer o jogador de referência.
- Empates não pontuam.

A cada rodada a referência passa para o próximo jogador, em rodízio. Quem não
escolher dentro do tempo tem um lance sorteado automaticamente.

### Modos de partida

No lobby, o anfitrião escolhe como a partida termina:

| Modo         | Vitórias para ganhar |
| ------------ | -------------------- |
| Infinito     | não termina sozinha  |
| Melhor de 3  | 2                    |
| Melhor de 5  | 3                    |
| Melhor de 7  | 4                    |
| Melhor de 9  | 5                    |

Ao alcançar o alvo, a partida encerra com vencedor, a vitória é registrada no
banco e o placar zera automaticamente para a partida seguinte. Só há vencedor se
a liderança for isolada — em caso de empate no topo, o jogo continua.

## Recursos

- Salas privadas com código de 6 caracteres e link de convite compartilhável
- Até 8 jogadores por sala
- Modos de partida: infinito ou melhor de 3, 5, 7 e 9
- Rodadas cronometradas (15 s por padrão) com lance automático no estouro
- Fase de revelação de 9 segundos entre rodadas
- Pausar/retomar pelo anfitrião: congela o cronômetro e bloqueia a revelação
- Encerrar partida pelo anfitrião: o líder atual é registrado como vencedor
- Sair da sala pelo botão no topo, com o anfitrião passando ao próximo jogador
- Banimento de sala pelo anfitrião (impede reentrada) e banimento global pelo
  dono do servidor
- Banco de dados persistente com o placar histórico de vitórias e os banimentos
- Janela interna com placar, regras, ética do chat, política de banimentos e
  painel de administração
- Placar acumulado, histórico das últimas rodadas e chat na sala
- Reconexão: quem cai pode voltar à mesma sala e recuperar sua posição
- Mensagens de sistema para entrada, saída, início e fim de rodada

## Requisitos

- Node.js 18 ou superior
- npm

## Instalação e execução

```bash
npm install
npm start
```

Abra `http://localhost:8080` no navegador. Para jogar, abra uma segunda aba (ou
outro dispositivo na mesma rede) e entre com o código exibido na tela.

Para usar outra porta:

```bash
PORT=3000 npm start
```

### Chave de administrador

O banimento global é reservado ao dono do servidor e exige uma chave. Ela é
exibida nos logs no start e pode ser fixada por variável de ambiente:

```bash
ADMIN_KEY=sua-chave-secreta npm start
```

Sem `ADMIN_KEY`, uma chave aleatória é gerada a cada start — ou seja, ela muda
quando o servidor reinicia. Defina a variável para mantê-la estável.

## Estrutura do projeto

```
server.js          Servidor HTTP + WebSocket, toda a lógica de sala e rodada
store.js           Estado vivo das salas: memória ou Redis (ver DEPLOY.md)
db.js              Persistência: SQLite nativo com fallback em JSON
data/              Banco de dados gerado em runtime (fora do controle de versão)
public/index.html  Marcação das telas de lobby e de jogo, sprites SVG
public/style.css   Estilos, animações e layout responsivo
public/game.js     Cliente: conexão WebSocket, renderização e interação
tests/             Testes de integração por WebSocket real
DEPLOY.md          Modos de execução, escalonamento e deploy
```

Dependências de runtime: `ws` e, apenas no modo Redis, `ioredis` — carregado sob
demanda, então o modo padrão não precisa dele.

## Persistência

As salas vivem em memória por padrão (`Map` no processo do servidor): reiniciar o
servidor descarta as salas abertas. Definindo `REDIS_URL`, o estado vivo das
salas passa a ser compartilhado entre várias réplicas — veja
[`DEPLOY.md`](DEPLOY.md). Já o **placar histórico de vitórias** e os
**banimentos globais** são persistidos em disco e sobrevivem ao reinício.

O diretório padrão é `data/`, ao lado do código; a variável `PPT_DATA_DIR` aponta
para outro caminho, que é o recomendado em produção — assim os dados ficam fora da
árvore do projeto e sobrevivem a redeploys.

O armazenamento usa o módulo nativo `node:sqlite` em `data/ppt.sqlite`, aberto em
modo WAL com `busy_timeout` para que várias réplicas na mesma máquina possam
compartilhar o arquivo. Onde o módulo não estiver disponível, `db.js` cai para um
arquivo JSON em `data/ppt.json`, com a mesma interface, e emite um aviso — esse
fallback é por processo, então numa instalação com múltiplas réplicas ele deixa de
compartilhar placar e bans. O backend escolhido é informado no log do start e no
campo `backend` de `/api/leaderboard`.

A persistência é *best-effort*: se uma escrita falhar (disco cheio, banco
travado, permissão negada), o erro é registrado no log e o jogo continua sem
gravar aquele registro — uma falha de banco nunca derruba o servidor nem
interrompe as partidas em andamento.

### Endpoint HTTP

`GET /api/leaderboard` devolve `{ stats, recent, backend }`: as 20 maiores
contagens de vitórias, as 15 partidas mais recentes e o backend em uso. É o que
alimenta a janela interna de regras e vitórias.

## Protocolo WebSocket

O cliente e o servidor trocam mensagens JSON no formato `{ type, data }`.

### Cliente → servidor

| `type`       | Campos                          | Efeito                                              |
| ------------ | ------------------------------- | --------------------------------------------------- |
| `create`     | `name`                          | Cria uma sala e entra como anfitrião                |
| `join`       | `roomCode`, `name`              | Entra em uma sala existente                         |
| `rejoin`     | `roomCode`, `playerId`          | Reassume um jogador que caiu                        |
| `start`      | —                               | Inicia a partida (apenas o anfitrião)               |
| `config`     | `matchMode`                     | Define o modo de partida (apenas o anfitrião)       |
| `choice`     | `choice`                        | Registra `pedra`, `papel` ou `tesoura`              |
| `pause`      | `paused`                        | Pausa ou retoma a rodada (apenas o anfitrião)       |
| `next`       | —                               | Antecipa o fim da revelação ou inicia nova partida  |
| `endMatch`   | —                               | Encerra a partida (apenas o anfitrião)              |
| `banPlayer`  | `playerId`                      | Bane da sala (apenas o anfitrião)                   |
| `leave`      | —                               | Sai da sala                                         |
| `admin`      | `key`, `action`, `name`, `reason` | Ban/unban global (`action`: `ban` ou `unban`)      |
| `chat`       | `text`                          | Envia mensagem ao chat da sala                      |

### Servidor → cliente

| `type`        | Conteúdo                                                              |
| ------------- | --------------------------------------------------------------------- |
| `state`       | Estado completo da sala, personalizado para o destinatário            |
| `error`       | Mensagem de erro legível (sala inexistente, sala cheia, sem permissão) |
| `adminResult` | Resultado de uma ação de administração: `{ ok, message }`             |

O `state` traz a fase atual (`lobby`, `choose`, `reveal` ou `matchEnd`), a lista
de jogadores com placar, partidas vencidas e status de conexão, quem é a
referência da rodada, o modo e o alvo da partida, o estado de pausa, os prazos do
cronômetro, o histórico e o chat. As escolhas dos outros jogadores só são
enviadas nas fases `reveal` e `matchEnd` — durante a escolha, cada cliente recebe
apenas se o adversário já jogou, nunca o que ele jogou.

## Ajustes rápidos

As constantes ficam no topo de `server.js`:

| Constante       | Padrão | Significado                                |
| --------------- | ------ | ------------------------------------------ |
| `DEFAULT_TIMER` | `15`   | Segundos para escolher na rodada           |
| `REVEAL_MS`     | `9000` | Duração da fase de revelação, em ms        |
| `MAX_PLAYERS`   | `8`    | Limite de jogadores por sala               |

## Método de desenvolvimento

Este repositório adota o ciclo **Investigar → Planejar → Implementar →
Verificar**. Antes de qualquer tarefa complexa, consulte
[`learnings.md`](learnings.md) para não repetir erros já cometidos; ao terminar,
valide contra [`verification-standard.md`](verification-standard.md) e registre
os aprendizados novos.

## Licença

MIT. Veja [`LICENSE`](LICENSE).
