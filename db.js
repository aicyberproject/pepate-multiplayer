const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SQLITE_FILE = path.join(DATA_DIR, 'ppt.sqlite');
const JSON_FILE = path.join(DATA_DIR, 'ppt.json');

let backend = null;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(SQLITE_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS stats (
        name TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        last_win_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        winner_name TEXT NOT NULL,
        mode TEXT,
        played_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS bans (
        name TEXT PRIMARY KEY,
        banned_by TEXT,
        reason TEXT,
        banned_at INTEGER
      );
    `);
    backend = {
      kind: 'sqlite',
      recordMatch(name, mode) {
        const now = Date.now();
        db.prepare('INSERT INTO matches (winner_name, mode, played_at) VALUES (?, ?, ?)').run(name, mode, now);
        db.prepare(`
          INSERT INTO stats (name, wins, last_win_at) VALUES (?, 1, ?)
          ON CONFLICT(name) DO UPDATE SET
            wins = wins + 1,
            last_win_at = excluded.last_win_at
        `).run(name, now);
      },
      getStats(limit) {
        return db.prepare('SELECT name, wins FROM stats ORDER BY wins DESC, last_win_at ASC LIMIT ?').all(limit);
      },
      getRecent(limit) {
        return db.prepare('SELECT winner_name, mode, played_at FROM matches ORDER BY id DESC LIMIT ?').all(limit);
      },
      isBanned(name) {
        return Boolean(db.prepare('SELECT 1 FROM bans WHERE name = ?').get(name.toLowerCase()));
      },
      addBan(name, by, reason) {
        db.prepare(`
          INSERT INTO bans (name, banned_by, reason, banned_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            banned_by = excluded.banned_by,
            reason = excluded.reason,
            banned_at = excluded.banned_at
        `).run(name.toLowerCase(), by, reason, Date.now());
      },
      removeBan(name) {
        db.prepare('DELETE FROM bans WHERE name = ?').run(name.toLowerCase());
      },
    };
  } catch (e) {
    const data = { stats: {}, matches: [], bans: {} };
    if (fs.existsSync(JSON_FILE)) {
      try {
        Object.assign(data, JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')));
      } catch (e2) {
        /* arquivo corrompido: recomeça */
      }
    }
    const persist = () => {
      fs.writeFileSync(JSON_FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(JSON_FILE + '.tmp', JSON_FILE);
    };
    backend = {
      kind: 'json',
      recordMatch(name, mode) {
        const now = Date.now();
        data.matches.push({ winner_name: name, mode, played_at: now });
        data.stats[name] = (data.stats[name] || 0) + 1;
        persist();
      },
      getStats(limit) {
        return Object.entries(data.stats)
          .map(([name, wins]) => ({ name, wins }))
          .sort((a, b) => b.wins - a.wins)
          .slice(0, limit);
      },
      getRecent(limit) {
        return data.matches.slice(-limit).reverse();
      },
      isBanned(name) {
        return Boolean(data.bans[name.toLowerCase()]);
      },
      addBan(name, by, reason) {
        data.bans[name.toLowerCase()] = { banned_by: by, reason, banned_at: Date.now() };
        persist();
      },
      removeBan(name) {
        delete data.bans[name.toLowerCase()];
        persist();
      },
    };
  }
  return backend;
}

const store = init();

module.exports = {
  store,
  backendKind: backend.kind,
};
