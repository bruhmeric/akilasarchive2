#!/usr/bin/env node
/**
 * Turnstile integration regression test.
 *
 * Boots the REAL app three times against a LOCAL STUB of Cloudflare's
 * siteverify endpoint (TURNSTILE_SITEVERIFY_URL) and verifies the canonical
 * contract end-to-end:
 *   phase 1 — no Turnstile env          → login works exactly as before
 *   phase 2 — secret + site key set     → gate enforced:
 *        missing token / bad action / foreign hostname / success:false /
 *        malformed (>2048) / stub 500 → 403; valid token → 200;
 *        single-use replay → 403; captcha failures never consume the
 *        password lockout; failures logged as login_captcha
 *   phase 3 — siteverify unreachable    → fail closed (403)
 *   phase 4 — secret set, site key MISSING → the exact misconfiguration that
 *        locked the user out: widget can never render, so the 403 and the
 *        /admin/api/turnstile payload must NAME the missing env var, and a
 *        valid token must still pass (proving the gate itself is fine)
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const SITE_KEY = '0x4AAAAAAE1dPKOfQ8Nb4P8f'
const SECRET = '1.0xUnitTestSecretDoNotUseAnywhere00000'
const PW = 'TurnstilePass123'

let passed = 0; let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const children = []
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of children) { try { c.kill('SIGKILL') } catch {} } process.exit(0) })

function baseEnv (dataDir, port) {
  return {
    ...process.env,
    DATA_DIR: dataDir,
    R2_ACCOUNT_ID: '0',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'x',
    DOWNLOAD_SECRET: 'turnstile-test-download-secret-0123456789abcdef',
    SESSION_SECRET: 'turnstile-test-session-secret-0123456789abcdef',
    ADMIN_PASSWORD: PW,
    DL_MODE: 'presign',
    DOWNLOAD_BASE_URL: 'https://dl.example.test',
    PUBLIC_BASE_URL: 'https://akilasarchive.site',
    PORT: String(port)
  }
}

async function bootApp (env) {
  const app = spawn('node', ['src/server.js'], { cwd: path.join(root, 'app'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  app.logBuf = ''
  app.stdout.on('data', (d) => { app.logBuf += d })
  app.stderr.on('data', (d) => process.stderr.write(`    [app] ${d}`))
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${env.PORT}/api/health`)).ok) return app } catch {}
    await sleep(250)
  }
  throw new Error('app did not become healthy')
}

// vary X-Forwarded-For so each logical client gets its own rate-limit bucket
let clientN = 0
const login = async (port, { password = PW, token, ip } = {}) => {
  const body = { password }
  if (token !== undefined) body['cf-turnstile-response'] = token
  const res = await fetch(`http://127.0.0.1:${port}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip ?? `10.9.0.${++clientN}` },
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') }
}
let tokenN = 0
const freshToken = () => `XXXX.TOKEN.${++tokenN}.YYYY`

// ---------- local siteverify stub ----------
const HOSTNAME = 'akilasarchive.site'
const stubState = { last: null, seen: new Set(), script: null, status: 0 }
const stubPort = 3970 + Math.floor(Math.random() * 20)
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    stubState.last = Object.fromEntries(new URLSearchParams(raw))
    res.setHeader('content-type', 'application/json')
    if (stubState.status) { res.statusCode = stubState.status; res.end('{}'); stubState.status = 0; return }
    const duplicate = stubState.seen.has(stubState.last.response)
    stubState.seen.add(stubState.last.response)
    const payload = stubState.script ?? { success: true, action: 'login', hostname: HOSTNAME }
    stubState.script = null
    // single-use semantics, like the real endpoint
    res.end(JSON.stringify(duplicate ? { success: false, 'error-codes': ['timeout-or-duplicate'] } : payload))
  })
})
await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r))

// ════════════════════ phase 1 · not configured ════════════════════
console.log('\n[phase 1] no Turnstile env — login flow unchanged (backward compat)')
{
  const dir = fs.mkdtempSync(path.join(root, '.ts-test-'))
  const port = 3870
  await bootApp(baseEnv(dir, port))
  const cfg = await (await fetch(`http://127.0.0.1:${port}/admin/api/turnstile`)).json()
  ok('GET /admin/api/turnstile unauthenticated → 200', cfg.site_key === null && cfg.action === 'login')
  ok('enforced=false without secret', cfg.enforced === false)
  const l = await login(port, { password: PW, token: undefined })
  ok('login WITHOUT token succeeds (200)', l.status === 200, JSON.stringify(l.json))
  const sess = await fetch(`http://127.0.0.1:${port}/admin/api/session`, { headers: { cookie: l.setCookie.split(';')[0] } })
  ok('session works', sess.status === 200)
  const status = await (await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { cookie: l.setCookie.split(';')[0] } })).json()
  ok('status reports turnstile.enabled=false', status.turnstile?.enabled === false)
}

// ════════════════════ phase 2 · configured + stub ════════════════════
console.log('\n[phase 2] TURNSTILE_SECRET set — canonical siteverify gate')
{
  const dir = fs.mkdtempSync(path.join(root, '.ts-test-'))
  const port = 3871
  await bootApp({
    ...baseEnv(dir, port),
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_SECRET: SECRET,
    TURNSTILE_SITEVERIFY_URL: `http://127.0.0.1:${stubPort}/siteverify`
  })

  const cfgRes = await fetch(`http://127.0.0.1:${port}/admin/api/turnstile`)
  const cfgText = await cfgRes.text()
  ok('GET /admin/api/turnstile exposes site key', cfgText.includes(SITE_KEY))
  ok('config endpoint NEVER leaks the secret', !cfgText.includes(SECRET))
  ok('enforced=true with secret', JSON.parse(cfgText).enforced === true)

  // no token → 403
  let l = await login(port, {})
  ok('login without token → 403', l.status === 403, JSON.stringify(l.json))
  ok('403 flagged captcha:true + message', l.json.captcha === true && /captcha required/.test(l.json.error))

  // valid token → 200
  l = await login(port, { token: freshToken() })
  ok('login with valid token → 200', l.status === 200, JSON.stringify(l.json))
  ok('stub got secret + response + remoteip',
    stubState.last?.secret === SECRET && !!stubState.last?.response && !!stubState.last?.remoteip,
    JSON.stringify(stubState.last))
  const cookie = l.setCookie?.split(';')[0]
  const sess = await fetch(`http://127.0.0.1:${port}/admin/api/session`, { headers: { cookie } })
  ok('session works after captcha login', sess.status === 200)

  // wrong action
  stubState.script = { success: true, action: 'signup', hostname: HOSTNAME }
  l = await login(port, { token: freshToken() })
  ok('wrong action → 403', l.status === 403, JSON.stringify(l.json))

  // foreign hostname
  stubState.script = { success: true, action: 'login', hostname: 'evil.example' }
  l = await login(port, { token: freshToken() })
  ok('hostname not in allowlist → 403', l.status === 403, JSON.stringify(l.json))

  // success:false with a generic code → plain invalid
  stubState.script = { success: false, 'error-codes': ['bad-token'] }
  l = await login(port, { token: freshToken() })
  ok('success:false → 403', l.status === 403, JSON.stringify(l.json))

  // invalid-input-secret → the recreated-widget trap: new site key, OLD
  // secret in .env → every solved token rejected. Must name TURNSTILE_SECRET.
  stubState.script = { success: false, 'error-codes': ['invalid-input-secret'] }
  l = await login(port, { token: freshToken() })
  ok('invalid-input-secret → 403 naming TURNSTILE_SECRET', l.status === 403 && /TURNSTILE_SECRET/.test(l.json.error), JSON.stringify(l.json))

  // timeout-or-duplicate → expired/replayed token → tell the user to re-solve
  stubState.script = { success: false, 'error-codes': ['timeout-or-duplicate'] }
  l = await login(port, { token: freshToken() })
  ok('timeout-or-duplicate → 403 telling to solve again', l.status === 403 && /solve the verification again/.test(l.json.error), JSON.stringify(l.json))

  // malformed (>2048 chars)
  l = await login(port, { token: 'x'.repeat(2049) })
  ok('token > 2048 chars → 403', l.status === 403, JSON.stringify(l.json))

  // stub returns HTTP 500 → fail closed
  stubState.status = 500
  l = await login(port, { token: freshToken() })
  ok('siteverify HTTP 500 → 403 (fail closed)', l.status === 403, JSON.stringify(l.json))

  // captcha passes but password wrong → existing 401 path untouched
  l = await login(port, { password: 'WrongPass999', token: freshToken() })
  ok('valid captcha + wrong password → 401 invalid password', l.status === 401 && /invalid password/.test(l.json.error), JSON.stringify(l.json))

  // 6 captcha failures from ONE ip, then a clean login from the same ip → 200
  // (proves captcha failures do NOT consume the password-lockout counter)
  const sameIp = '10.9.9.9'
  for (let i = 0; i < 6; i++) await login(port, { token: undefined, ip: sameIp })
  l = await login(port, { token: freshToken(), ip: sameIp })
  ok('6 captcha failures do NOT trigger the password lockout (next clean login 200)', l.status === 200, JSON.stringify(l.json))

  // single-use replay: same token twice → second 403
  const t = freshToken()
  l = await login(port, { token: t })
  ok('first use of token → 200', l.status === 200, JSON.stringify(l.json))
  l = await login(port, { token: t })
  ok('replayed token → 403 (single-use)', l.status === 403, JSON.stringify(l.json))

  // audit log records captcha failures
  const logs = await (await fetch(`http://127.0.0.1:${port}/admin/api/logs`, { headers: { cookie } })).json()
  ok('login_captcha events in the activity log', (logs.logs || []).some((e) => e.action === 'login_captcha'))
  ok('log entries never contain the secret', !JSON.stringify(logs).includes(SECRET))

  // status payload
  const status = await (await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { cookie } })).json()
  ok('status: turnstile enabled + site_key + hostnames', status.turnstile?.enabled === true && status.turnstile?.site_key === true && JSON.stringify(status.turnstile?.hostnames) === JSON.stringify([HOSTNAME]))
}

// ════════════════════ phase 3 · siteverify unreachable ════════════════════
console.log('\n[phase 3] siteverify unreachable — login fails closed')
{
  const dir = fs.mkdtempSync(path.join(root, '.ts-test-'))
  const port = 3872
  const deadPort = 1 // nothing listens here
  await bootApp({
    ...baseEnv(dir, port),
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_SECRET: SECRET,
    TURNSTILE_SITEVERIFY_URL: `http://127.0.0.1:${deadPort}/siteverify`
  })
  const l = await login(port, { token: freshToken() })
  ok('unreachable siteverify → 403', l.status === 403, JSON.stringify(l.json))
  ok('message says verification unavailable', /unavailable/.test(l.json.error))
}

// ════════════════════ phase 4 · secret without site key (lockout guard) ════════════════════
console.log('\n[phase 4] TURNSTILE_SECRET set but TURNSTILE_SITE_KEY missing — self-explanatory failure')
{
  const dir = fs.mkdtempSync(path.join(root, '.ts-test-'))
  const port = 3873
  const app = await bootApp({
    ...baseEnv(dir, port),
    TURNSTILE_SECRET: SECRET,
    TURNSTILE_SITEVERIFY_URL: `http://127.0.0.1:${stubPort}/siteverify`
  })
  await sleep(200) // let the boot banner flush

  ok('boot hint explains the missing site key', /TURNSTILE_SITE_KEY/.test(app.logBuf || ''), (app.logBuf || '').slice(0, 300))

  const cfg = await (await fetch(`http://127.0.0.1:${port}/admin/api/turnstile`)).json()
  ok('config endpoint: site_key null + enforced true', cfg.site_key === null && cfg.enforced === true, JSON.stringify(cfg))
  ok('config endpoint explains the problem (SPA shows it on the card)', /TURNSTILE_SITE_KEY/.test(cfg.problem || ''), JSON.stringify(cfg.problem))
  ok('config endpoint never leaks the secret', !JSON.stringify(cfg).includes(SECRET))

  let l = await login(port, {})
  ok('login without token → 403', l.status === 403, JSON.stringify(l.json))
  ok('403 message names the missing site key (not the generic hint)', /TURNSTILE_SITE_KEY/.test(l.json.error || ''), JSON.stringify(l.json.error))
  ok('403 still flagged captcha:true', l.json.captcha === true)

  // the gate itself trusts a valid token — proves the blocker was the missing
  // WIDGET, not the server-side verification
  l = await login(port, { token: freshToken() })
  ok('valid token still logs in (gate OK — the widget was the blocker)', l.status === 200, JSON.stringify(l.json))
}

// ════════════════════ wrap up ════════════════════
stub.close()
for (const c of children) { try { c.kill('SIGKILL') } catch {} }
for (const d of fs.readdirSync(root).filter((x) => x.startsWith('.ts-test-'))) {
  fs.rmSync(path.join(root, d), { recursive: true, force: true })
}
console.log(`\nturnstile: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
