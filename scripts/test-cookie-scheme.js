#!/usr/bin/env node
/**
 * Cookie-scheme regression test.
 * Simulates REAL browser cookie rules:
 *   - a cookie flagged Secure is only stored/sent over https
 *   - non-Secure cookies work on both schemes
 * Reproduces the "login accepted but nothing happens" bug and verifies the fix:
 *   Set-Cookie Secure flag must follow the ACTUAL request scheme (req.secure,
 *   i.e. X-Forwarded-Proto behind Caddy), not PUBLIC_BASE_URL.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(root, '.cookie-test-data')
const PORT = 3960 + Math.floor(Math.random() * 30)
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

// PRODUCTION-LIKE: PUBLIC_BASE_URL is https (default in prod) — the OLD code
// turned this into a static Secure flag on every cookie. The browser below
// visits over plain http, exactly like a scheme mismatch in production.
const ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '0',
  R2_ACCESS_KEY_ID: 'x',
  R2_SECRET_ACCESS_KEY: 'x',
  DOWNLOAD_SECRET: 'cookie-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'cookie-test-session-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'CookiePass123',
  DL_MODE: 'presign',
  DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'https://akilasarchive.site', // https while we browse http → old bug trigger
  PORT: String(PORT)
}

let passed = 0; let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

const app = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
const children = [app]
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of children) { try { c.kill('SIGKILL') } catch {} } })

for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

// ---- tiny browser cookie jar implementing the Secure rule ----
function jarStore (setCookieHeader, scheme) {
  if (!setCookieHeader) return null
  const attrs = setCookieHeader.split(';').map(s => s.trim().toLowerCase())
  const secure = attrs.includes('secure')
  if (secure && scheme === 'http') return null // browser drops Secure cookies on http
  const [pair] = setCookieHeader.split(';')
  return pair.trim()
}
const login = async (scheme, xffProto) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xffProto ? { 'x-forwarded-proto': xffProto } : {}) },
    body: JSON.stringify({ password: 'CookiePass123' })
  })
  const setCookie = res.headers.get('set-cookie')
  const body = await res.json().catch(() => ({}))
  return { status: res.status, setCookie, body, cookie: jarStore(setCookie, xffProto === 'https' ? 'https' : 'http') }
}
const callWith = (cookie, extra = {}) =>
  fetch(`http://127.0.0.1:${PORT}/admin/api/session`, { headers: { ...(cookie ? { cookie } : {}), ...extra } })

console.log('\n[1] browser over plain HTTP (scheme mismatch: PUBLIC_BASE_URL=https, request http)')
const l1 = await login('http')
ok('login accepted (200)', l1.status === 200)
ok('Set-Cookie has NO Secure flag over http (fix)', l1.setCookie && !/;\s*secure/i.test(l1.setCookie), `got: ${l1.setCookie}`)
ok('browser stores the cookie', !!l1.cookie)
ok('session works with stored cookie (200)', (await callWith(l1.cookie)).status === 200)

console.log('\n[2] browser over HTTPS (X-Forwarded-Proto: https through Caddy)')
const l2 = await login('https', 'https')
ok('login accepted (200)', l2.status === 200)
ok('Set-Cookie HAS Secure flag over https (fix)', l2.setCookie && /;\s*secure/i.test(l2.setCookie), `got: ${l2.setCookie}`)
ok('browser stores the Secure cookie over https', !!l2.cookie)
ok('session works over https with the Secure cookie (200)', (await callWith(l2.cookie, { 'x-forwarded-proto': 'https' })).status === 200)

console.log('\n[3] old-bug scenario is now impossible')
const l3 = await login('http') // http request
ok('even with PUBLIC_BASE_URL=https, http login yields non-Secure cookie', !/;\s*secure/i.test(l3.setCookie || ''))
const noCookie = await callWith(null)
ok('request without cookie is still 401', noCookie.status === 401)

console.log('\n[4] wrong password gives a specific 401 message (SPA shows it now)')
const bad = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.7.7.1' },
  body: JSON.stringify({ password: 'wrong-password' })
})
const badBody = await bad.json().catch(() => ({}))
ok('401 with "invalid password" message', bad.status === 401 && /invalid password/i.test(badBody.error || ''), JSON.stringify(badBody))

console.log('\n[5] login response reports scheme for SPA diagnostics')
ok('login body includes secure:false on http', l1.body?.secure === false)
ok('login body includes secure:true on https', l2.body?.secure === true)

console.log('\n[6] logout clears cookie with matching attributes')
const logoutRes = await fetch(`http://127.0.0.1:${PORT}/admin/api/logout`, {
  method: 'POST',
  headers: { cookie: l1.cookie },
  credentials: 'same-origin'
})
ok('logout 200', logoutRes.status === 200)
ok('logout Set-Cookie deletes aa_sid', /^aa_sid=;/.test(logoutRes.headers.get('set-cookie') || ''))
ok('logout delete cookie not Secure over http', !/;\s*secure/i.test(logoutRes.headers.get('set-cookie') || ''))

for (const c of children) c.kill('SIGTERM')
await new Promise(r => setTimeout(r, 500))
fs.rmSync(dataDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
