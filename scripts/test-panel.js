#!/usr/bin/env node
/**
 * Panel verification: boots the app like the Docker container does
 * (fresh DATA_DIR, PORT, env-only config) and checks the admin panel
 * actually loads: SPA HTML, health, login, session, categories API.
 * Simulates the user's post-`rm -rf data` state.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(root, '.panel-test-data')
const PORT = 3900 + Math.floor(Math.random() * 90)
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

const ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_ACCESS_KEY_ID: 'dummykey',
  R2_SECRET_ACCESS_KEY: 'dummysecret',
  DOWNLOAD_SECRET: 'panel-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'panel-test-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'PanelPass123',
  DL_MODE: 'worker',
  DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:' + PORT,
  NODE_ENV: 'production',
  PORT: String(PORT)
}

let passed = 0; let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

const app = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
app.stdout.on('data', d => process.stdout.write(d.toString().match(/.*/g).filter(l => l.includes('listening') || l.includes('auth')).join('\n') + '\n'))
app.stderr.on('data', d => process.stderr.write('[stderr] ' + d))

// ---------- wait for health ----------
let healthy = false
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { healthy = true; break } } catch {}
  await new Promise(r => setTimeout(r, 250))
}
ok('app boots and /api/health responds', healthy)

// ---------- public terminal ----------
const term = await fetch(`http://127.0.0.1:${PORT}/`)
ok('terminal page loads (200, html)', term.status === 200 && (term.headers.get('content-type') || '').includes('text/html'))

// ---------- admin panel ----------
const panel = await fetch(`http://127.0.0.1:${PORT}/admin`)
const html = await panel.text()
ok('admin panel loads (200)', panel.status === 200)
ok('panel is the SPA (has #app root + admin js)', /id="app"|<div id="app"/.test(html) || /admin\.(js|mjs)/.test(html))
ok('panel has noindex meta', /noindex/.test(html))

// ---------- login ----------
const login = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.8.8.1' },
  body: JSON.stringify({ password: 'PanelPass123' })
})
ok('login with .env password works on fresh DB (200)', login.status === 200, `got ${login.status}`)
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
ok('session cookie set (HttpOnly)', /HttpOnly/i.test(login.headers.get('set-cookie') ?? ''))

// ---------- authed panel APIs ----------
const sess = await fetch(`http://127.0.0.1:${PORT}/admin/api/session`, { headers: { cookie } })
ok('session endpoint authorized (200)', sess.status === 200)
const cats = await fetch(`http://127.0.0.1:${PORT}/admin/api/categories`, { headers: { cookie } })
ok('categories endpoint authorized (200)', cats.status === 200)

// ---------- wrong password still rejected ----------
const bad = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.8.8.2' },
  body: JSON.stringify({ password: 'wrongpass99' })
})
ok('wrong password rejected (401)', bad.status === 401)

app.kill('SIGTERM')
await new Promise(r => { app.on('exit', r); setTimeout(r, 3000) })
fs.rmSync(dataDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
