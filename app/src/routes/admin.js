import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { db, getSettings, setSetting, adminLog, getMeta } from '../db.js'
import { status as indexerStatus, enqueueCategory } from '../indexer.js'
import { testBucket } from '../r2.js'
import { handleLogin, requireAdmin, getSessionId, destroySession, changePassword, passwordIsDefault, clearCookie } from '../auth.js'
import { slugify, clientIp, clip } from '../util.js'
import config from '../config.js'

export const adminRouter = Router()

// ---------- auth ----------
adminRouter.post('/login', handleLogin)

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
    password_is_default: passwordIsDefault()
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
