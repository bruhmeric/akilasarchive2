#!/usr/bin/env node
/**
 * Stats endpoint E2E: boots the app with seeded files + simulated token
 * activity, then exercises /admin/api/stats (auth, shape, values) and the
 * stats rendering path end-to-end.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve('/home/z/my-project/akilas-archive')
const dataDir = path.join(root, '.stats-test-data')
const PORT = 3890 + Math.floor(Math.random() * 30)
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

const ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '0', R2_ACCESS_KEY_ID: 'x', R2_SECRET_ACCESS_KEY: 'x',
  DOWNLOAD_SECRET: 'stats-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'stats-test-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'StatsPass123',
  DL_MODE: 'presign', DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:' + PORT,
  PORT: String(PORT)
}

// ---- seed DB with files + token activity ----
const req = createRequire(path.join(root, 'app', 'package.json'))
const Database = req('better-sqlite3')
const db = new Database(path.join(dataDir, 'archive.db'))
db.exec(`
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  bucket TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  last_index_at INTEGER, last_index_ms INTEGER, last_error TEXT,
  file_count INTEGER NOT NULL DEFAULT 0, total_size INTEGER NOT NULL DEFAULT 0);
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL, key TEXT NOT NULL, dir TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE files_fts USING fts5(name, path, content='');
CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts (rowid, name, path) VALUES (new.id, new.name, new.key);
END;
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
  file_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, ip TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT);
`)

const now = Date.now()
const insCat = db.prepare('INSERT INTO categories (name, slug, bucket, enabled, created_at, last_index_at, last_index_ms, last_error, file_count, total_size) VALUES (?,?,?,?,?,?,?,?,?,?)')
const insFile = db.prepare('INSERT INTO files (category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?,?,?,?,?,?,?,?)')

const tv = insCat.run('tv', 'tv', 'bkt-tv', 1, now, now, 100, null, 0, 0)
const movies = insCat.run('movies', 'movies', 'bkt-movies', 1, now, now, 100, null, 0, 0)
const disabled = insCat.run('archive', 'archive', 'bkt-arch', 0, now, now, 100, null, 0, 0)

const sizes = [5e6, 50e6, 500e6, 2e9, 15e9] // one per size bucket + extra
let tvFiles = 0; let tvBytes = 0; let mvFiles = 0; let mvBytes = 0
const addFile = (catId, bucket, name, size) => {
  const ext = (name.match(/\.([a-z0-9]{1,8})$/) ?? [])[1] ?? ''
  const r = insFile.run(catId, bucket, name, name, name, ext, size, now - Math.floor(Math.random() * 30 * 86400e3))
  if (catId === tv.lastInsertRowid) { tvFiles++; tvBytes += size } else if (catId === movies.lastInsertRowid) { mvFiles++; mvBytes += size }
  return r.lastInsertRowid
}
const f1 = addFile(tv.lastInsertRowid, 'bkt-tv', 'Alice.in.Borderland.S01E01.mkv', 500e6)
const f2 = addFile(tv.lastInsertRowid, 'bkt-tv', 'Alice.in.Borderland.S01E02.mkv', 2e9)
addFile(tv.lastInsertRowid, 'bkt-tv', 'notes.txt', 5e6)
addFile(tv.lastInsertRowid, 'bkt-tv', 'clip.mp4', 50e6)
addFile(movies.lastInsertRowid, 'bkt-movies', 'huge.remux.mkv', 15e9)
addFile(movies.lastInsertRowid, 'bkt-movies', 'small.mp3', 5e6)
const f3 = addFile(disabled.lastInsertRowid, 'bkt-arch', 'old.zip', 50e6)
db.prepare('UPDATE categories SET file_count = ?, total_size = ? WHERE id = ?').run(tvFiles, tvBytes, tv.lastInsertRowid)
db.prepare('UPDATE categories SET file_count = ?, total_size = ? WHERE id = ?').run(mvFiles, mvBytes, movies.lastInsertRowid)
db.prepare('UPDATE categories SET file_count = ?, total_size = ? WHERE id = ?').run(1, 50e6, disabled.lastInsertRowid)

// token activity: today, yesterday, 3 days ago; one file downloaded 3x
const insTok = db.prepare('INSERT INTO tokens (token_hash, file_id, created_at, expires_at, used_at, ip) VALUES (?,?,?,?,?,?)')
const tok = (fileId, daysAgo, used, ip) => insTok.run(
  'th' + Math.random().toString(36).slice(2).padEnd(20, 'x') + fileId + daysAgo + (used ? 'u' : 'n'),
  fileId, now - daysAgo * 86400e3, now - daysAgo * 86400e3 + 600e3, used ? now - daysAgo * 86400e3 + 60e3 : null, used ? ip : null
)
tok(f1, 0, true, '1.1.1.1'); tok(f1, 0, true, '2.2.2.2'); tok(f1, 1, true, '1.1.1.1')
tok(f2, 1, true, '3.3.3.3'); tok(f2, 3, true, '4.4.4.4')
tok(f2, 0, false, null); tok(f1, 2, false, null)
db.prepare('INSERT INTO admin_log (at, action, detail) VALUES (?, ?, ?)').run(now, 'login_fail', 'ip 9.9.9.9')
db.prepare('INSERT INTO admin_log (at, action, detail) VALUES (?, ?, ?)').run(now, 'login_ok', 'ip 1.1.1.1')
db.close()

const app = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

let passed = 0; let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

// login
const login = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.6.6.1' },
  body: JSON.stringify({ password: 'StatsPass123' })
})
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
ok('login ok', login.status === 200)

// unauthenticated blocked
const noAuth = await fetch(`http://127.0.0.1:${PORT}/admin/api/stats`)
ok('stats requires auth (401)', noAuth.status === 401)

const r = await fetch(`http://127.0.0.1:${PORT}/admin/api/stats`, { headers: { cookie } })
ok('stats 200 json', r.status === 200 && (r.headers.get('content-type') || '').includes('json'))
const s = await r.json()
console.log('  →', JSON.stringify(s).slice(0, 400), '…')

ok('totals.files = 7', s.totals?.files === 7, `got ${s.totals?.files}`)
ok('totals.bytes = sum of sizes', s.totals?.bytes === 5e6 + 50e6 + 500e6 + 2e9 + 15e9 + 5e6 + 50e6, `got ${s.totals?.bytes}`)
ok('categories includes disabled one', s.categories?.length === 3)
ok('enabled_categories = 2', s.enabled_categories === 2)
ok('extensions grouped (mkv count 3)', s.extensions?.find(e => e.ext === 'mkv')?.files === 3, JSON.stringify(s.extensions))
ok('size buckets present (5 nonempty)', (s.size_buckets || []).length === 5, JSON.stringify(s.size_buckets?.map(b => b.bucket)))
ok('bucket 1-10GB has 1 file', s.size_buckets?.find(b => /1.10 GB/.test(b.bucket))?.files === 1, JSON.stringify(s.size_buckets))
ok('bucket <10MB has 2 files', s.size_buckets?.find(b => /< 10 MB/.test(b.bucket))?.files === 2, JSON.stringify(s.size_buckets))
ok('buckets ordered smallest→largest', /^0/.test(s.size_buckets?.[0]?.bucket || '') && /^4/.test(s.size_buckets?.[s.size_buckets.length - 1]?.bucket || ''))

ok('links.retained: 4 used / 5 issued (boot cleanup pruned the 2-day+ tokens)', s.links?.retained?.used === 4 && s.links?.retained?.issued === 5, JSON.stringify(s.links?.retained))
ok('links.retained.unique_ips = 3 (pruned 4.4.4.4)', s.links?.retained?.unique_ips === 3, `got ${s.links?.retained?.unique_ips}`)
ok('links.last_24h: 2 used / 3 issued', s.links?.last_24h?.used === 2 && s.links?.last_24h?.issued === 3, JSON.stringify(s.links?.last_24h))

ok('downloads_by_day has 14 entries', s.downloads_by_day?.length === 14)
const todayUsed = s.downloads_by_day?.[s.downloads_by_day.length - 1]?.used
const yestUsed = s.downloads_by_day?.[s.downloads_by_day.length - 2]?.used
ok('today = 2, yesterday = 2 in daily series', todayUsed === 2 && yestUsed === 2, `today=${todayUsed} yest=${yestUsed}`)

ok('top download is S01E01 with 3', s.top_downloads?.[0]?.downloads === 3 && /S01E01/.test(s.top_downloads?.[0]?.name || ''), JSON.stringify(s.top_downloads?.[0]))
ok('largest file is huge.remux (15GB)', /huge.remux/.test(s.largest_files?.[0]?.name || ''), JSON.stringify(s.largest_files?.[0]))
ok('newest_files has 10 (LIMIT) of 7 → 7', s.newest_files?.length === 7, `got ${s.newest_files?.length}`)
ok('admin_log_7d: 3 events (incl. our own login), 1 fail, 2 logins', s.admin_log_7d?.events === 3 && s.admin_log_7d?.login_fails === 1 && s.admin_log_7d?.logins === 2, JSON.stringify(s.admin_log_7d))
ok('generated_at present', typeof s.generated_at === 'number')

app.kill('SIGTERM')
await new Promise(r2 => setTimeout(r2, 500))
fs.rmSync(dataDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
