#!/usr/bin/env node
/**
 * Auth recovery test: verifies
 *  1. ADMIN_PASSWORD is seeded only on first boot (later env changes ignored)
 *  2. ADMIN_PASSWORD_FORCE=1 overwrites the stored password on next boot
 *  3. scripts/reset-password.js hot-resets the password on a running app
 * Run: node scripts/test-auth-recovery.js
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(root, '.auth-test-data')
const PORT = 3900 + Math.floor(Math.random() * 90) // avoid stale listeners from crashed runs

const BASE_ENV = {
  ...process.env,
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_ACCESS_KEY_ID: 'dummykey',
  R2_SECRET_ACCESS_KEY: 'dummysecret',
  DOWNLOAD_SECRET: 'auth-test-download-secret-0123456789abcdef',
  SESSION_SECRET: 'auth-test-session-secret-0123456789abcdef',
  DL_MODE: 'presign',
  DOWNLOAD_BASE_URL: 'https://dl.example.test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:' + PORT,
  PORT: String(PORT)
}

let passed = 0; let failed = 0
function ok (name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function waitHealthy (tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

function bootApp (extraEnv = {}) {
  const proc = spawn('node', ['src/server.js'], {
    cwd: path.join(root, 'app'),
    env: { ...BASE_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(proc)
  return proc
}
const children = []
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const c of children) { try { c.kill('SIGKILL') } catch {} } })
}

async function tryLogin (password, ip = `10.9.9.1`) {
  // unique XFF per call site — avoids the 10-logins/min rate limit tripping the test
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password })
  })
  return r.status
}

async function shutdown (proc) {
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise(res => {
    proc.on('exit', res)
    setTimeout(res, 3000)
  })
}

// ---------- phase 1: first boot seeds ADMIN_PASSWORD=A ----------
console.log('\n[1] first boot with ADMIN_PASSWORD=FirstPass123')
let app = bootApp({ ADMIN_PASSWORD: 'FirstPass123' })
ok('boots', await waitHealthy())
ok('first-boot password A accepted (200)', (await tryLogin('FirstPass123')) === 200)
ok('wrong password rejected (401)', (await tryLogin('nope12345')) === 401)
await shutdown(app)

// ---------- phase 2: restart with a DIFFERENT env, no force → env ignored ----------
console.log('\n[2] restart with ADMIN_PASSWORD=SecondPass456 (no force) — env must be ignored')
app = bootApp({ ADMIN_PASSWORD: 'SecondPass456' })
ok('boots', await waitHealthy())
ok('env password B REJECTED (401) — DB wins', (await tryLogin('SecondPass456')) === 401)
ok('original password A still accepted (200)', (await tryLogin('FirstPass123')) === 200)
await shutdown(app)

// ---------- phase 3: ADMIN_PASSWORD_FORCE=1 overwrites ----------
console.log('\n[3] restart with ADMIN_PASSWORD=SecondPass456 + ADMIN_PASSWORD_FORCE=1')
app = bootApp({ ADMIN_PASSWORD: 'SecondPass456', ADMIN_PASSWORD_FORCE: '1' })
ok('boots', await waitHealthy())
ok('force-reset password B accepted (200)', (await tryLogin('SecondPass456')) === 200)
ok('old password A rejected (401)', (await tryLogin('FirstPass123')) === 401)
await shutdown(app)

// ---------- phase 4: hot reset via scripts/reset-password.js while running ----------
console.log('\n[4] hot reset to ThirdPass789 while app is running')
app = bootApp({ ADMIN_PASSWORD: 'SecondPass456' })
ok('boots', await waitHealthy())
// login once to create a session → sessions should be wiped by the reset
const loginRes = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.2' },
  body: JSON.stringify({ password: 'SecondPass456' })
})
const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''
ok('pre-reset login works', loginRes.status === 200)

execSync('node scripts/reset-password.js ThirdPass789', { cwd: root, env: { ...BASE_ENV, DATA_DIR: dataDir }, stdio: 'pipe' })

ok('hot-reset password C accepted immediately (200)', (await tryLogin('ThirdPass789')) === 200)
ok('old password B rejected (401)', (await tryLogin('SecondPass456')) === 401)
// old session should be invalidated
const sessRes = await fetch(`http://127.0.0.1:${PORT}/admin/api/session`, { headers: { cookie } })
ok('pre-reset session invalidated (401)', sessRes.status === 401)
await shutdown(app)

// ---------- phase 5: bad usage guards ----------
console.log('\n[5] script usage guards')
const bad = execSync('node scripts/reset-password.js short 2>&1 || true', { cwd: root, env: { ...BASE_ENV, DATA_DIR: dataDir }, stdio: 'pipe' })
ok('short password rejected', /usage|minimum/.test(bad.toString()))

fs.rmSync(dataDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
