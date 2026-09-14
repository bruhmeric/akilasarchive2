import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { db, getSettings, setSetting, adminLog, getMeta } from '../db.js'
import { status as indexerStatus, enqueueCategory } from '../indexer.js'
import { testBucket } from '../r2.js'
import { handleLogin, requireAdmin, getSessionId, destroySession, changePassword, passwordIsDefault, clearCookie } from '../auth.js'
import { slugify, clientIp, clip } from '../util.js'
import { turnstileStatus } from '../turnstile.js'
import config from '../config.js'

export const adminRouter = Router()

// ---------- auth ----------
adminRouter.post('/login', handleLogin)

// Turnstile config for the login screen. Unauthenticated by design — the site
// key is public (normally embedded straight into page HTML); the SECRET never
// leaves the server. `enforced` lets the SPA give an accurate message when the
// server expects a token but no widget could be rendered.
adminRouter.get('/turnstile', (req, res) => {
  res.json({
    site_key: config.turnstile.siteKey || null,
    action: 'login',
    enforced: turnstileStatus().enabled
  })
})

adminRouter.post('/logout', (req, res) => {
  destroySession(getSessionId(req))
  // Secure flag mirrors the request scheme so the delete actually matches
  // the cookie the browser holds (see handleLogin for the full rationale).
  res.setHeader('Set-Cookie', clearCookie(req.secure))
  res.json({ ok: true })
})

// everything below requires a session
adminRouter.use(requireAdmin)

adminRouter.get('/session', (req, res) => {
  res.json({ ok: true, version: config.version, password_is_default: passwordIsDefault() })
})

// ---------- categories ----------
const CAT_COLS = 'id, name, slug, bucket, enabled, created_at, last_index_at, last_index_ms, last_error, file_count, total_size'

function getCat (id) {
  return db.prepare(`SELECT ${CAT_COLS} FROM categories WHERE id = ?`).get(id)
}

adminRouter.get('/categories', (req, res) => {
  res.json({ categories: db.prepare(`SELECT ${CAT_COLS} FROM categories ORDER BY name`).all() })
})

adminRouter.post('/categories', async (req, res) => {
  const name = clip(String(req.body?.name ?? '').trim(), 40)
  const bucket = String(req.body?.bucket ?? '').trim().toLowerCase()
  if (!name) return res.status(400).json({ error: 'name is required' })
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    return res.status(400).json({ error: 'invalid bucket name (lowercase letters, digits and dashes)' })
  }

  const test = await testBucket(bucket)
  if (!test.ok) return res.status(400).json({ error: clip(test.error, 200) })

  let slug = slugify(name)
  while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) {
    slug = slug + '-' + Math.random().toString(36).slice(2, 5)
  }

  const info = db.prepare(
    'INSERT INTO categories (name, slug, bucket, enabled, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(name, slug, bucket, Date.now())
  adminLog('cat_add', `"${name}" → bucket "${bucket}" (slug ${slug})`)
  enqueueCategory(info.lastInsertRowid)
  res.json({ ok: true, category: getCat(info.lastInsertRowid) })
})

adminRouter.patch('/categories/:id', (req, res) => {
  const cat = getCat(req.params.id)
  if (!cat) return res.status(404).json({ error: 'not_found' })

  const patch = req.body ?? {}
  if (patch.enabled !== undefined) {
    db.prepare('UPDATE categories SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, cat.id)
    adminLog('cat_toggle', `"${cat.name}" ${patch.enabled ? 'enabled' : 'disabled'}`)
    if (patch.enabled && !cat.last_index_at) enqueueCategory(cat.id)
  }
  if (patch.name !== undefined) {
    const name = clip(String(patch.name).trim(), 40)
    if (!name) return res.status(400).json({ error: 'name cannot be empty' })
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, cat.id)
    adminLog('cat_rename', `"${cat.name}" → "${name}"`)
  }
  res.json({ ok: true, category: getCat(cat.id) })
})

adminRouter.delete('/categories/:id', (req, res) => {
  const cat = getCat(req.params.id)
  if (!cat) return res.status(404).json({ error: 'not_found' })
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id) // files cascade + FTS triggers
  adminLog('cat_del', `"${cat.name}" (bucket "${cat.bucket}") removed`)
  res.json({ ok: true })
})

// ---------- reindex ----------
adminRouter.post('/reindex', (req, res) => {
  const id = req.body?.id
  if (id) {
    const cat = getCat(id)
    if (!cat) return res.status(404).json({ error: 'not_found' })
    enqueueCategory(cat.id)
    adminLog('reindex', `manual reindex of "${cat.name}"`)
  } else {
    for (const c of db.prepare('SELECT id FROM categories WHERE enabled = 1').all()) enqueueCategory(c.id)
    adminLog('reindex', 'manual reindex of all categories')
  }
  res.json({ ok: true })
})

// ---------- status / dashboard ----------
adminRouter.get('/status', (req, res) => {
  const settings = getSettings()
  let dbBytes = 0
  try { dbBytes = fs.statSync(path.join(config.dataDir, 'archive.db')).size } catch { /* ignore */ }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const tokens = db.prepare(
    'SELECT COUNT(*) AS issued, COALESCE(SUM(used_at IS NOT NULL), 0) AS used FROM tokens WHERE created_at > ?'
  ).get(dayStart.getTime())
  res.json({
    indexer: indexerStatus(),
    categories: db.prepare(`SELECT ${CAT_COLS} FROM categories ORDER BY name`).all(),
    settings,
    db_bytes: dbBytes,
    tokens_today: tokens,
    dl_mode: config.dlMode,
    download_base: config.downloadBaseUrl,
    r2_account: config.r2.accountId,
    uptime_s: Math.floor(process.uptime()),
    password_is_default: passwordIsDefault(),
    turnstile: turnstileStatus()
  })
})

// ---------- settings ----------
adminRouter.get('/settings', (req, res) => {
  res.json({ settings: getSettings(), dl_mode: config.dlMode, download_base: config.downloadBaseUrl })
})

adminRouter.post('/settings', (req, res) => {
  const body = req.body ?? {}
  const applied = []
  for (const key of ['index_interval_hours', 'token_ttl_min', 'dl_expiry_sec']) {
    if (body[key] !== undefined) {
      if (!setSetting(key, body[key])) return res.status(400).json({ error: `invalid value for ${key}` })
      applied.push(key)
    }
  }
  adminLog('settings', `updated: ${applied.join(', ') || 'nothing'}`)
  res.json({ ok: true, settings: getSettings() })
})

// ---------- password ----------
adminRouter.post('/password', (req, res) => {
  const result = changePassword(req.body?.current, req.body?.next)
  if (!result.ok) return res.status(400).json({ error: result.error })
  adminLog('password', 'admin password changed')
  res.json({ ok: true })
})

// ---------- log ----------
adminRouter.get('/logs', (req, res) => {
  res.json({ logs: db.prepare('SELECT at, action, detail FROM admin_log ORDER BY id DESC LIMIT 100').all() })
})

// ---------- statistics (comprehensive) ----------
adminRouter.get('/stats', (req, res) => {
  const now = Date.now()
  const DAY = 86400e3
  const since = ms => now - ms

  // overall totals
  const totals = db.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes, COALESCE(AVG(size),0) AS avg_size, COALESCE(MIN(mtime),0) AS oldest, COALESCE(MAX(mtime),0) AS newest FROM files'
  ).get()
  const cats = db.prepare(`
    SELECT c.name, c.slug, c.enabled, c.file_count AS files, c.total_size AS bytes,
           CASE WHEN c.file_count > 0 THEN c.total_size / c.file_count ELSE 0 END AS avg_size,
           c.last_index_at, c.last_error
    FROM categories c ORDER BY c.total_size DESC`).all()

  // extension distribution (top 12 by count) — GROUP BY 1: ordinal, avoids the
  // column/alias collision trap (the `ext` alias shadows the real ext column;
  // ordinal also merges '' and NULL extensions into one "(none)" group)
  const extensions = db.prepare(`
    SELECT COALESCE(NULLIF(ext, ''), '(none)') AS ext, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
    FROM files GROUP BY 1 ORDER BY files DESC, bytes DESC LIMIT 12`).all()

  // size distribution histogram
  // NOTE: GROUP BY 1 (ordinal), NOT "GROUP BY bucket" — the files table has a
  // real column named `bucket` (the R2 bucket), which would shadow the CASE
  // alias and group by R2 bucket instead of size class.
  const sizeBuckets = db.prepare(`
    SELECT CASE
             WHEN size < 10485760        THEN '0 < 10 MB'
             WHEN size < 104857600       THEN '1 10–100 MB'
             WHEN size < 1073741824      THEN '2 100 MB–1 GB'
             WHEN size < 10737418240     THEN '3 1–10 GB'
             ELSE '4 > 10 GB' END AS bucket,
           COUNT(*) AS files
    FROM files GROUP BY 1 ORDER BY 1`).all()

  // one-time link activity — NOTE: cleanup() prunes tokens ~24h after expiry,
  // so "all time" here means "retained window"; label that in the UI.
  const linkAll = db.prepare(
    'SELECT COUNT(*) AS issued, COALESCE(SUM(used_at IS NOT NULL), 0) AS used, COUNT(DISTINCT CASE WHEN used_at IS NOT NULL THEN ip END) AS unique_ips FROM tokens'
  ).get()
  const link24 = db.prepare(
    'SELECT COUNT(*) AS issued, COALESCE(SUM(used_at IS NOT NULL), 0) AS used FROM tokens WHERE created_at > ?'
  ).get(since(DAY))
  const link7 = db.prepare(
    'SELECT COUNT(*) AS issued, COALESCE(SUM(used_at IS NOT NULL), 0) AS used FROM tokens WHERE created_at > ?'
  ).get(since(7 * DAY))

  // downloads per day, full 14-day series (fill gaps server-side)
  const byDayRows = db.prepare(
    "SELECT date(used_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS used FROM tokens WHERE used_at > ? GROUP BY day ORDER BY day"
  ).all(since(14 * DAY))
  const byDay = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    byDay.push({ day: key, used: byDayRows.find(r => r.day === key)?.used || 0 })
  }

  // most downloaded files
  const topDownloads = db.prepare(`
    SELECT f.name, c.name AS cat, f.size, COUNT(*) AS downloads
    FROM tokens t JOIN files f ON f.id = t.file_id JOIN categories c ON c.id = f.category_id
    WHERE t.used_at IS NOT NULL
    GROUP BY t.file_id ORDER BY downloads DESC, f.size DESC LIMIT 10`).all()

  // largest files
  const largest = db.prepare(`
    SELECT f.name, c.name AS cat, f.size FROM files f JOIN categories c ON c.id = f.category_id
    ORDER BY f.size DESC LIMIT 10`).all()

  // newest files (by source mtime)
  const newest = db.prepare(`
    SELECT f.name, c.name AS cat, f.size, f.mtime FROM files f JOIN categories c ON c.id = f.category_id
    ORDER BY f.mtime DESC LIMIT 10`).all()

  // admin activity, last 7 days
  const log7 = db.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(action = 'login_fail'), 0) AS login_fails, COALESCE(SUM(action = 'login_ok'), 0) AS logins FROM admin_log WHERE at > ?"
  ).get(since(7 * DAY))

  res.json({
    generated_at: now,
    totals,
    categories: cats,
    enabled_categories: cats.filter(c => c.enabled).length,
    extensions,
    size_buckets: sizeBuckets,
    links: { retained: linkAll, last_24h: link24, last_7d: link7 },
    downloads_by_day: byDay,
    top_downloads: topDownloads,
    largest_files: largest,
    newest_files: newest,
    admin_log_7d: log7
  })
})
