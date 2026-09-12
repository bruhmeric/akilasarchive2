import crypto from 'node:crypto'
import { db, adminLog } from './db.js'
import config from './config.js'
import { parseCookies, rateLimit, scryptHash, scryptVerify, clientIp } from './util.js'

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

export function sessionCookie (id) {
  const parts = [`${COOKIE_NAME}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_MS / 1000}`]
  if (config.cookieSecure) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookie () {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (config.cookieSecure) parts.push('Secure')
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

export function handleLogin (req, res) {
  const ip = clientIp(req)
  const lim = rateLimit({ windowMs: 60e3, max: 10, key: `login:${ip}` })
  const lock = loginAllowed(ip)
  if (!lock.ok) return res.status(429).json({ error: `locked — retry in ${Math.ceil(lock.retryAfter / 60)} min` })
  if (!lim.ok) return res.status(429).json({ error: 'too many attempts — slow down' })

  const password = String(req.body?.password ?? '')
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('admin_password')
  if (!scryptVerify(password, row?.v)) {
    loginFailed(ip)
    adminLog('login_fail', `ip ${ip}`)
    return res.status(401).json({ error: 'invalid password' })
  }
  const id = createSession()
  adminLog('login_ok', `ip ${ip}`)
  res.setHeader('Set-Cookie', sessionCookie(id))
  res.json({ ok: true })
}
