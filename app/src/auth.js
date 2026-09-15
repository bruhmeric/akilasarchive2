import crypto from 'node:crypto'
import { db, adminLog } from './db.js'
import config from './config.js'
import { parseCookies, rateLimit, scryptHash, scryptVerify, clientIp } from './util.js'
import { turnstileEnabled, verifyLoginToken } from './turnstile.js'

const COOKIE_NAME = 'aa_sid'
const SESSION_TTL_MS = 12 * 3600e3
const MAX_ATTEMPTS = 6
const LOCKOUT_MS = 15 * 60e3

export function seedAdminPassword () {
  const existing = db.prepare('SELECT v FROM meta WHERE k = ?').get('admin_password')
  if (existing && !config.adminPasswordForce) return
  db.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'
  ).run('admin_password', scryptHash(config.adminPassword))
  const isDefault = config.adminPassword === 'changeme123'
  db.prepare("INSERT INTO meta (k, v) VALUES ('password_is_default', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
    .run(isDefault ? '1' : '0')
  if (isDefault) {
    adminLog('warn', 'admin password is the default — change it in Settings')
  }
  if (existing && config.adminPasswordForce) {
    db.prepare('DELETE FROM sessions').run() // force re-login everywhere
    adminLog('warn', 'admin password force-reset from ADMIN_PASSWORD (ADMIN_PASSWORD_FORCE=1)')
    console.log('  [auth] admin password overwritten from ADMIN_PASSWORD (ADMIN_PASSWORD_FORCE=1)')
    console.log('  [auth] remove ADMIN_PASSWORD_FORCE from .env after logging in')
  }
}

export function passwordIsDefault () {
  return db.prepare('SELECT v FROM meta WHERE k = ?').get('password_is_default')?.v === '1'
}

export function changePassword (current, next) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('admin_password')
  if (!scryptVerify(current, row?.v)) return { ok: false, error: 'current password is incorrect' }
  if (String(next ?? '').length < 8) return { ok: false, error: 'new password must be at least 8 characters' }
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run('admin_password', scryptHash(next))
  db.prepare('DELETE FROM sessions').run() // force re-login everywhere
  return { ok: true }
}

// ---------- login rate limiting ----------
const attempts = new Map()

export function loginAllowed (ip) {
  const a = attempts.get(ip)
  if (a && a.until > Date.now()) return { ok: false, retryAfter: Math.ceil((a.until - Date.now()) / 1000) }
  return { ok: true }
}

function loginFailed (ip) {
  const a = attempts.get(ip) ?? { count: 0 }
  a.count++
  a.last = Date.now()
  if (a.count >= MAX_ATTEMPTS) {
    a.until = Date.now() + LOCKOUT_MS
    a.count = 0
  }
  attempts.set(ip, a)
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) { if ((v.until ?? v.last) < Date.now() - LOCKOUT_MS) attempts.delete(k) }
  }
}

// ---------- sessions ----------
export function createSession () {
  const id = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(id, Date.now(), Date.now() + SESSION_TTL_MS)
  return id
}

export function destroySession (id) {
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function validSession (id) {
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return false
  const row = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id)
  return !!row && row.expires_at > Date.now()
}

export function sessionCookie (id, secure = false) {
  const parts = [`${COOKIE_NAME}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_MS / 1000}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookie (secure = false) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function getSessionId (req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null
}

// ---------- express middleware ----------
export function requireAdmin (req, res, next) {
  const id = getSessionId(req)
  if (!validSession(id)) return res.status(401).json({ error: 'unauthorized' })
  req.sessionId = id
  next()
}

// human-readable server messages for each captcha failure mode (the SPA
// shows these verbatim, like the password errors)
const CAPTCHA_ERRORS = {
  missing: 'captcha required — complete the human verification',
  malformed: 'captcha token malformed',
  invalid: 'captcha verification failed — retry',
  // .env holds the previous widget's secret — happens when the Turnstile
  // widget is deleted + recreated: the site key gets updated but the secret
  // belongs to the dead widget, so every solved token is rejected forever.
  // Naming it turns an undiagnosable "retry" loop into a 1-minute fix.
  'secret-mismatch': 'captcha verification failed: TURNSTILE_SECRET does not match the widget — if the widget was recreated, re-copy the NEW Secret Key from the dashboard into .env and restart',
  'stale-token': 'captcha verification failed: the token expired or was already used — solve the verification again',
  unreachable: 'captcha verification unavailable — try again shortly'
}

export async function handleLogin (req, res) {
  const ip = clientIp(req)
  const lim = rateLimit({ windowMs: 60e3, max: 10, key: `login:${ip}` })
  const lock = loginAllowed(ip)
  if (!lock.ok) return res.status(429).json({ error: `locked — retry in ${Math.ceil(lock.retryAfter / 60)} min` })
  if (!lim.ok) return res.status(429).json({ error: 'too many attempts — slow down' })

  // Turnstile gate (canonical siteverify): runs BEFORE the password check so
  // bots can never attempt passwords, but AFTER the local rate-limiters so a
  // flood of garbage tokens cannot relay through us to siteverify. Captcha
  // failures do NOT consume password attempts (loginFailed is only called for
  // real password misses below).
  if (turnstileEnabled()) {
    const verdict = await verifyLoginToken(req.body?.['cf-turnstile-response'], ip)
    if (!verdict.ok) {
      adminLog('login_captcha', `ip ${ip} · ${verdict.reason}${verdict.codes?.length ? ' (' + verdict.codes.join(',') + ')' : ''}`)
      let msg = CAPTCHA_ERRORS[verdict.reason] || 'captcha verification failed'
      // self-lockout guard: without a site key the widget can NEVER render, so
      // "complete the human verification" would be impossible advice — name
      // the actual misconfiguration instead
      if (verdict.reason === 'missing' && !config.turnstile.siteKey) {
        msg = 'captcha required, but TURNSTILE_SITE_KEY is not set — the widget cannot render. Add it to .env and restart, or remove TURNSTILE_SECRET to disable the gate'
      }
      return res.status(403).json({ error: msg, captcha: true })
    }
  }

  const password = String(req.body?.password ?? '')
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('admin_password')
  if (!scryptVerify(password, row?.v)) {
    loginFailed(ip)
    adminLog('login_fail', `ip ${ip}`)
    return res.status(401).json({ error: 'invalid password' })
  }
  const id = createSession()
  adminLog('login_ok', `ip ${ip}`)
  // Secure flag comes from the ACTUAL request scheme (Caddy sends
  // X-Forwarded-Proto; trust proxy is enabled). Deriving it from
  // PUBLIC_BASE_URL broke login whenever the browser's scheme differed from
  // the configured URL: the browser drops a Secure cookie on http, the next
  // API call 401s, and the panel silently bounces back to the login form.
  res.setHeader('Set-Cookie', sessionCookie(id, req.secure))
  res.json({ ok: true, secure: !!req.secure })
}
