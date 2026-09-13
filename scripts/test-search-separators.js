#!/usr/bin/env node
/**
 * E2E search-separator test: boot the REAL app with realistic dot/dash/underscore
 * filenames (like real TV rips), then hit the REAL /api/search endpoint with
 * space-separated queries. Verifies "alice in" finds "Alice.in.Borderland...".
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve('/home/z/my-project/akilas-archive')
const dataDir = path.join(root, '.search-test-data')
const PORT = 3930 + Math.floor(Math.random() * 40)
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

const ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '0',
  R2_ACCESS_KEY_ID: 'x',
  R2_SECRET_ACCESS_KEY: 'x',
  DOWNLOAD_SECRET: 'search-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'search-test-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'SearchPass123',
  DL_MODE: 'presign',
  DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:' + PORT,
  PORT: String(PORT)
}

// ---- seed a DB directly (same schema the app creates at boot) ----
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
CREATE INDEX idx_files_cat_dir ON files (category_id, dir);
CREATE INDEX idx_files_ext ON files (ext);
CREATE VIRTUAL TABLE files_fts USING fts5(name, path, content='');
CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts (rowid, name, path) VALUES (new.id, new.name, new.key);
END;
CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts (files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.key);
END;
`)

const TV = [
  'Alice.in.Borderland.S01E01.1080p.x264-GROUP.mkv',
  'Alice.in.Borderland.S01E02.1080p.x264-GROUP.mkv',
  'Alice.in.Borderland.S02E05.2160p.WEB-DL.DDP5.1.x264.mkv',
  'Breaking.Bad.S01E01.720p.BluRay.x264.mkv',
  'Mr.Robot.S03E07.mkv'
]
const MOVIES = [
  'alice_in_wonderland_1951_1080p_bluray.mkv',
  'Alice in Wonderland (2010) 1080p.mkv',
  'the-matrix-1999-1080p-bluray.mkv',
  'Dune.Part.Two.2024.1080p.WEB-DL.x264.mkv'
]
const MUSIC = ['Daft Punk - Discovery (2001) FLAC/01 - One More Time.flac']

const insCat = db.prepare('INSERT INTO categories (name, slug, bucket, enabled, created_at, last_index_at, last_index_ms, last_error, file_count, total_size) VALUES (?, ?, ?, 1, ?, ?, 1, NULL, ?, ?)')
const insFile = db.prepare('INSERT INTO files (category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
function addCat (name, bucket, keys) {
  const r = insCat.run(name, name, bucket, Date.now(), Date.now(), keys.length, keys.length * 1234567)
  for (const key of keys) {
    const i = key.lastIndexOf('/')
    const dir = i < 0 ? '' : key.slice(0, i)
    const fname = i < 0 ? key : key.slice(i + 1)
    const ext = (fname.match(/\.([a-z0-9]{1,8})$/) ?? [])[1] ?? ''
    insFile.run(r.lastInsertRowid, bucket, key, dir, fname, ext, 1234567, Date.now())
  }
}
addCat('tv', 'bkt-tv', [
  'Alice.in.Borderland/Alice.in.Borderland.S01E01.1080p.x264-GROUP.mkv',
  'Alice.in.Borderland/Alice.in.Borderland.S01E02.1080p.x264-GROUP.mkv',
  'Alice.in.Borderland/Alice.in.Borderland.S02E05.2160p.WEB-DL.DDP5.1.x264.mkv',
  'Breaking.Bad.S01E01.720p.BluRay.x264.mkv',
  'Mr.Robot.S03E07.mkv'
])
addCat('movies', 'bkt-movies', MOVIES)
addCat('music', 'bkt-music', MUSIC)
db.close()

// ---- boot the real app ----
const app = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

let passed = 0; let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

async function search (q, extra = '') {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}${extra}`)
  return r.json()
}

console.log('\n[1] space-separated multi-word vs dot-separated filenames')
let r = await search('alice in')
ok('"alice in" finds 3 episodes + 2 wonderland files', r.total === 5, `total=${r.total} → ${JSON.stringify(r.results?.map(x => x.name))}`)
ok('episodes ranked above wonderland (both tokens in name)', (r.results?.[0]?.name || '').includes('Borderland'))
r = await search('alice in borderland')
ok('"alice in borderland" finds the 3 episodes', r.total === 3, `total=${r.total}`)
r = await search('in wonderland')
ok('"in wonderland" finds both wonderland files', r.total === 2, `total=${r.total}`)

console.log('\n[2] single words still work')
r = await search('borderland')
ok('"borderland" finds 3 episodes (2 names + 3 dirs → 3 files)', r.total === 3, `total=${r.total}`)
r = await search('matrix')
ok('"matrix" finds the-matrix-1999', r.total === 1, `total=${r.total}`)

console.log('\n[3] mixed separators')
r = await search('alice wonderland')
ok('"alice wonderland" (cross separator) finds wonderland files', r.total === 2, `total=${r.total}`)
r = await search('breaking bad')
ok('"breaking bad" finds Breaking.Bad', r.total === 1, `total=${r.total}`)
r = await search('daft punk')
ok('"daft punk" finds music', r.total === 1, `total=${r.total}`)
r = await search('dune part two')
ok('"dune part two" finds Dune.Part.Two', r.total === 1, `total=${r.total}`)

console.log('\n[4] substring / LIKE mode')
r = await search('orderland')
ok('substring "orderland" (b-orderland) matches episodes via fallback', r.total === 3, `total=${r.total}`)
r = await search('alice in', '&mode=like')
ok('LIKE mode "alice in" now also matches dotted names (multi-token)', r.total === 5, `total=${r.total}`)

app.kill('SIGTERM')
await new Promise(r2 => setTimeout(r2, 500))
fs.rmSync(dataDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
