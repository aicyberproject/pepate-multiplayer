const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL;
const CHANNEL = 'ppt:events';
const ROOM_TTL = 7200;

let mode = REDIS_URL ? 'redis' : 'memory';
let redis = null;
let pub = null;
let sub = null;
const listeners = new Set();
const memoryRooms = new Map();
const lockTokens = new Map();

function keyOf(code) {
  return 'ppt:room:' + code;
}

function serializeRoom(room) {
  return {
    code: room.code,
    players: (room.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      score: p.score,
    })),
    turnIndex: room.turnIndex || 0,
    phase: room.phase || 'lobby',
    round: room.round || 0,
    matchMode: room.matchMode || 'infinito',
    matchTarget: room.matchTarget || 0,
    matchWins: room.matchWins || {},
    matchWinnerId: room.matchWinnerId || null,
    choices: room.choices || {},
    outcomes: room.outcomes || {},
    deadline: room.deadline || 0,
    revealUntil: room.revealUntil || 0,
    paused: !!room.paused,
    pausedRemaining: room.pausedRemaining || 0,
    bannedNames: Array.from(room.bannedNames || []),
    timer: room.timer,
    history: room.history || [],
    chat: room.chat || [],
  };
}

async function init() {
  if (mode === 'memory') {
    console.log('Room store: memoria (use REDIS_URL para compartilhar salas entre processos)');
    return;
  }
  const opts = { lazyConnect: true, maxRetriesPerRequest: null, enableOfflineQueue: true };
  redis = new (require('ioredis'))(REDIS_URL, opts);
  pub = new (require('ioredis'))(REDIS_URL, opts);
  sub = new (require('ioredis'))(REDIS_URL, opts);
  await Promise.all([redis.connect(), pub.connect(), sub.connect()]);
  await sub.subscribe(CHANNEL);
  sub.on('message', (channel, payload) => {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch (e) {
      return;
    }
    for (const cb of Array.from(listeners)) {
      try {
        cb(evt);
      } catch (e) {
        console.error('Room store event handler error', e);
      }
    }
  });
  console.log('Room store: redis (salas compartilhadas)');
}

async function close() {
  if (mode === 'memory') return;
  try {
    await sub.unsubscribe(CHANNEL);
  } catch (e) {}
  for (const c of [sub, pub, redis]) {
    if (c) {
      try {
        await c.quit();
      } catch (e) {}
    }
  }
}

async function roomExists(code) {
  if (mode === 'memory') return memoryRooms.has(code);
  const ex = await redis.exists(keyOf(code));
  return ex === 1;
}

async function getRoom(code) {
  if (mode === 'memory') return memoryRooms.get(code) || null;
  const raw = await redis.get(keyOf(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function saveRoom(room) {
  const state = serializeRoom(room);
  if (mode === 'memory') {
    memoryRooms.set(room.code, room);
    for (const cb of Array.from(listeners)) {
      cb({ type: 'state', code: room.code, state });
    }
    return;
  }
  await redis
    .multi()
    .set(keyOf(room.code), JSON.stringify(state), 'EX', ROOM_TTL)
    .sadd('ppt:rooms', room.code)
    .exec();
  await pub.publish(CHANNEL, JSON.stringify({ type: 'state', code: room.code, state }));
}

async function deleteRoom(code) {
  if (mode === 'memory') {
    memoryRooms.delete(code);
    for (const cb of Array.from(listeners)) {
      cb({ type: 'delete', code });
    }
    return;
  }
  await redis
    .multi()
    .del(keyOf(code))
    .srem('ppt:rooms', code)
    .exec();
  await pub.publish(CHANNEL, JSON.stringify({ type: 'delete', code }));
}

async function allRooms() {
  if (mode === 'memory') return Array.from(memoryRooms.values());
  const codes = await redis.smembers('ppt:rooms');
  const rooms = [];
  for (const c of codes) {
    const r = await getRoom(c);
    if (r) rooms.push(r);
  }
  return rooms;
}

function emit(code, event) {
  if (mode === 'memory') {
    for (const cb of Array.from(listeners)) {
      cb({ code, ...event });
    }
    return;
  }
  pub.publish(CHANNEL, JSON.stringify({ code, ...event })).catch(() => {});
}

function onEvent(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function acquireLock(name, ttlMs, retries = 25) {
  if (mode === 'memory') return true;
  const token = crypto.randomBytes(16).toString('hex');
  for (let i = 0; i <= retries; i++) {
    const ok = await redis.set('ppt:lock:' + name, token, 'PX', ttlMs, 'NX');
    if (ok === 'OK') {
      lockTokens.set(name, token);
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function releaseLock(name) {
  if (mode === 'memory') return;
  const token = lockTokens.get(name);
  if (!token) return;
  lockTokens.delete(name);
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    'ppt:lock:' + name,
    token
  );
}

module.exports = {
  init,
  close,
  mode,
  roomExists,
  getRoom,
  saveRoom,
  deleteRoom,
  allRooms,
  emit,
  onEvent,
  acquireLock,
  releaseLock,
};
