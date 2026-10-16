# Deploy e escalonamento

O jogo tem dois modos de armazenamento de salas, controlados pela variavel `REDIS_URL`:

## Modo memoria (padrao)

Sem `REDIS_URL`, as salas vivem em memoria no proprio processo. Funciona como antes,
sem dependencias externas alem do Node.js.

```bash
npm install
node server.js
# PPT Multiplayer rodando em http://localhost:8080
```

- `PORT` define a porta (padrao `8080`).
- `ADMIN_KEY` define a chave de administrador; sem ela, uma chave aleatoria e logada no boot.
- Dados de leaderboard/banimentos sao persistidos em `data/ppt.sqlite` (ou `data/ppt.json`).

## Modo Redis (escalonamento horizontal)

Defina `REDIS_URL` para que o estado vivo das salas (jogadores, placar, fase, timer)
seja compartilhado entre multiplas replicas via Redis. O broadcast de estado entre
replicas usa pub/sub do Redis; timers sao derivados do estado e as mutacoes sao
serializadas por lock distribuido.

```bash
REDIS_URL=redis://127.0.0.1:6379 PORT=8081 node server.js &
REDIS_URL=redis://127.0.0.1:6379 PORT=8082 node server.js &
```

Com varias replicas atras de um balanceador (ex.: Nginx com `proxy_pass` para um
grupo `upstream` e headers de upgrade para WebSocket), os jogadores de uma mesma
sala podem estar conectados a replicas diferentes: criacao, join, rodadas, chat,
pausa, banimentos e encerramento funcionam entre processos.

### Notas da rota Redis

- Leaderboard e banimentos globais (`db.js`) sao **por replica** (SQLite local de cada
  processo). Para compartilhar esses dados entre replicas, mova `db.js` para usar o
  mesmo Redis/banco compartilhado em um passo futuro; o estado vivo das salas ja e
  totalmente compartilhado.
- Chaves Redis usadas: `ppt:room:<CODIGO>` (estado JSON, TTL 2h), `ppt:rooms` (indice),
  `ppt:events` (canal pub/sub), `ppt:lock:<nome>` (mutex distribuido).
- O Redis nao precisa de cluster para esse volume; uma instancia unica basta.

## Deploy na VPS (single replica)

```bash
# Copiar para o servidor
scp -r server.js store.js db.js package.json public/ usuario@SEU_IP:/opt/ppt/

# Instalar dependencias e iniciar
cd /opt/ppt && npm install --omit=dev

# systemd: /etc/systemd/system/ppt.service
#   [Unit]
#   Description=PPT Multiplayer
#   After=network.target redis-server.service
#
#   [Service]
#   WorkingDirectory=/opt/ppt
#   Environment=PORT=8090
#   # Environment=REDIS_URL=redis://127.0.0.1:6379
#   # Environment=ADMIN_KEY=sua-chave-fixa
#   ExecStart=/usr/bin/node server.js
#   Restart=always
#   RestartSec=3
#
#   [Install]
#   WantedBy=multi-user.target

sudo systemctl daemon-reload
sudo systemctl enable --now ppt
```

Nginx (proxy WebSocket):

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Testes de integracao

Os testes usam WebSocket real e exigem `NODE_PATH` apontando para as dependencias:

```bash
NODE_PATH=/workspace/node_modules node /tmp/opencode/test_game.js
NODE_PATH=/workspace/node_modules node /tmp/opencode/test_features.js
NODE_PATH=/workspace/node_modules node /tmp/opencode/test_redis.js
```

- `test_game.js` e `test_features.js`: fluxo completo em modo memoria (porta 8080).
- `test_redis.js`: cria sala na replica 8081, entradas/jogadas/chat/pausa/banimentos
  na replica 8082, validando broadcast cruzado (precisa de 2 replicas com `REDIS_URL`).
