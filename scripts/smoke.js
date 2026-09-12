#!/usr/bin/env node
/**
 * Full smoke test: seeds a demo DB, boots the app, exercises every public
 * and admin endpoint (incl. one-time link flow in worker + presign modes),
 * then shuts down. Run: node scripts/smoke.js
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const appDir = path.join(root, 'app')
const dataDir = path.join(root, '.smoke-data')

const ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_ACCESS_KEY_ID: 'dummykey',
  R2_SECRET_ACCESS_KEY: 'dummysecret',
  DOWNLOAD_SECRET: 'smoke-download-secret-0123456789abcdef',
  SESSION_SECRET: 'smoke-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'test1234',
  DL_MODE: 'worker',
  DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:3999',
  PORT: '3999'
}

let passed = 0; let failed = 0
function ok (name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name} ${extra}`) }
}

function seed () {
  execSync('node scripts/seed-demo.js', { cwd: root, env: { ...ENV }, stdio: 'pipe' })
}

async function waitHealthy (port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

async function main () {
  fs.rmSync(dataDir, { recursive: true, force: true })
  seed()

  const proc = spawn('node', ['src/server.js'], { cwd: appDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  proc.stdout.on('data', d => logs.push(d.toString()))
  proc.stderr.on('data', d => logs.push(d.toString()))

  try {
    ok('server boots healthy', await waitHealthy(3999))

    const B = 'http://127.0.0.1:3999'

    // ── static / public ──
    const home = await fetch(B + '/')
    const homeHtml = await home.text()
    ok('GET / serves terminal', home.status === 200 && homeHtml.includes('terminal.css') && homeHtml.includes('cli'))
    ok('no backend details in HTML', !/r2\.cloudflarestorage|workers\.dev|bucket/i.test(homeHtml))
    const rob = await (await fetch(B + '/robots.txt')).text()
    ok('robots.txt hides admin/api/get', rob.includes('Disallow: /admin') && rob.includes('Disallow: /get'))

    const cats = (await (await fetch(B + '/api/categories')).json()).categories
    ok('categories listed', cats.length === 3 && cats.every(c => !('bucket' in c)))
    const stats = await (await fetch(B + '/api/stats')).json()
    ok('stats: 16 files', stats.files === 16)

    // ── browse ──
    const br = await (await fetch(B + '/api/browse/movies')).json()
    ok('browse root shows subdirs', br.dirs.map(d => d.name).join(',') === 'Action,Animation,Classics,Movies In Tamil,Sci-Fi')
    const br2 = await (await fetch(B + '/api/browse/movies?path=Action/The%20Matrix%20(1999)')).json()
    ok('browse deep path', br2.files.length === 1 && br2.files[0].name.includes('The.Matrix.1999'))
    const br404 = await fetch(B + '/api/browse/movies?path=Nope')
    ok('browse unknown path 404', br404.status === 404)
    const br404c = await fetch(B + '/api/browse/ghost')
    ok('browse unknown category 404', br404c.status === 404)

    // ── search: FTS, unicode, filters, sort, pagination ──
    let s = await (await fetch(B + '/api/search?q=matrix')).json()
    ok('FTS search "matrix" finds 2', s.total === 2 && s.results.every(r => r.name.toLowerCase().includes('matrix')))
    s = await (await fetch(B + '/api/search?q=%E0%AE%9A%E0%AE%BF%E0%AE%A9%E0%AE%BF%E0%AE%AE%E0%AE%BE')).json()
    ok('unicode FTS search (Tamil)', s.total === 1)
    s = await (await fetch(B + '/api/search?q=silva')).json()
    ok('substring LIKE fallback', s.total === 1 && s.results[0].name.includes('ගීතය'))
    s = await (await fetch(B + '/api/search?q=720p&type=mkv&min=1100000000&sort=size&order=desc')).json()
    ok('filters (type+min+sort size desc)', s.total === 4 && s.results[0].name.includes('matrix.reloaded') && s.results.every(r => r.size >= 1100000000 && r.ext === 'mkv'))
    s = await (await fetch(B + '/api/search?q=breaking&cat=tv&limit=2&page=1')).json()
    ok('pagination page1 (limit 2)', s.results.length === 2 && s.pages === 2)
    s = await (await fetch(B + '/api/search?q=breaking&cat=tv&limit=2&page=2')).json()
    ok('pagination page2', s.results.length === 1)
    const sBad = await fetch(B + '/api/search?q=')
    ok('empty query 400', sBad.status === 400)
    // public payloads never contain bucket or key
    const payload = JSON.stringify(await (await fetch(B + '/api/search?q=mkv')).json())
    ok('search payload hides buckets', !payload.includes('demo-movies-bucket') && !payload.includes('"key"'))

    // ── file info ──
    const fi = await (await fetch(B + '/api/file/1')).json()
    ok('file info by id', fi.id === 1 && fi.cat.slug === 'movies' && fi.name.includes('The.Matrix'))

    // ── one-time link flow (worker mode) ──
    const dlRes = await fetch(B + '/api/dl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1 }) })
    const dl = await dlRes.json()
    ok('POST /api/dl issues token', dlRes.status === 200 && dl.url.startsWith('/get/'))
    const head1 = await fetch(B + dl.url, { method: 'HEAD' })
    ok('HEAD does not consume link', head1.status === 200)
    const get1 = await fetch(B + dl.url, { redirect: 'manual' })
    const loc = get1.headers.get('location') || ''
    const expectedSig = crypto.createHmac('sha256', ENV.DOWNLOAD_SECRET)
      .update('demo-movies-bucket\nAction/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x265.mkv\n' + new URL(loc).searchParams.get('exp') + '\n' + new URL(loc).searchParams.get('n'))
      .digest('hex')
    ok('302 to worker URL with valid HMAC', get1.status === 302 && new URL(loc).searchParams.get('s') === expectedSig)
    ok('worker URL is b64+path only', new URL(loc).pathname.startsWith('/d/') && !loc.includes('demo-movies-bucket'))
    const get2 = await fetch(B + dl.url, { redirect: 'manual' })
    ok('second use → 410 (one-time!)', get2.status === 410)
    const get3 = await fetch(B + '/get/nonexistenttoken', { redirect: 'manual' })
    ok('unknown token → 404 page', get3.status === 404 && (await get3.text()).includes('AKILAS'))

    // ── rate limit sanity (a burst of dl requests) ──
    const burst = await fetch(B + '/api/dl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 999999 }) })
    ok('download of missing file 404', burst.status === 404)

    // ── admin ──
    const noAuth = await fetch(B + '/admin/api/status')
    ok('admin blocked without session', noAuth.status === 401)
    const badLogin = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })
    ok('wrong password 401', badLogin.status === 401)
    const login = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test1234' }) })
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    ok('login sets session cookie', login.status === 200 && cookie.startsWith('aa_sid='))
    const st = await (await fetch(B + '/admin/api/status', { headers: { cookie } })).json()
    ok('admin status sees buckets', st.categories.length === 3 && st.categories[0].bucket.startsWith('demo-'))
    // reindex a category (R2 is fake → must fail gracefully with sanitized error)
    const re = await fetch(B + '/admin/api/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ id: st.categories[0].id }) })
    ok('reindex accepted (queued)', re.status === 200)
    await new Promise(r => setTimeout(r, 5000))
    const st2 = await (await fetch(B + '/admin/api/status', { headers: { cookie } })).json()
    ok('bad R2 creds → last_error recorded, no crash', !!st2.categories.find(c => c.id === st.categories[0].id)?.last_error && st2.indexer)
    // disable a category → hidden from public
    const patch = await fetch(B + `/admin/api/categories/${st.categories[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ enabled: false }) })
    ok('PATCH disable ok', patch.status === 200)
    const cats2 = (await (await fetch(B + '/api/categories')).json()).categories
    ok('disabled category hidden publicly', cats2.length === 2)
    // settings
    const setRes = await fetch(B + '/admin/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ token_ttl_min: 5 }) })
    ok('settings update', setRes.status === 200 && (await setRes.json()).settings.token_ttl_min === 5)
    // password change
    const pw = await fetch(B + '/admin/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ current: 'test1234', next: 'newpass12345' }) })
    ok('password change ok', pw.status === 200)
    const login2 = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'newpass12345' }) })
    ok('login works with new password', login2.status === 200)
    // logs
    const logsRes = await (await fetch(B + '/admin/api/logs', { headers: { cookie: login2.headers.get('set-cookie').split(';')[0] } })).json()
    ok('admin log has entries', logsRes.logs.length > 0 && logsRes.logs.some(l => l.action === 'login_ok'))
    // admin static shell
    const adminHtml = await (await fetch(B + '/admin')).text()
    ok('admin SPA served', adminHtml.includes('root console'))

    // 404s
    const nf = await fetch(B + '/api/whatever')
    ok('api 404 is JSON', nf.status === 404 && (await nf.json()).error === 'not_found')
  } finally {
    proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 400))
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
  }

  // ── presign mode (separate boot) ──
  fs.rmSync(path.join(dataDir, 'archive.db-wal'), { force: true })
  const proc2 = spawn('node', ['src/server.js'], {
    cwd: appDir,
    env: { ...ENV, DL_MODE: 'presign' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc2.stdout.on('data', d => logs.push(d.toString()))
  proc2.stderr.on('data', d => logs.push(d.toString()))
  try {
    ok('presign boot healthy', await waitHealthy(3999))
    const sres = await (await fetch('http://127.0.0.1:3999/api/search?q=flac')).json()
    const fileId = sres.results?.[0]?.id
    const dl = await (await fetch('http://127.0.0.1:3999/api/dl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fileId }) })).json()
    const red = await fetch('http://127.0.0.1:3999' + dl.url, { redirect: 'manual' })
    const loc = red.headers.get('location') || ''
    ok('presign 302 to signed R2 URL', red.status === 302 &&
      loc.startsWith('https://00000000000000000000000000000000.r2.cloudflarestorage.com/demo-music-bucket/') &&
      loc.includes('X-Amz-Signature=') && loc.includes('X-Amz-Expires=300'))
  } finally {
    proc2.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 300))
    if (proc2.exitCode === null && !proc2.killed) proc2.kill('SIGKILL')
  }

  console.log(`\n══ smoke: ${passed} passed · ${failed} failed ══`)
  if (failed) {
    console.log('── server logs (tail) ──')
    console.log(logs.slice(-40).join(''))
    process.exit(1)
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
}

main().catch(e => { console.error(e); process.exit(1) })
