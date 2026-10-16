const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { store, backendKind } = require('./db');
const roomStore = require('./store');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString('hex');
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      stats: store.getStats(20),
      recent: store.getRecent(15),
      backend: backendKind,
    }));
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nao encontrado');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const CHOICES = ['pedra', 'papel', 'tesoura'];
const MATCH_MODES = { infinito: 0, '3': 2, '5': 3, '7': 4, '9': 5 };
const FRIENDLY_NAMES = [
  'Fenix', 'Lobo', 'Estrela', 'Raio', 'Tigre', 'Aguia', 'Trovao',
  'Neve', 'Falcao', 'Lua', 'Sol', 'Dragao', 'Pantera', 'Cometa',
  'Coruja', 'Cobra', 'Furia', 'Orvalho', 'Brisa', 'Vulcao',
];
const DEFAULT_TIMER = 15;
const REVEAL_MS = 9000;
const MAX_PLAYERS = 8;

const localCache = new Map();
const socketsByRoom = new Map();
const wsMeta = new Map();

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

async function newRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (await roomStore.roomExists(code));
  return code;
}

function randomChoice() {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}

function beats(a, b) {
  return (
    (a === 'pedra' && b === 'tesoura') ||
    (a === 'tesoura' && b === 'papel') ||
    (a === 'papel' && b === 'pedra')
  );
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    return FRIENDLY_NAMES[Math.floor(Math.random() * FRIENDLY_NAMES.length)] + newId().slice(0, 2);
  }
  return trimmed.slice(0, 16);
}

function matchModeLabel(mode) {
  return mode === 'infinito' ? 'infinito' : `melhor de ${mode}`;
}

function isGloballyBanned(name) {
  return store.isBanned(String(name).toLowerCase());
}

function clearTimers(room) {
  if (room.roundTimeout) clearTimeout(room.roundTimeout);
  if (room.revealTimeout) clearTimeout(room.revealTimeout);
  if (room.matchEndTimeout) clearTimeout(room.matchEndTimeout);
  room.roundTimeout = null;
  room.revealTimeout = null;
  room.matchEndTimeout = null;
}

function send(ws, type, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function sendState(room) {
  if (!room) return;
  for (const p of room.players) {
    if (!p.ws) continue;
    const state = buildState(room, p.id);
    send(p.ws, 'state', state);
  }
}

function buildState(room, forPlayerId) {
  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    online: p.online,
    isHost: p === room.players[0],
    score: p.score,
    matchWins: room.matchWins[p.id] || 0,
  }));
  const turnId = room.phase === 'lobby' ? null : (room.players[room.turnIndex] || {}).id || null;
  const showRound = room.phase === 'reveal' || room.phase === 'matchEnd';
  const state = {
    roomCode: room.code,
    phase: room.phase,
    round: room.round,
    players,
    myId: forPlayerId,
    turnPlayerId: turnId,
    timerSeconds: room.timer,
    matchMode: room.matchMode,
    matchTarget: room.matchTarget,
    paused: room.paused,
    pausedRemaining: room.pausedRemaining,
    deadline: room.phase === 'choose' ? room.deadline : 0,
    revealUntil: showRound ? room.revealUntil : 0,
    matchWinnerId: room.phase === 'matchEnd' ? room.matchWinnerId : null,
    hasChosen: {},
    choices: showRound ? room.choices : {},
    outcomes: showRound ? room.outcomes : {},
    history: room.history.slice(-12),
    chat: room.chat.slice(-60),
  };
  for (const p of room.players) {
    state.hasChosen[p.id] = Boolean(room.choices && room.choices[p.id]);
  }
  state.myChoice = (room.choices && room.choices[forPlayerId]) || null;
  state.isHost = room.players[0] ? room.players[0].id === forPlayerId : false;
  return state;
}

function systemChat(room, text) {
  room.chat.push({ id: newId(), system: true, text, at: Date.now() });
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
}

function playerChat(room, name, text) {
  room.chat.push({ id: newId(), name, text, at: Date.now() });
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
}

function addHistory(room, entry) {
  room.history.push(entry);
  if (room.history.length > 50) room.history = room.history.slice(-50);
}

function makeBareRoom(code) {
  return {
    code,
    players: [],
    turnIndex: 0,
    phase: 'lobby',
    round: 0,
    matchMode: 'infinito',
    matchTarget: 0,
    matchWins: {},
    matchWinnerId: null,
    choices: {},
    outcomes: {},
    deadline: 0,
    revealUntil: 0,
    paused: false,
    pausedRemaining: 0,
    bannedNames: new Set(),
    timer: DEFAULT_TIMER,
    history: [],
    chat: [],
    roundTimeout: null,
    revealTimeout: null,
    matchEndTimeout: null,
  };
}

function hydrate(state) {
  let room = localCache.get(state.code) || makeBareRoom(state.code);
  const sockets = socketsByRoom.get(state.code) || new Map();
  room.players = (state.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    online: p.online,
    score: p.score,
    ws: sockets.get(p.id) || null,
  }));
  room.turnIndex = state.turnIndex || 0;
  room.phase = state.phase || 'lobby';
  room.round = state.round || 0;
  room.matchMode = state.matchMode || 'infinito';
  room.matchTarget = state.matchTarget || 0;
  room.matchWins = state.matchWins || {};
  room.matchWinnerId = state.matchWinnerId || null;
  room.choices = state.choices || {};
  room.outcomes = state.outcomes || {};
  room.deadline = state.deadline || 0;
  room.revealUntil = state.revealUntil || 0;
  room.paused = !!state.paused;
  room.pausedRemaining = state.pausedRemaining || 0;
  room.bannedNames = new Set(state.bannedNames || []);
  room.timer = state.timer || DEFAULT_TIMER;
  room.history = state.history || [];
  room.chat = state.chat || [];
  return room;
}

function registerSocket(code, playerId, ws) {
  let sockets = socketsByRoom.get(code);
  if (!sockets) {
    sockets = new Map();
    socketsByRoom.set(code, sockets);
  }
  sockets.set(playerId, ws);
  wsMeta.set(ws, { code, playerId });
}

function unregisterSocket(code, playerId) {
  const sockets = socketsByRoom.get(code);
  if (sockets) sockets.delete(playerId);
}

function kickLocal(code, playerId, message) {
  const sockets = socketsByRoom.get(code);
  if (!sockets) return;
  const ws = sockets.get(playerId);
  if (!ws) return;
  unregisterSocket(code, playerId);
  wsMeta.delete(ws);
  send(ws, 'error', { message });
  try {
    ws.close();
  } catch (e) {}
}

function addPlayer(room, ws, name) {
  const player = { id: newId(), name, ws, score: 0, online: true };
  room.players.push(player);
  ws.playerId = player.id;
  ws.roomCode = room.code;
  return player;
}

async function createRoom(hostWs, hostName) {
  const code = await newRoomCode();
  const room = makeBareRoom(code);
  const player = addPlayer(room, hostWs, hostName);
  registerSocket(code, player.id, hostWs);
  systemChat(room, `${player.name} criou a sala. Compartilhe o codigo ${code}.`);
  return room;
}

function removePlayerState(room, player, message) {
  const idx = room.players.findIndex((p) => p.id === player.id);
  if (idx === -1) return false;
  room.players.splice(idx, 1);
  if (idx < room.turnIndex) room.turnIndex -= 1;
  delete room.choices[player.id];
  systemChat(room, message || `${player.name} saiu.`);
  if (room.phase === 'choose') checkAllChosen(room);
  return room.players.length === 0;
}

async function mutateRoom(code, fn) {
  if (roomStore.mode === 'memory') {
    const room = await roomStore.getRoom(code);
    if (!room) return { room: null, result: { error: 'Sala nao encontrada. Verifique o codigo.' } };
    const result = await fn(room);
    if (result && result.error) {
      return { room, result };
    }
    if (result && result.deleted) {
      await roomStore.deleteRoom(code);
    } else if (result && result.reschedule) {
      scheduleTimers(room);
    } else {
      await roomStore.saveRoom(room);
    }
    return { room, result };
  }
  const locked = await roomStore.acquireLock('room:' + code, 5000);
  if (!locked) return { room: null, result: { error: 'Ocupado, tente de novo.' } };
  try {
    const state = await roomStore.getRoom(code);
    if (!state) return { room: null, result: { error: 'Sala nao encontrada. Verifique o codigo.' } };
    const room = hydrate(state);
    localCache.set(code, room);
    const result = await fn(room);
    if (result && result.error) {
      return { room, result };
    }
    if (result && result.deleted) {
      await roomStore.deleteRoom(code);
    } else if (result && result.reschedule) {
      scheduleTimers(room);
    } else {
      await roomStore.saveRoom(room);
    }
    return { room, result };
  } finally {
    await roomStore.releaseLock('room:' + code);
  }
}

function pruneOffline(room) {
  const before = room.players.length;
  room.players = room.players.filter((p) => p.online);
  if (room.players.length < before) {
    systemChat(room, 'Jogadores desconectados foram removidos.');
  }
}

function startRound(room) {
  if (room.phase !== 'lobby') return;
  if (room.players.length < 2) return;
  room.round += 1;
  room.phase = 'choose';
  room.paused = false;
  room.choices = {};
  room.outcomes = {};
  room.turnIndex = room.turnIndex % room.players.length;
  room.deadline = Date.now() + room.timer * 1000;
  systemChat(
    room,
    `Rodada ${room.round}: a vez de ${room.players[room.turnIndex].name} (referencia). Todos escolhem!`
  );
}

function checkAllChosen(room) {
  if (room.phase !== 'choose' || room.paused) return false;
  const all = room.players.every((p) => room.choices[p.id]);
  if (all) {
    reveal(room);
    return true;
  }
  return false;
}

function findMatchWinner(room) {
  const target = room.matchTarget;
  if (!target) return null;
  const max = Math.max(...room.players.map((p) => p.score));
  if (max < target) return null;
  const leaders = room.players.filter((p) => p.score === max);
  if (leaders.length === 1) return leaders[0];
  return null;
}

function uniqueScoreLeader(room) {
  const withScore = room.players.filter((p) => p.score > 0);
  if (withScore.length === 0) return null;
  const max = Math.max(...withScore.map((p) => p.score));
  const leaders = withScore.filter((p) => p.score === max);
  if (leaders.length === 1) return leaders[0];
  return null;
}

function reveal(room) {
  if (room.phase !== 'choose') return;
  const ref = room.players[room.turnIndex];
  if (!ref) return;
  const refChoice = room.choices[ref.id];
  const outcomes = {};
  const roundEntries = [];
  for (const p of room.players) {
    outcomes[p.id] = { won: [], lost: [], drew: [] };
  }
  for (const p of room.players) {
    if (p.id === ref.id) {
      roundEntries.push({ id: p.id, choice: refChoice, vs: null, result: 'ref' });
      continue;
    }
    const oppChoice = room.choices[p.id];
    if (beats(refChoice, oppChoice)) {
      ref.score += 1;
      outcomes[ref.id].won.push(p.id);
      outcomes[p.id].lost.push(ref.id);
      roundEntries.push({ id: p.id, choice: oppChoice, vs: ref.id, result: 'loss' });
    } else if (beats(oppChoice, refChoice)) {
      p.score += 1;
      outcomes[ref.id].lost.push(p.id);
      outcomes[p.id].won.push(ref.id);
      roundEntries.push({ id: p.id, choice: oppChoice, vs: ref.id, result: 'win' });
    } else {
      outcomes[ref.id].drew.push(p.id);
      outcomes[p.id].drew.push(ref.id);
      roundEntries.push({ id: p.id, choice: oppChoice, vs: ref.id, result: 'draw' });
    }
  }
  room.outcomes = outcomes;
  room.revealUntil = Date.now() + REVEAL_MS;

  const wonCount = outcomes[ref.id].won.length;
  const lostCount = outcomes[ref.id].lost.length;
  const drawCount = outcomes[ref.id].drew.length;
  addHistory(room, {
    round: room.round,
    ref: ref.id,
    refChoice,
    entries: roundEntries,
    summary: `Rodada ${room.round} - ref: ${ref.name} (${wonCount}V ${lostCount}D ${drawCount}E)`,
  });

  const matchWinner = findMatchWinner(room);
  if (matchWinner) {
    room.phase = 'matchEnd';
    room.matchWinnerId = matchWinner.id;
    room.matchWins[matchWinner.id] = (room.matchWins[matchWinner.id] || 0) + 1;
    store.recordMatch(matchWinner.name, matchModeLabel(room.matchMode));
    systemChat(room, `${matchWinner.name} venceu a partida (${matchModeLabel(room.matchMode)})!`);
    return;
  }

  room.phase = 'reveal';
  systemChat(
    room,
    `Rodada ${room.round} encerrada: ${ref.name} venceu ${wonCount}, perdeu ${lostCount}, empatou ${drawCount}.`
  );
}

function doNextRound(room) {
  pruneOffline(room);
  if (room.players.length < 2) {
    room.phase = 'lobby';
    return;
  }
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.phase = 'lobby';
  startRound(room);
}

function doStartNewMatch(room) {
  pruneOffline(room);
  if (room.players.length < 2) {
    room.phase = 'lobby';
    return;
  }
  for (const p of room.players) p.score = 0;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.phase = 'lobby';
  systemChat(room, 'Nova partida! Placar zerado.');
  startRound(room);
}

function scheduleTimers(room) {
  if (!room) return;
  clearTimers(room);
  const now = Date.now();
  if (room.phase === 'choose' && !room.paused) {
    const ms = (room.deadline || 0) - now;
    if (ms > 0) room.roundTimeout = setTimeout(() => onRoundTimeout(room.code), ms);
  } else if (room.phase === 'reveal') {
    const ms = (room.revealUntil || 0) - now;
    if (ms > 0) room.revealTimeout = setTimeout(() => onRevealTimeout(room.code), ms);
  } else if (room.phase === 'matchEnd') {
    const ms = (room.revealUntil || 0) - now;
    if (ms > 0) room.matchEndTimeout = setTimeout(() => onMatchEndTimeout(room.code), ms);
  }
}

async function onRoundTimeout(code) {
  await mutateRoom(code, (room) => {
    if (room.phase !== 'choose' || room.paused) return { changed: false };
    if (room.deadline > Date.now()) return { reschedule: true };
    for (const p of room.players) {
      if (!room.choices[p.id]) {
        room.choices[p.id] = randomChoice();
        systemChat(room, `${p.name} nao escolheu a tempo (lance automatico).`);
      }
    }
    reveal(room);
    return { changed: true };
  });
}

async function onRevealTimeout(code) {
  await mutateRoom(code, (room) => {
    if (room.phase !== 'reveal') return { changed: false };
    if (room.revealUntil > Date.now()) return { reschedule: true };
    doNextRound(room);
    return { changed: true };
  });
}

async function onMatchEndTimeout(code) {
  await mutateRoom(code, (room) => {
    if (room.phase !== 'matchEnd') return { changed: false };
    if (room.revealUntil > Date.now()) return { reschedule: true };
    doStartNewMatch(room);
    return { changed: true };
  });
}

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      if (ws.roomCode) return;
      const name = sanitizeName(msg.name);
      if (isGloballyBanned(name)) {
        send(ws, 'error', { message: 'Este nome esta banido pelo dono do servidor.' });
        return;
      }
      const room = await createRoom(ws, name);
      await roomStore.saveRoom(room);
      break;
    }
    case 'join': {
      if (ws.roomCode) return;
      const code = String(msg.roomCode || '').trim().toUpperCase();
      const { result } = await mutateRoom(code, (room) => {
        if (room.players.length >= MAX_PLAYERS) return { error: 'Sala cheia.' };
        const name = sanitizeName(msg.name);
        if (isGloballyBanned(name)) return { error: 'Este nome esta banido pelo dono do servidor.' };
        if (room.bannedNames.has(name.toLowerCase())) {
          return { error: 'Voce foi banido desta sala pelo anfitriao.' };
        }
        const dup = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
        const finalName = dup ? name + newId().slice(0, 2).toUpperCase() : name;
        const player = addPlayer(room, ws, finalName);
        registerSocket(code, player.id, ws);
        systemChat(room, `${player.name} entrou na sala.`);
        if (room.phase === 'lobby' && room.players.length === 2) {
          systemChat(room, 'Jogadores suficientes! O anfitriao pode iniciar o jogo.');
        }
        return { changed: true };
      });
      if (result && result.error) send(ws, 'error', { message: result.error });
      break;
    }
    case 'start': {
      if (!ws.roomCode) return;
      const { result } = await mutateRoom(ws.roomCode, (room) => {
        if (room.phase !== 'lobby') return { changed: false };
        if (room.players[0].id !== ws.playerId) {
          return { error: 'Apenas o anfitriao pode iniciar.' };
        }
        startRound(room);
        return { changed: true };
      });
      if (result && result.error) send(ws, 'error', { message: result.error });
      break;
    }
    case 'config': {
      if (!ws.roomCode) return;
      const { result } = await mutateRoom(ws.roomCode, (room) => {
        if (room.phase !== 'lobby') return { changed: false };
        if (room.players[0].id !== ws.playerId) {
          return { error: 'Apenas o anfitriao pode alterar o modo.' };
        }
        const mode = String(msg.matchMode || '');
        if (!(mode in MATCH_MODES)) return { changed: false };
        room.matchMode = mode;
        room.matchTarget = MATCH_MODES[mode];
        systemChat(room, `Modo de partida alterado: ${matchModeLabel(mode)}.`);
        return { changed: true };
      });
      if (result && result.error) send(ws, 'error', { message: result.error });
      break;
    }
    case 'rejoin': {
      if (ws.roomCode) return;
      const code = String(msg.roomCode || '').trim().toUpperCase();
      const { result } = await mutateRoom(code, (room) => {
        const pid = String(msg.playerId || '');
        const player = room.players.find((p) => p.id === pid);
        if (!player || player.online) return { changed: false };
        if (isGloballyBanned(player.name) || room.bannedNames.has(player.name.toLowerCase())) {
          return { error: 'Voce foi banido desta sala.' };
        }
        player.online = true;
        player.ws = ws;
        ws.playerId = player.id;
        ws.roomCode = room.code;
        registerSocket(code, player.id, ws);
        systemChat(room, `${player.name} reconectou.`);
        return { changed: true };
      });
      if (result && result.error) {
        send(ws, 'error', { message: result.error });
        ws.close();
      }
      break;
    }
    case 'choice': {
      if (!ws.roomCode) return;
      await mutateRoom(ws.roomCode, (room) => {
        if (room.phase !== 'choose') return { changed: false };
        const choice = String(msg.choice || '');
        if (!CHOICES.includes(choice)) return { changed: false };
        room.choices[ws.playerId] = choice;
        checkAllChosen(room);
        return { changed: true };
      });
      break;
    }
    case 'pause': {
      if (!ws.roomCode) return;
      const { result } = await mutateRoom(ws.roomCode, (room) => {
        if (room.phase !== 'choose') return { changed: false };
        if (room.players[0].id !== ws.playerId) {
          return { error: 'Apenas o anfitriao pode pausar.' };
        }
        const want = Boolean(msg.paused);
        if (want && !room.paused) {
          room.paused = true;
          room.pausedRemaining = Math.max(0, room.deadline - Date.now());
          systemChat(room, 'Jogo pausado pelo anfitriao.');
        } else if (!want && room.paused) {
          room.paused = false;
          room.deadline = Date.now() + room.pausedRemaining;
          systemChat(room, 'Jogo retomado.');
        }
        checkAllChosen(room);
        return { changed: true };
      });
      if (result && result.error) send(ws, 'error', { message: result.error });
      break;
    }
    case 'next': {
      if (!ws.roomCode) return;
      await mutateRoom(ws.roomCode, (room) => {
        if (room.phase === 'reveal') {
          doNextRound(room);
          return { changed: true };
        }
        if (room.phase === 'matchEnd') {
          doStartNewMatch(room);
          return { changed: true };
        }
        return { changed: false };
      });
      break;
    }
    case 'endMatch': {
      if (!ws.roomCode) return;
      const { result } = await mutateRoom(ws.roomCode, (room) => {
        if (room.phase === 'lobby') return { changed: false };
        if (room.players[0].id !== ws.playerId) {
          return { error: 'Apenas o anfitriao pode encerrar a partida.' };
        }
        room.paused = false;
        const leader = uniqueScoreLeader(room);
        if (leader) {
          room.matchWins[leader.id] = (room.matchWins[leader.id] || 0) + 1;
          store.recordMatch(leader.name, matchModeLabel(room.matchMode));
          systemChat(room, `Partida encerrada: ${leader.name} venceu!`);
        } else {
          systemChat(room, 'Partida encerrada sem vencedor.');
        }
        for (const p of room.players) p.score = 0;
        room.phase = 'lobby';
        return { changed: true };
      });
      if (result && result.error) send(ws, 'error', { message: result.error });
      break;
    }
    case 'banPlayer': {
      if (!ws.roomCode) return;
      const code = ws.roomCode;
      await mutateRoom(code, (room) => {
        if (room.players[0].id !== ws.playerId) return { changed: false };
        const target = room.players.find((p) => p.id === msg.playerId);
        if (!target || target.id === ws.playerId) return { changed: false };
        const targetId = target.id;
        const targetName = target.name;
        room.bannedNames.add(targetName.toLowerCase());
        kickLocal(code, targetId, 'Voce foi banido da sala pelo anfitriao.');
        roomStore.emit(code, {
          type: 'kick',
          playerId: targetId,
          message: 'Voce foi banido da sala pelo anfitriao.',
        });
        const empty = removePlayerState(room, target, `${targetName} foi banido da sala pelo anfitriao.`);
        return empty ? { deleted: true } : { changed: true };
      });
      break;
    }
    case 'leave': {
      if (!ws.roomCode) return;
      const code = ws.roomCode;
      const meta = wsMeta.get(ws);
      const pid = meta ? meta.playerId : null;
      ws.roomCode = null;
      ws.playerId = null;
      wsMeta.delete(ws);
      if (!pid) return;
      await mutateRoom(code, (room) => {
        const player = room.players.find((p) => p.id === pid);
        if (!player) return { changed: false };
        const empty = removePlayerState(room, player, `${player.name} saiu da sala.`);
        return empty ? { deleted: true } : { changed: true };
      });
      break;
    }
    case 'admin': {
      if (String(msg.key || '') !== ADMIN_KEY) {
        send(ws, 'adminResult', { ok: false, message: 'Chave de administrador invalida.' });
        return;
      }
      const rawName = String(msg.name || '').trim().slice(0, 16);
      if (!rawName) {
        send(ws, 'adminResult', { ok: false, message: 'Informe o nome a banir.' });
        return;
      }
      const name = rawName.toLowerCase();
      if (msg.action === 'ban') {
        store.addBan(name, 'dono do servidor', String(msg.reason || '').slice(0, 120));
        for (const r of await roomStore.allRooms()) {
          const target = r.players.find((p) => p.name.toLowerCase() === name);
          if (!target) continue;
          await mutateRoom(r.code, (room) => {
            const t = room.players.find((p) => p.name.toLowerCase() === name);
            if (!t) return { changed: false };
            const targetId = t.id;
            kickLocal(r.code, targetId, 'Voce foi banido pelo dono do servidor.');
            roomStore.emit(r.code, {
              type: 'kick',
              playerId: targetId,
              message: 'Voce foi banido pelo dono do servidor.',
            });
            const empty = removePlayerState(room, t, `${t.name} foi banido pelo dono do servidor.`);
            return empty ? { deleted: true } : { changed: true };
          });
        }
        send(ws, 'adminResult', { ok: true, message: `${rawName} banido globalmente.` });
      } else if (msg.action === 'unban') {
        store.removeBan(name);
        send(ws, 'adminResult', { ok: true, message: `Banimento de ${rawName} removido.` });
      }
      break;
    }
    case 'chat': {
      if (!ws.roomCode) return;
      await mutateRoom(ws.roomCode, (room) => {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return { changed: false };
        const p = room.players.find((pl) => pl.id === ws.playerId);
        if (!p) return { changed: false };
        playerChat(room, p.name, text);
        return { changed: true };
      });
      break;
    }
    default:
      break;
  }
}

async function handleClose(ws) {
  const meta = wsMeta.get(ws);
  if (!meta) return;
  wsMeta.delete(ws);
  const { code, playerId } = meta;
  unregisterSocket(code, playerId);
  await mutateRoom(code, (room) => {
    const idx = room.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return { changed: false };
    const player = room.players[idx];
    player.online = false;
    systemChat(room, `${player.name} desconectou.`);
    if (room.phase === 'lobby') {
      room.players.splice(idx, 1);
      if (idx < room.turnIndex) room.turnIndex -= 1;
      return room.players.length === 0 ? { deleted: true } : { changed: true };
    }
    if (room.phase === 'choose' && !room.choices[player.id]) {
      room.choices[player.id] = randomChoice();
    }
    if (room.phase === 'choose') checkAllChosen(room);
    return { changed: true };
  });
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    handleMessage(ws, msg).catch((e) => console.error('handleMessage error', e));
  });
  ws.on('close', () => {
    handleClose(ws).catch((e) => console.error('handleClose error', e));
  });
  ws.on('error', () => {});
});

async function handleRoomEvent(evt) {
  if (evt.type === 'state') {
    let room;
    if (roomStore.mode === 'memory') {
      room = await roomStore.getRoom(evt.code);
      if (!room) return;
    } else {
      room = hydrate(evt.state);
      localCache.set(evt.code, room);
    }
    scheduleTimers(room);
    sendState(room);
  } else if (evt.type === 'delete') {
    const r = localCache.get(evt.code);
    if (r) clearTimers(r);
    localCache.delete(evt.code);
  } else if (evt.type === 'kick') {
    kickLocal(evt.code, evt.playerId, evt.message);
  }
}

(async () => {
  await roomStore.init();
  roomStore.onEvent((evt) => {
    handleRoomEvent(evt).catch((e) => console.error('room event error', e));
  });
  server.listen(PORT, () => {
    console.log(`PPT Multiplayer rodando em http://localhost:${PORT}`);
    console.log(`Banco de dados: ${backendKind}`);
    console.log(`Room store: ${roomStore.mode}`);
    console.log(`Chave de administrador (dono do servidor): ${ADMIN_KEY}`);
  });
})();
