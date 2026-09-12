import crypto from 'node:crypto'

/** Escape user text before inserting into HTML. */
export function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Escape a string for use inside a SQL LIKE pattern (backslash escaping). */
export function escapeLike (s) {
  return String(s ?? '').replace(/[\\%_]/g, m => '\\' + m)
}

export const LIKE_ESCAPE = " ESCAPE '\\'"

/** URL/file-safe slug from a display name. */
export function slugify (s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\u0900-\u097f\u0d80-\u0dff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'cat'
}

export function clip (s, n = 300) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

export function yieldLoop () { return new Promise(r => setImmediate(r)) }

export const b64urlEncode = (s) => Buffer.from(String(s), 'utf8').toString('base64url')

export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')

export const hmacHex = (secret, msg) => crypto.createHmac('sha256', String(secret)).update(String(msg)).digest('hex')

export function randomToken (bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** scrypt password hashing (format: s2$N$r$p$salt$key). */
export function scryptHash (password) {
  const N = 16384; const r = 8; const p = 1
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(String(password), salt, 32, { N, r, p })
  return `s2$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function scryptVerify (password, stored) {
  try {
    const parts = String(stored ?? '').split('$')
    if (parts.length !== 6 || parts[0] !== 's2') return false
    const [, N, r, p, salt, key] = parts
    const expected = Buffer.from(key, 'base64url')
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p })
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function decodeXmlEntities (s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Simple sliding-window rate limiter (in-memory, per key). */
export function rateLimit ({ windowMs, max, key }) {
  const now = Date.now()
  const bucket = rateLimit.store ??= new Map()
  const entry = bucket.get(key)
  if (!entry || now > entry.reset) {
    bucket.set(key, { count: 1, reset: now + windowMs })
    return { ok: true, remaining: max - 1, retryAfter: 0 }
  }
  entry.count++
  if (bucket.size > 10000) { // crude cleanup
    for (const [k, v] of bucket) { if (now > v.reset) bucket.delete(k) }
  }
  if (entry.count > max) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((entry.reset - now) / 1000) }
  }
  return { ok: true, remaining: max - entry.count, retryAfter: 0 }
}

export function parseCookies (header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function splitObjectKey (key) {
  const i = key.lastIndexOf('/')
  const dir = i < 0 ? '' : key.slice(0, i)
  const name = i < 0 ? key : key.slice(i + 1)
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) ?? [])[1]?.toLowerCase() ?? ''
  return { dir, name, ext }
}

export function clientIp (req) {
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString()
}
