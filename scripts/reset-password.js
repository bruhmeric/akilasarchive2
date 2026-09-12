#!/usr/bin/env node
// Reset the admin password directly in the SQLite DB — no app restart needed.
//
// Usage (inside the running container — recommended):
//   docker compose exec app node scripts/reset-password.js 'MyNewPass123'
//
// What it does:
//   - overwrites the stored admin password hash (env ADMIN_PASSWORD is only
//     read on FIRST boot; after that the DB value wins)
//   - clears the "password_is_default" flag
//   - deletes all admin sessions (forces re-login)
// Safe to run while the app is up: reads/writes via SQLite WAL with busy_timeout.
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const [, , pw, pwConfirm] = process.argv

if (!pw || pw.length < 8) {
  console.error('usage: node scripts/reset-password.js <new-password>   (minimum 8 characters)')
  process.exit(1)
}
if (pwConfirm !== undefined && pwConfirm !== pw) {
  console.error('passwords do not match')
  process.exit(1)
}

// resolve better-sqlite3 in both layouts:
//   in Docker:  /app/scripts + /app/node_modules  → plain import works
//   in repo:    ./scripts + ./app/node_modules     → resolve via app/package.json
let Database
try {
  ;({ default: Database } = await import('better-sqlite3'))
} catch {
  const { createRequire } = await import('node:module')
  const req = createRequire(path.join(__dirname, '..', 'app', 'package.json'))
  Database = req('better-sqlite3')
}

// resolve the DB the same way the app does: DATA_DIR env, else ./data next to app/
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const dbPath = path.join(dataDir, 'archive.db')

let db
try {
  db = new Database(dbPath)
} catch (e) {
  console.error(`cannot open ${dbPath} — ${e.message}`)
  console.error('set DATA_DIR if your database lives elsewhere')
  process.exit(1)
}
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 8000')

// make sure the meta table exists (fresh volume edge case)
db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')

// hash format must match app/src/util.js scryptHash(): s2$N$r$p$salt$key (base64url)
const N = 16384; const r = 8; const p = 1
const salt = crypto.randomBytes(16)
const key = crypto.scryptSync(pw, salt, 32, { N, r, p })
const hash = `s2$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`

const tx = db.transaction(() => {
  db.prepare("INSERT INTO meta (k, v) VALUES ('admin_password', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(hash)
  db.prepare("INSERT INTO meta (k, v) VALUES ('password_is_default', '0') ON CONFLICT (k) DO UPDATE SET v = excluded.v").run()
  try { db.prepare('DELETE FROM sessions').run() } catch { /* table may not exist on a fresh DB */ }
})
tx()
db.close()

console.log(`ok — admin password reset (${dbPath})`)
console.log('note: failed-login lockouts are in-memory and clear on their own in 15 min')
