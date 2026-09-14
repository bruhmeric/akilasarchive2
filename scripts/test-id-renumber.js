#!/usr/bin/env node
/**
 * File-id renumbering E2E: ids shown in the terminal (#N, `download N`) must
 * be contiguous 1..N matching the number of indexed files — not ever-climbing
 * AUTOINCREMENT rowids (the live DB had ids starting at 3000 after a few
 * re-index cycles, because every re-index deletes + re-inserts all rows and
 * SQLite never recycles AUTOINCREMENT ids).
 *
 * Phase A (in-process): simulate the 3000-start DB → boot compaction renumbers
 *   to 1..N in a deterministic order; one-time-link tokens are remapped to the
 *   SAME objects; dangling unused links pruned; FTS stays in sync; idempotent;
 *   no-op when already contiguous; gap repair.
 * Phase B (HTTP): boot the real server on a 3000-start DB → compaction runs at
 *   boot → browse / search / file info / link issue / link redeem all work on
 *   the new ids; a link issued BEFORE the renumber still downloads the SAME
 *   object; second boot is a no-op.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const root = path.resolve('/home/z/my-project/akilas-archive')

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

const BASE_ENV = {
  ...process.env,
  R2_ACCOUNT_ID: '0',
  R2_ACCESS_KEY_ID: 'x',
  R2_SECRET_ACCESS_KEY: 'x',
  DOWNLOAD_SECRET: 'idren-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'idren-test-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'IdRenPass123',
  DL_MODE: 'presign',
  DOWNLOAD_BASE_URL: 'https://dl.example.test'
}

// ---------------------------------------------------------------------------
// child mode: seed the phase-B database (fresh process → fresh db.js singleton
// bound to DATA_DIR_B), then exit. Invoked as:
//   node scripts/test-id-renumber.js --seed-b   (DATA_DIR + SEED_TOKEN in env)
// ---------------------------------------------------------------------------
if (process.argv.includes('--seed-b')) {
  const { db } = await import(path.join(root, 'app', 'src', 'db.js'))
  const { sha256hex } = await import(path.join(root, 'app', 'src', 'util.js'))

  const now = Date.now()
  const insCat = db.prepare(
    'INSERT INTO categories (name, slug, bucket, enabled, created_at, last_index_at, file_count, total_size) VALUES (?,?,?,?,?,?,?,?)'
  )
  const insFile = db.prepare(
    'INSERT INTO files (id, category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?,?,?,?,?,?,?,?,?)'
  )

  const catA = insCat.run('tv', 'tv', 'bkt-tv', 1, now, now, 3, 3e9).lastInsertRowid
  const catB = insCat.run('movies', 'movies', 'bkt-mv', 1, now, now, 2, 2e9).lastInsertRowid

  // explicit 3000-range ids = the user's live situation
  const rows = [
    [3001, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S01E01.mkv'],
    [3002, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S01E02.mkv'],
    [3003, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S01E03.mkv'],
    [3004, catB, 'bkt-mv', 'Films/dune.part.two.mkv'],
    [3005, catB, 'bkt-mv', 'Films/blade.runner.2049.mkv']
  ]
  for (const [id, cid, bucket, key] of rows) {
    const i = key.lastIndexOf('/')
    const dir = i < 0 ? '' : key.slice(0, i)
    insFile.run(id, cid, bucket, key, dir, key.slice(i + 1), 'mkv', 1e9, now)
  }

  // one-time link issued BEFORE the renumber, pointing at old id 3005
  // (blade.runner) — after boot compaction it must still download blade.runner
  db.prepare(
    'INSERT INTO tokens (token_hash, file_id, created_at, expires_at) VALUES (?,?,?,?)'
  ).run(sha256hex(process.env.SEED_TOKEN), 3005, now, now + 3600e3)

  db.close()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Phase A — renumber logic, in-process
// ---------------------------------------------------------------------------
console.log('phase A — renumber logic (in-process, simulated 3000-start DB)')
const dataDirA = path.join(root, '.idren-test-data')
fs.rmSync(dataDirA, { recursive: true, force: true })
fs.mkdirSync(dataDirA, { recursive: true })
process.env.DATA_DIR = dataDirA
Object.entries(BASE_ENV).forEach(([k, v]) => { process.env[k] = v })

const { db } = await import(path.join(root, 'app', 'src', 'db.js'))
const { renumberFiles, compactFileIdsAtBoot } = await import(path.join(root, 'app', 'src', 'indexer.js'))

const now = Date.now()
const insCat = db.prepare(
  'INSERT INTO categories (name, slug, bucket, enabled, created_at, last_index_at, file_count, total_size) VALUES (?,?,?,?,?,?,?,?)'
)
const insFile = db.prepare(
  'INSERT INTO files (id, category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?,?,?,?,?,?,?,?,?)'
)
const insTok = db.prepare(
  'INSERT INTO tokens (token_hash, file_id, created_at, expires_at, used_at, ip) VALUES (?,?,?,?,?,?)'
)

const catA = insCat.run('tv', 'tv', 'bkt-tv', 1, now, now, 0, 0).lastInsertRowid
const catB = insCat.run('movies', 'movies', 'bkt-mv', 1, now, now, 0, 0).lastInsertRowid

// explicit 3000-range ids: catA = tv files, catB = movies
const rows = [
  [3001, catB, 'bkt-mv', 'Films/blade.runner.2049.mkv'],
  [3002, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S02E01.mkv'],
  [3003, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S01E03.mkv'],
  [3004, catA, 'bkt-tv', 'Docs/readme.txt'],
  [3005, catB, 'bkt-mv', 'Films/dune.part.two.mkv'],
  [3006, catA, 'bkt-tv', 'Shows/Alice.in.Borderland.S01E01.mkv'],
  [3007, catB, 'bkt-mv', 'root.movie.mkv']
]
for (const [id, cid, bucket, key] of rows) {
  const i = key.lastIndexOf('/')
  const name = key.slice(i + 1)
  const ext = (name.match(/\.([a-z0-9]{1,8})$/) ?? [])[1] ?? ''
  const dir = i < 0 ? '' : key.slice(0, i)
  insFile.run(id, cid, bucket, key, dir, name, ext, 1e9, now)
}

// token fixtures:
//   live   — unused link to old id 3003 (Alice S01E03), still valid
//   hist   — USED link to old id 3001 (blade runner) — download history
//   dangU  — unused link to a vanished file (99999) — must be pruned
//   histD  — used link to a vanished file (88888) — kept as history
insTok.run('th_live', 3003, now, now + 600e3, null, null)
insTok.run('th_hist', 3001, now - 3600e3, now - 3600e3 + 600e3, now - 3600e3 + 60e3, '1.2.3.4')
insTok.run('th_dangU', 99999, now, now + 600e3, null, null)
insTok.run('th_histD', 88888, now - 7200e3, now - 7200e3 + 600e3, now - 7200e3 + 60e3, '5.6.7.8')

// --- run the boot compaction against the 3000-start table ---
const compacted = compactFileIdsAtBoot()
ok('boot compaction detects 3000-start DB and renumbers (returns 7)', compacted === 7, `got ${compacted}`)

const ids = db.prepare('SELECT id FROM files ORDER BY id').all().map(r => r.id)
ok('ids are exactly 1..7', JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), JSON.stringify(ids))

// deterministic order: category → dir → name (NOCASE) → key
const expectedOrder = [
  'Docs/readme.txt', // catA: Docs sorts before Shows
  'Shows/Alice.in.Borderland.S01E01.mkv',
  'Shows/Alice.in.Borderland.S01E03.mkv',
  'Shows/Alice.in.Borderland.S02E01.mkv',
  'root.movie.mkv', // catB: '' dir sorts before Films
  'Films/blade.runner.2049.mkv',
  'Films/dune.part.two.mkv'
]
const byId = db.prepare('SELECT id, key FROM files ORDER BY id').all()
ok('deterministic order (cat → dir → name): id N ↔ expected file', expectedOrder.every((k, i) => byId[i].key === k), JSON.stringify(byId))

// tokens follow their files
const liveKey = db.prepare("SELECT f.key FROM tokens t JOIN files f ON f.id = t.file_id WHERE t.token_hash = 'th_live'").get()
ok('active link remapped to the SAME object (Alice S01E03)', liveKey?.key === 'Shows/Alice.in.Borderland.S01E03.mkv', JSON.stringify(liveKey))
const histKey = db.prepare("SELECT f.key FROM tokens t JOIN files f ON f.id = t.file_id WHERE t.token_hash = 'th_hist'").get()
ok('used link (history) remapped to the SAME object (blade runner)', histKey?.key === 'Films/blade.runner.2049.mkv', JSON.stringify(histKey))
ok('unused dangling link pruned', db.prepare("SELECT COUNT(*) c FROM tokens WHERE token_hash = 'th_dangU'").get().c === 0)
ok('used dangling link kept as history', db.prepare("SELECT COUNT(*) c FROM tokens WHERE token_hash = 'th_histD'").get().c === 1)

// FTS stays in sync (rowid = files.id; triggers must have fired for the rebuild)
ok('FTS has exactly 7 rows (old purged, new rebuilt)', db.prepare('SELECT COUNT(*) c FROM files_fts').get().c === 7)
ok('FTS rowids align with new file ids', db.prepare('SELECT COUNT(*) c FROM files_fts x JOIN files f ON f.id = x.rowid').get().c === 7)
const ftsAlice = db.prepare("SELECT f.key FROM files_fts x JOIN files f ON f.id = x.rowid WHERE files_fts MATCH 'borderland'").all()
ok("FTS MATCH 'borderland' finds the 3 Alice files", ftsAlice.length === 3 && ftsAlice.every(r => /Alice\.in\.Borderland/.test(r.key)), JSON.stringify(ftsAlice))
const ftsReadme = db.prepare("SELECT f.id FROM files_fts x JOIN files f ON f.id = x.rowid WHERE files_fts MATCH 'readme'").get()
ok("FTS MATCH 'readme' resolves to new id 1", ftsReadme?.id === 1, JSON.stringify(ftsReadme))

// AUTOINCREMENT counter reset (next per-category re-index starts low again)
ok("sqlite_sequence row for 'files' reset", db.prepare("SELECT COUNT(*) c FROM sqlite_sequence WHERE name = 'files'").get().c === 0)

// idempotency: same file set ⇒ same ids
const snapshot = db.prepare('SELECT id, key FROM files ORDER BY id').all()
const again = renumberFiles()
const snapshot2 = db.prepare('SELECT id, key FROM files ORDER BY id').all()
ok('re-running renumber is idempotent (returns 7, ids unchanged)', again === 7 && JSON.stringify(snapshot) === JSON.stringify(snapshot2))
ok('FTS still consistent after second run', db.prepare('SELECT COUNT(*) c FROM files_fts').get().c === 7)
const liveKey2 = db.prepare("SELECT f.key FROM tokens t JOIN files f ON f.id = t.file_id WHERE t.token_hash = 'th_live'").get()
ok('active link still points at Alice S01E03', liveKey2?.key === 'Shows/Alice.in.Borderland.S01E03.mkv')

// no-op when already contiguous
ok('boot compaction is a no-op on a healthy table', compactFileIdsAtBoot() === 0)

// gap repair: a file disappearing (re-index / category delete) compacts again
db.prepare('DELETE FROM files WHERE id = 3').run() // fires files_ad → FTS row purged
const repaired = compactFileIdsAtBoot()
const idsAfterGap = db.prepare('SELECT id FROM files ORDER BY id').all().map(r => r.id)
ok('gap repaired: ids compact back to 1..6', repaired === 6 && JSON.stringify(idsAfterGap) === JSON.stringify([1, 2, 3, 4, 5, 6]), `repaired=${repaired} ids=${JSON.stringify(idsAfterGap)}`)
ok('link to the deleted file pruned (was unused+dangling)', db.prepare("SELECT COUNT(*) c FROM tokens WHERE token_hash = 'th_live'").get().c === 0)
ok('FTS consistent after gap repair', db.prepare('SELECT COUNT(*) c FROM files_fts').get().c === 6)

db.close()
fs.rmSync(dataDirA, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Phase B — real server boot on a 3000-start DB (boot compaction) + HTTP flow
// ---------------------------------------------------------------------------
console.log('\nphase B — server boot compaction + HTTP flow')
const dataDirB = path.join(root, '.idren-test-data-b')
fs.rmSync(dataDirB, { recursive: true, force: true })

const SEED_TOKEN = crypto.randomBytes(18).toString('hex')
const PORT = 3940 + Math.floor(Math.random() * 30)
const ENV = { ...BASE_ENV, DATA_DIR: dataDirB, SEED_TOKEN, PORT: String(PORT), PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}` }

// seed child (self-invocation)
const seed = spawn('node', [path.join(root, 'scripts', 'test-id-renumber.js'), '--seed-b'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => { seed.on('exit', c => c === 0 ? resolve() : reject(new Error('seed failed'))); seed.on('error', reject) })
ok('phase-B DB seeded (3000-start ids + pre-renumber link)', true)

const bootServer = () => {
  const out = []
  const child = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => out.push(String(d)))
  child.stderr.on('data', d => out.push(String(d)))
  return { child, logs: out }
}

const { child: srv1, logs: logs1 } = bootServer()
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

const base = `http://127.0.0.1:${PORT}`
await new Promise(r => setTimeout(r, 300)) // let boot log lines flush

ok('boot log reports the compaction', logs1.join('').includes('file ids compacted → 1..5'), logs1.join('').slice(0, 300))

const tv = await (await fetch(`${base}/api/browse/tv?path=Shows`)).json()
const mv = await (await fetch(`${base}/api/browse/movies?path=Films`)).json()
ok('browse/tv shows ids 1,2,3 (ascending)', JSON.stringify(tv.files.map(f => f.id)) === JSON.stringify([1, 2, 3]), JSON.stringify(tv.files))
ok('browse/movies shows ids 4,5', JSON.stringify(mv.files.map(f => f.id)) === JSON.stringify([4, 5]), JSON.stringify(mv.files))
ok('global ids exactly 1..5 across categories', [...tv.files, ...mv.files].map(f => f.id).sort((a, b) => a - b).join() === '1,2,3,4,5')

const f3 = await fetch(`${base}/api/file/3`)
const f3j = await f3.json()
ok('file info by new id (3 = S01E03)', f3.status === 200 && /S01E03/.test(f3j.name || ''), JSON.stringify(f3j))
ok('old 3000-range id is gone (404)', (await fetch(`${base}/api/file/3005`)).status === 404)

const search = await (await fetch(`${base}/api/search?q=alice`)).json()
ok('FTS search works on renumbered ids (3 hits)', search.total === 3 && search.results.every(r => r.id >= 1 && r.id <= 5), JSON.stringify(search.results?.map(r => r.id)))
const searchLike = await (await fetch(`${base}/api/search?q=blade&mode=like`)).json()
ok('LIKE search works on renumbered ids', searchLike.total === 1 && /blade/.test(searchLike.results?.[0]?.name || ''), JSON.stringify(searchLike))

// pre-renumber link: HEAD validates without consuming, GET redeems the SAME object
const head = await fetch(`${base}/get/${SEED_TOKEN}`, { method: 'HEAD' })
ok('pre-renumber link still validates (HEAD 200)', head.status === 200)
const redeem = await fetch(`${base}/get/${SEED_TOKEN}`, { redirect: 'manual' })
ok('pre-renumber link redeems to the SAME object (blade.runner)', redeem.status === 302 && /blade\.runner\.2049/.test(redeem.headers.get('location') || ''), redeem.headers.get('location'))

// fresh link on a new id works too
const dl = await (await fetch(`${base}/api/dl`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 2 })
})).json()
const fresh = await fetch(`${base}${dl.url}`, { redirect: 'manual' })
ok('new link issued for new id 2 downloads S01E02', dl.url?.startsWith('/get/') && fresh.status === 302 && /S01E02/.test(fresh.headers.get('location') || ''), JSON.stringify(dl))

srv1.kill('SIGTERM')
await new Promise(r => setTimeout(r, 600))

// second boot on the now-healthy DB: compaction must be a no-op
const { child: srv2, logs: logs2 } = bootServer()
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}
await new Promise(r => setTimeout(r, 300))
ok('second boot: no compaction needed (no-op)', !logs2.join('').includes('file ids compacted'), logs2.join('').slice(0, 300))
ok('ids survive a reboot unchanged (file 1 = S01E01)', (await (await fetch(`${base}/api/file/1`)).json()).name === 'Alice.in.Borderland.S01E01.mkv')

srv2.kill('SIGTERM')
await new Promise(r => setTimeout(r, 500))
fs.rmSync(dataDirB, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
