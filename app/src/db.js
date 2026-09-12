import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import config from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(path.join(config.dataDir, 'archive.db'))
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  bucket TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_index_at INTEGER,
  last_index_ms INTEGER,
  last_error TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  dir TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER,
  UNIQUE (category_id, key)
);
CREATE INDEX IF NOT EXISTS idx_files_cat_dir ON files (category_id, dir);
CREATE INDEX IF NOT EXISTS idx_files_ext ON files (ext);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, path, content=''
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts (rowid, name, path) VALUES (new.id, new.name, new.key);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts (files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.key);
END;

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  file_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_exp ON tokens (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`)

// ---------- meta helpers ----------
const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?')
const setMetaStmt = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v')

export function getMeta (k) {
  const row = getMetaStmt.get(k)
  return row ? row.v : null
}

export function setMeta (k, v) {
  setMetaStmt.run(k, String(v))
}

// ---------- settings (env defaults, admin overridable) ----------
const SETTING_RANGES = {
  index_interval_hours: { min: 0, max: 168, def: config.indexIntervalHours },
  token_ttl_min: { min: 1, max: 60, def: config.tokenTtlMinutes },
  dl_expiry_sec: { min: 30, max: 3600, def: config.dlExpirySeconds }
}

export function getSettings () {
  const out = {}
  for (const [k, spec] of Object.entries(SETTING_RANGES)) {
    const v = parseInt(getMeta(k) ?? '', 10)
    out[k] = Number.isFinite(v) && v >= spec.min && v <= spec.max ? v : spec.def
  }
  return out
}

export function setSetting (k, v) {
  const spec = SETTING_RANGES[k]
  if (!spec) return false
  const n = parseInt(v, 10)
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) return false
  setMeta(k, String(n))
  return true
}

// ---------- admin log ----------
const logStmt = db.prepare('INSERT INTO admin_log (at, action, detail) VALUES (?, ?, ?)')
export function adminLog (action, detail) {
  try { logStmt.run(Date.now(), action, String(detail ?? '').slice(0, 300)) } catch { /* ignore */ }
}

// ---------- maintenance ----------
export function cleanup () {
  const now = Date.now()
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now - 24 * 3600e3)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
}

export default db
