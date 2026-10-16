/* Pedra, Papel, Tesoura - cliente */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const ICONS = {
  pedra: `<svg viewBox="0 0 64 64"><path d="M17 42 C13 33 15 24 21 19.5 C26 16 35 14.5 40 17 C46 19.5 51.5 26 51 33.5 C50.5 42 46 51.5 39 54.5 C31.5 57.5 21.5 51 17 42 Z" fill="url(#grad-rock)" stroke="#0f172a" stroke-width="1.5"/><path d="M26 22 C28 26 27 31 30 34 M37 25 C38 30 40 32 41 36" stroke="#0f172a" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.35"/><ellipse cx="27" cy="22" rx="6.5" ry="4" fill="url(#grad-rock-shine)"/></svg>`,
  papel: `<svg viewBox="0 0 64 64"><path d="M18 8 L40 8 L46 14 L46 56 L18 56 Z" fill="url(#grad-paper)" stroke="#0f172a" stroke-width="1.5"/><path d="M40 8 L40 14 L46 14" fill="#b6c2d2" stroke="#0f172a" stroke-width="1.2"/><g stroke="#0f172a" stroke-width="2" stroke-linecap="round" opacity="0.3"><line x1="23" y1="24" x2="41" y2="24"/><line x1="23" y1="31" x2="41" y2="31"/><line x1="23" y1="38" x2="35" y2="38"/></g></svg>`,
  tesoura: `<svg viewBox="0 0 64 64"><circle cx="20" cy="46" r="7" fill="url(#grad-sciss)" stroke="#0f172a" stroke-width="1.5"/><circle cx="44" cy="46" r="7" fill="url(#grad-sciss)" stroke="#0f172a" stroke-width="1.5"/><circle cx="20" cy="46" r="2.4" fill="#0f172a"/><circle cx="44" cy="46" r="2.4" fill="#0f172a"/><path d="M25 44 C31 38 36 30 41 22" stroke="#cbd5e1" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M39 44 C33 38 28 30 23 22" stroke="#cbd5e1" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="41" cy="21" r="2.5" fill="#94a3b8" stroke="#0f172a" stroke-width="1"/><circle cx="23" cy="21" r="2.5" fill="#94a3b8" stroke="#0f172a" stroke-width="1"/></svg>`,
};
const CHOICE_NAME = { pedra: 'Pedra', papel: 'Papel', tesoura: 'Tesoura' };
const RING_C = 2 * Math.PI * 54;
const CONFETTI_COLORS = ['#7c6bff', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#a78bfa'];

const state = {
  ws: null,
  myId: null,
  room: null,
  connected: false,
  banned: false,
  reconnectTimer: null,
  reconnectTries: 0,
  lastRoomCode: null,
  lastMyId: null,
  lastName: null,
  animId: null,
  chatCount: 0,
  lastTickSecond: 99,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function modeLabel(mode) {
  return mode === 'infinito' ? 'Infinito' : 'Melhor de ' + mode;
}

/* ============================ ÁUDIO ============================ */
const AudioFX = (() => {
  let ctx = null;
  function ac() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur = 0.15, type = 'sine', vol = 0.18, when = 0, glide = 0) {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, glide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  return {
    click() { tone(660, 0.07, 'triangle', 0.12); },
    choose() { tone(523, 0.1, 'sine', 0.16); tone(784, 0.16, 'sine', 0.16, 0.07); },
    tick() { tone(920, 0.05, 'square', 0.08); },
    reveal() { tone(392, 0.22, 'sine', 0.16); tone(523, 0.22, 'sine', 0.16, 0.09); tone(659, 0.3, 'sine', 0.14, 0.18); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.16, i * 0.09)); },
    lose() { [440, 349, 294, 220].forEach((f, i) => tone(f, 0.18, 'sine', 0.14, i * 0.1)); },
    draw() { tone(440, 0.18, 'sine', 0.14); tone(440, 0.18, 'sine', 0.14, 0.16); },
  };
})();

/* ============================ EFEITOS ============================ */
function shockwave(x, y) {
  const el = $('#shockwave');
  el.style.setProperty('--sx', x + 'px');
  el.style.setProperty('--sy', y + 'px');
  el.classList.remove('play');
  void el.offsetWidth;
  el.classList.add('play');
}

function sparks(x, y, color) {
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    const a = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 110;
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.background = color || CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    s.style.setProperty('--dx', Math.cos(a) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(a) * dist + 'px');
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 750);
  }
}

function confettiBurst() {
  const layer = $('#confetti-layer');
  const W = window.innerWidth;
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * W + 'px';
    c.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    c.style.animationDuration = 2 + Math.random() * 2 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.transform = `scale(${0.6 + Math.random()})`;
    layer.appendChild(c);
    setTimeout(() => c.remove(), 4600);
  }
}

function toast(text, isError) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.className = isError ? 'show error' : 'show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = ''), 4500);
}

/* fundo com partículas */
(() => {
  const canvas = $('#bg-canvas');
  const ctx = canvas.getContext('2d');
  let w, h, parts = [];
  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  for (let i = 0; i < 60; i++) {
    parts.push({
      x: Math.random() * w, y: Math.random() * h,
      r: 1 + Math.random() * 2.6,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -0.2 - Math.random() * 0.5,
      c: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      a: 0.1 + Math.random() * 0.5,
      tw: Math.random() * Math.PI * 2,
    });
  }
  (function loop() {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.tw += 0.02;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      const alpha = p.a * (0.6 + 0.4 * Math.sin(p.tw));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.c;
      ctx.shadowColor = p.c;
      ctx.shadowBlur = 8;
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    requestAnimationFrame(loop);
  })();
})();

/* ============================ WEBSOCKET ============================ */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}

function connect() {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => {
    state.connected = true;
    state.reconnectTries = 0;
    hideReconnect();
    if (state.lastRoomCode && state.lastMyId) {
      send('rejoin', { roomCode: state.lastRoomCode, playerId: state.lastMyId });
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServer(msg);
  };
  ws.onclose = () => {
    state.connected = false;
    if (state.banned) {
      resetToEntry();
    } else if (state.room) {
      showReconnect();
    } else {
      scheduleReconnect();
    }
  };
  ws.onerror = () => {};
}

function send(type, data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(Object.assign({ type }, data || {})));
  }
}

function handleServer(msg) {
  switch (msg.type) {
    case 'state': {
      const prevPhase = state.room ? state.room.phase : null;
      state.room = msg.data;
      state.myId = msg.data.myId;
      state.lastRoomCode = msg.data.roomCode;
      state.lastMyId = msg.data.myId;
      render(msg.data);
      if (prevPhase !== msg.data.phase) onPhaseChange(prevPhase, msg.data);
      break;
    }
    case 'error': {
      const m = String(msg.data.message || '');
      if (/banid/i.test(m)) state.banned = true;
      $('#entry-error').textContent = m;
      if (state.room) toast(m, true);
      else toast(m, true);
      if (state.banned) resetToEntry();
      break;
    }
    case 'adminResult': {
      const el = $('#admin-result');
      if (el) el.textContent = msg.data.message;
      toast(msg.data.message, !msg.data.ok);
      break;
    }
  }
}

function onPhaseChange(prev, room) {
  const isRound = room.phase === 'reveal' || room.phase === 'matchEnd';
  const wasRound = prev === 'reveal' || prev === 'matchEnd';
  if (!isRound || wasRound) return;
  if (room.phase === 'matchEnd') {
    AudioFX.reveal();
    return;
  }
  evaluateResult(room);
}

function resetToEntry() {
  state.room = null;
  state.lastRoomCode = null;
  state.lastMyId = null;
  state.banned = false;
  $('#screen-game').classList.add('hidden');
  $('#screen-lobby').classList.remove('hidden');
  $('#entry-error').textContent = '';
}

/* ============================ TELA DE ENTRADA ============================ */
$('#entry-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name-input').value.trim();
  if (!name) { $('#entry-error').textContent = 'Digite seu nome.'; return; }
  state.lastName = name;
  AudioFX.click();
  send('create', { name });
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name-input').value.trim();
  const code = $('#code-input').value.trim().toUpperCase();
  if (!name) { $('#entry-error').textContent = 'Digite seu nome.'; return; }
  if (!code) { $('#entry-error').textContent = 'Digite o codigo da sala.'; return; }
  state.lastName = name;
  AudioFX.click();
  send('join', { name, roomCode: code });
});

/* ============================ JANELA INTERNA ============================ */
$('#btn-info').addEventListener('click', () => {
  AudioFX.click();
  $('#info-modal').classList.remove('hidden');
  loadLeaderboard();
});
$('#modal-close').addEventListener('click', () => $('#info-modal').classList.add('hidden'));
$('#info-modal').addEventListener('click', (e) => {
  if (e.target === $('#info-modal')) $('#info-modal').classList.add('hidden');
});

async function loadLeaderboard() {
  const lb = $('#leaderboard');
  const recent = $('#recent-wins');
  lb.innerHTML = '<li class="dim">Carregando...</li>';
  recent.innerHTML = '<li class="dim">Carregando...</li>';
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.stats || data.stats.length === 0) {
      lb.innerHTML = '<li class="dim">Nenhuma vitoria registrada ainda.</li>';
    } else {
      lb.innerHTML = data.stats.map((s, i) => `
        <li><span class="rank">${i + 1}.</span>
            <span class="lb-name">${escapeHtml(s.name)}</span>
            <span class="lb-wins">${s.wins} partida${s.wins === 1 ? '' : 's'}</span></li>`).join('');
    }
    if (!data.recent || data.recent.length === 0) {
      recent.innerHTML = '<li class="dim">Sem partidas concluidas.</li>';
    } else {
      recent.innerHTML = data.recent.map((m) => {
        const d = new Date(m.played_at);
        const time = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `<li>${escapeHtml(m.winner_name)} venceu (${escapeHtml(m.mode)}) - ${time}</li>`;
      }).join('');
    }
  } catch (e) {
    lb.innerHTML = '<li class="dim">Erro ao carregar o placar.</li>';
    recent.innerHTML = '';
  }
}

$('#btn-admin-ban').addEventListener('click', () => sendAdmin('ban'));
$('#btn-admin-unban').addEventListener('click', () => sendAdmin('unban'));
function sendAdmin(action) {
  const key = $('#admin-key').value.trim();
  const name = $('#admin-name').value.trim();
  if (!key || !name) {
    $('#admin-result').textContent = 'Informe a chave e o nome do jogador.';
    return;
  }
  $('#admin-result').textContent = 'Processando...';
  send('admin', { key, action, name, reason: $('#admin-reason').value.trim() });
}

/* ============================ RENDER ============================ */
function render(room) {
  $('#screen-lobby').classList.add('hidden');
  $('#screen-game').classList.remove('hidden');
  $('#room-code').textContent = room.roomCode;
  renderScoreboard(room);
  renderHistory(room);
  renderChat(room);
  renderTurn(room);
  renderTopbar(room);
  renderPhase(room);
}

function renderTopbar(room) {
  const pause = $('#btn-pause');
  pause.classList.toggle('hidden', !(room.isHost && room.phase === 'choose'));
  pause.textContent = room.paused ? 'Retomar' : 'Pausar';
  $('#btn-end').classList.toggle('hidden', !(room.isHost && room.phase !== 'lobby'));
}

function renderScoreboard(room) {
  const list = $('#scoreboard');
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  list.innerHTML = '';
  for (const p of sorted) {
    const li = document.createElement('li');
    li.className = 'score-item';
    if (p.id === room.myId) li.classList.add('me');
    if (p.id === room.turnPlayerId) li.classList.add('is-turn');
    const [a, b] = avatarHue(p.name);
    const banBtn = room.isHost && p.id !== room.myId
      ? `<button class="ban-btn" data-bid="${p.id}">banir</button>` : '';
    li.innerHTML = `
      <span class="avatar" style="--avatar-a:${a};--avatar-b:${b}">${escapeHtml(p.name.charAt(0).toUpperCase())}</span>
      <span class="score-meta">
        <span class="score-name">${escapeHtml(p.name)}
          ${p.isHost ? '<span class="host-tag">anfitriao</span>' : ''}
          ${p.id === room.turnPlayerId ? '<span class="crown"></span>' : ''}
        </span>
        <span class="score-status">
          ${p.online ? '<span class="dot-online"></span>conectado' : 'offline'}
        </span>
      </span>
      <span class="match-wins-tag" title="Partidas vencidas">${p.matchWins}</span>
      <span class="score-points">${p.score}</span>
      ${banBtn}
    `;
    list.appendChild(li);
  }
}

$('#scoreboard').addEventListener('click', (e) => {
  const btn = e.target.closest('.ban-btn');
  if (!btn || !state.room) return;
  const name = btn.closest('.score-item').querySelector('.score-name').textContent.trim();
  if (confirm('Banir ' + name + ' desta sala?')) {
    AudioFX.click();
    send('banPlayer', { playerId: btn.dataset.bid });
  }
});

function avatarHue(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const h1 = hash % 360;
  const h2 = (h1 + 70) % 360;
  return [`hsl(${h1},75%,62%)`, `hsl(${h2},75%,55%)`];
}

function renderHistory(room) {
  const ul = $('#history');
  if (room.history.length === 0) {
    ul.innerHTML = '<li>Sem rodadas ainda.</li>';
    return;
  }
  ul.innerHTML = room.history.map((h) => `<li>${escapeHtml(h.summary)}</li>`).join('');
  ul.scrollTop = ul.scrollHeight;
}

function renderChat(room) {
  const ul = $('#chat');
  const newCount = room.chat.length;
  const shouldScroll = newCount > state.chatCount;
  state.chatCount = newCount;
  if (room.chat.length === 0) {
    ul.innerHTML = '<li class="msg-system">Bem-vindo a sala!</li>';
    return;
  }
  ul.innerHTML = room.chat.map((m) => {
    if (m.system) return `<li class="msg-system">${escapeHtml(m.text)}</li>`;
    const me = m.id === state.myId;
    const nameClass = me ? 'msg-name me' : 'msg-name';
    return `<li><span class="${nameClass}">${escapeHtml(m.name)}:</span> ${escapeHtml(m.text)}</li>`;
  }).join('');
  if (shouldScroll) ul.scrollTop = ul.scrollHeight;
}

function renderTurn(room) {
  const banner = $('#turn-banner');
  const turnPlayer = room.players.find((p) => p.id === room.turnPlayerId);
  if (!turnPlayer || room.phase === 'lobby') {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  $('#turn-name').textContent = turnPlayer.name;
  $('#turn-label').textContent =
    room.phase === 'reveal' || room.phase === 'matchEnd'
      ? 'Referencia da rodada:'
      : turnPlayer.id === state.myId
        ? 'E a sua vez!'
        : 'A vez de';
}

function renderPhase(room) {
  const isRoundPhase = room.phase === 'reveal' || room.phase === 'matchEnd';
  $('#phase-lobby').classList.toggle('hidden', room.phase !== 'lobby');
  $('#phase-choose').classList.toggle('hidden', room.phase !== 'choose');
  $('#phase-reveal').classList.toggle('hidden', !isRoundPhase);

  if (room.phase === 'lobby') renderLobby(room);
  else if (room.phase === 'choose') renderChoose(room);
  else if (isRoundPhase) renderReveal(room);
}

function renderLobby(room) {
  const n = room.players.length;
  $('#lobby-msg').textContent =
    n < 2
      ? `Aguardando jogadores... (${n}/8)`
      : `Jogadores suficientes (${n}/8). Pronto para começar!`;
  $('#btn-start').classList.toggle('hidden', !(room.isHost && n >= 2));
  $('#mode-row').classList.toggle('hidden', !room.isHost);
  $('#mode-display').classList.toggle('hidden', room.isHost);
  if (room.isHost) {
    $('#mode-select').value = room.matchMode;
  } else {
    $('#mode-display').textContent = 'Modo da partida: ' + modeLabel(room.matchMode);
  }
}

function renderChoose(room) {
  const cards = $$('#cards .card');
  const myChoice = room.myChoice;
  for (const card of cards) {
    card.classList.toggle('chosen', card.dataset.choice === myChoice);
  }
  const paused = Boolean(room.paused);
  $('#pause-overlay').classList.toggle('hidden', !paused);
  $('#locked-msg').classList.toggle('hidden', !myChoice);
  $('#choose-hint').textContent = paused
    ? 'Jogo pausado pelo anfitriao...'
    : myChoice
      ? `Sua escolha: ${CHOICE_NAME[myChoice]}`
      : 'Escolha sua carta!';
  startTimerLoop(room);
}

function renderReveal(room) {
  const isMatchEnd = room.phase === 'matchEnd';
  const winner = room.players.find((p) => p.id === room.matchWinnerId);
  const banner = $('#match-winner-banner');
  if (isMatchEnd && winner) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <div class="mw-label">Fim de partida</div>
      <div class="mw-name">${escapeHtml(winner.name)}</div>
      <div class="mw-sub">venceu a partida (${modeLabel(room.matchMode)})</div>
    `;
    if (winner.id === room.myId) {
      confettiBurst();
      AudioFX.win();
    }
  } else {
    banner.classList.add('hidden');
  }

  $('#btn-next').textContent = isMatchEnd ? 'Nova partida' : 'Proxima rodada';

  const grid = $('#reveal-grid');
  const ref = room.players.find((p) => p.id === room.turnPlayerId);
  const playersWithChoice = room.players.filter((p) => room.choices[p.id]);
  const others = playersWithChoice.filter((p) => p.id !== room.turnPlayerId);
  const ordered = ref ? [ref, ...others] : playersWithChoice;

  grid.innerHTML = ordered.map((p, i) => {
    const choice = room.choices[p.id];
    let badge;
    if (p.id === room.turnPlayerId) {
      const w = room.outcomes[p.id].won.length;
      const l = room.outcomes[p.id].lost.length;
      const d = room.outcomes[p.id].drew.length;
      badge = `<span class="reveal-badge ref">REF ${w}V·${l}D·${d}E</span>`;
    } else {
      const out = room.outcomes[p.id] || { won: [], lost: [], drew: [] };
      let res = out.drew.includes(room.turnPlayerId) ? 'draw' : (out.won.includes(room.turnPlayerId) ? 'win' : 'loss');
      const txt = res === 'win' ? 'Venceu' : res === 'loss' ? 'Perdeu' : 'Empatou';
      badge = `<span class="reveal-badge ${res}">${txt}</span>`;
    }
    return `
      <div class="reveal-card" style="animation-delay:${i * 0.12}s">
        <span class="reveal-name">${escapeHtml(p.name)}${p.id === room.myId ? ' (voce)' : ''}</span>
        ${ICONS[choice] || ''}
        <span class="reveal-name">${CHOICE_NAME[choice]}</span>
        ${badge}
      </div>
    `;
  }).join('');

  startAutoNext(room);
}

/* resultado para mim */
function evaluateResult(room) {
  const my = room.outcomes[room.myId];
  if (!my) return;
  AudioFX.reveal();
  if (room.myId === room.turnPlayerId) {
    if (my.won.length > 0 && my.lost.length === 0) { AudioFX.win(); confettiBurst(); }
    else if (my.lost.length > 0) AudioFX.lose();
    else AudioFX.draw();
  } else if (my.won.includes(room.turnPlayerId)) {
    AudioFX.win();
    confettiBurst();
  } else if (my.lost.includes(room.turnPlayerId)) {
    AudioFX.lose();
  } else {
    AudioFX.draw();
  }
}

/* ============================ TIMER ============================ */
function startTimerLoop(room) {
  if (state.animId) { cancelAnimationFrame(state.animId); state.animId = null; }
  state.lastTickSecond = 99;
  const total = room.timerSeconds * 1000;

  const step = () => {
    const r = state.room;
    if (!r || r.phase !== 'choose') {
      state.animId = null;
      return;
    }
    let remain;
    if (r.paused) {
      remain = r.pausedRemaining;
    } else {
      remain = Math.max(0, r.deadline - Date.now());
    }
    const sec = Math.ceil(remain / 1000);
    const fg = $('#ring-fg');
    const num = $('#timer-num');
    if (fg) {
      fg.style.strokeDashoffset = RING_C * (1 - remain / total);
      fg.classList.toggle('danger', sec <= 3 && remain > 0);
    }
    if (num) num.textContent = sec;
    if (sec !== state.lastTickSecond) {
      state.lastTickSecond = sec;
      if (sec > 0 && sec <= 3) AudioFX.tick();
      if (sec === 0 && !r.paused) {
        $('#choose-hint').textContent = 'Tempo esgotado!';
      }
    }
    state.animId = requestAnimationFrame(step);
  };
  state.animId = requestAnimationFrame(step);
}

function startAutoNext(room) {
  const num = $('#auto-next-num');
  const tick = () => {
    if (!state.room || (state.room.phase !== 'reveal' && state.room.phase !== 'matchEnd')) return;
    const remain = Math.max(0, Math.ceil((state.room.revealUntil - Date.now()) / 1000));
    num.textContent = remain;
    setTimeout(tick, 250);
  };
  tick();
}

/* ============================ INTERAÇÕES ============================ */
$('#cards').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !state.room || state.room.phase !== 'choose' || state.room.paused) return;
  const choice = card.dataset.choice;
  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const color = getComputedStyle(card).getPropertyValue('--card-a').trim();
  AudioFX.choose();
  sparks(cx, cy, color || '#7c6bff');
  shockwave(cx, cy);
  send('choice', { choice });
});

$('#btn-start').addEventListener('click', () => {
  AudioFX.click();
  send('start');
});

$('#mode-select').addEventListener('change', () => {
  AudioFX.click();
  send('config', { matchMode: $('#mode-select').value });
});

$('#btn-pause').addEventListener('click', () => {
  if (!state.room) return;
  AudioFX.click();
  send('pause', { paused: !state.room.paused });
});

$('#btn-end').addEventListener('click', () => {
  if (!state.room) return;
  if (confirm('Encerrar a partida agora? O lider atual sera registrado como vencedor.')) {
    AudioFX.click();
    send('endMatch', {});
  }
});

$('#btn-leave').addEventListener('click', () => {
  if (state.room) send('leave', {});
  AudioFX.click();
  resetToEntry();
  toast('Voce saiu da sala.');
});

$('#btn-next').addEventListener('click', () => {
  AudioFX.click();
  send('next');
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  AudioFX.click();
  send('chat', { text });
  input.value = '';
});

$('#btn-copy').addEventListener('click', async () => {
  const url = location.origin + location.pathname + '?room=' + state.lastRoomCode;
  try {
    await navigator.clipboard.writeText(url);
    const btn = $('#btn-copy');
    btn.style.color = '#34d399';
    setTimeout(() => (btn.style.color = ''), 1200);
  } catch (e) {}
});

/* ============================ RECONEXÃO ============================ */
function showReconnect() {
  $('#choose-hint').textContent = 'Conexao perdida. Reconectando...';
  scheduleReconnect();
}

function hideReconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.room && state.room.phase === 'choose' && !state.room.myChoice && !state.room.paused) {
    $('#choose-hint').textContent = 'Escolha sua carta!';
  }
}

function scheduleReconnect() {
  state.reconnectTries += 1;
  const delay = Math.min(1000 * Math.pow(1.6, state.reconnectTries - 1), 8000);
  state.reconnectTimer = setTimeout(() => {
    if (!state.connected) connect();
  }, delay);
}

/* ============================ INICIALIZAÇÃO ============================ */
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  $('#code-input').value = urlRoom.toUpperCase();
  $('#name-input').focus();
}

connect();
