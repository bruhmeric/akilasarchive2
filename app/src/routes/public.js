import { Router } from 'express'
import crypto from 'node:crypto'
import { db, getSettings } from '../db.js'
import config from '../config.js'
import {
  b64urlEncode, escapeLike, LIKE_ESCAPE, hmacHex, rateLimit, clientIp, randomToken, sha256hex, clip
} from '../util.js'
import { presignGet } from '../r2.js'

export const publicRouter = Router()

const PAGE_MAX = 100

// ---------- helpers ----------
function enabledCategories () {
  return db.prepare('SELECT id, slug, name FROM categories WHERE enabled = 1 ORDER BY name').all()
}

function findEnabledBySlug (slug) {
  return db.prepare('SELECT id, slug, name FROM categories WHERE enabled = 1 AND slug = ?').get(slug)
}

function buildFilters ({ ext, minSize, maxSize, alias = 'f' }) {
  const sql = []
  const params = []
  if (ext) { sql.push(`${alias}.ext = ?`); params.push(ext.replace(/^\./, '').toLowerCase()) }
  const min = parseInt(minSize, 10); const max = parseInt(maxSize, 10)
  if (Number.isFinite(min) && min >= 0) { sql.push(`${alias}.size >= ?`); params.push(min) }
  if (Number.isFinite(max) && max > 0) { sql.push(`${alias}.size <= ?`); params.push(max) }
  return { sql: sql.join(' AND '), params }
}

const FILE_COLS = 'f.id, f.name, f.dir, f.ext, f.size, f.mtime, c.slug AS cat_slug, c.name AS cat_name'

function ftsQueryFor (q) {
  const terms = String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const clean = terms.filter(t => t.length > 0)
  if (!clean.length) return null
  return clean.map(t => `${t}*`).join(' AND ')
}

// ---------- health ----------
publicRouter.get('/api/health', (req, res) => {
  res.json({ ok: true, name: config.name, version: config.version })
})

// ---------- categories ----------
publicRouter.get('/api/categories', (req, res) => {
  const rows = db.prepare(
    'SELECT slug, name, file_count AS count, total_size AS size FROM categories WHERE enabled = 1 ORDER BY name'
  ).all()
  res.json({ categories: rows })
})

// ---------- browse ----------
publicRouter.get('/api/browse/:slug', (req, res) => {
  const cat = findEnabledBySlug(String(req.params.slug || ''))
  if (!cat) return res.status(404).json({ error: 'not_found' })

  const rawPath = String(req.query.path ?? '')
  const segs = rawPath.split('/').filter(s => s !== '' && s !== '.' && s !== '..')
  const prefix = segs.length ? segs.join('/') + '/' : ''
  const dirCol = segs.join('/')
  const L = prefix.length

  // does this directory exist? (either direct files or deeper paths)
  if (segs.length) {
    const exists = db.prepare(
      `SELECT 1 FROM files WHERE category_id = ? AND (dir = ? OR dir LIKE ? ${LIKE_ESCAPE}) LIMIT 1`
    ).get(cat.id, dirCol, escapeLike(prefix) + '%')
    if (!exists) return res.status(404).json({ error: 'not_found' })
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const offset = (page - 1) * limit

  const dirs = db.prepare(
    `SELECT substr(dir, ?, instr(substr(dir, ?) || '/', '/') - 1) AS d,
            COUNT(*) AS cnt, COALESCE(SUM(size), 0) AS sz
     FROM files
     WHERE category_id = ? AND length(dir) > ? AND dir LIKE ? ${LIKE_ESCAPE}
     GROUP BY d ORDER BY d LIMIT ? OFFSET ?`
  ).all(L + 1, L + 1, cat.id, L, escapeLike(prefix) + '%', limit + 1, offset)

  const files = db.prepare(
    `SELECT id, name, size, mtime, ext FROM files
     WHERE category_id = ? AND dir = ?
     ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(cat.id, dirCol, limit + 1, offset)

  res.json({
    category: { slug: cat.slug, name: cat.name },
    path: dirCol,
    page,
    dirs: dirs.slice(0, limit).map(d => ({ name: d.d, count: d.cnt, size: d.sz })),
    files: files.slice(0, limit).map(f => ({
      id: f.id, name: f.name, size: f.size, mtime: f.mtime, ext: f.ext
    })),
    hasMore: dirs.length > limit || files.length > limit
  })
})

// ---------- search ----------
publicRouter.get('/api/search', (req, res) => {
  const q = clip(String(req.query.q ?? ''), 200).trim()
  if (!q) return res.status(400).json({ error: 'empty_query' })

  const cats = enabledCategories()
  if (!cats.length) return res.json({ total: 0, page: 1, pages: 0, results: [] })

  let catIds = cats.map(c => c.id)
  const catFilterSlug = String(req.query.cat ?? '').trim()
  if (catFilterSlug) {
    const target = cats.find(c => c.slug === catFilterSlug)
    if (!target) return res.status(404).json({ error: 'unknown_category' })
    catIds = [target.id]
  }
  const catIn = `f.category_id IN (${catIds.map(() => '?').join(',')})`

  const { sql: filterSql, params: filterParams } = buildFilters({
    ext: req.query.type ?? req.query.ext,
    minSize: req.query.min,
    maxSize: req.query.max
  })
  const filters = filterSql ? ` AND ${filterSql}` : ''

  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 25))
  const offset = (page - 1) * limit
  const sort = String(req.query.sort ?? 'rel')
  const order = String(req.query.order ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const orderBy = {
    rel: 'files_fts.rank ASC, f.size DESC, f.name COLLATE NOCASE ASC',
    name: `f.name COLLATE NOCASE ${sort === 'name' && order === 'DESC' ? 'DESC' : 'ASC'}`,
    size: `f.size ${order === 'ASC' && sort === 'size' ? 'ASC' : 'DESC'}`,
    date: `f.mtime ${order === 'ASC' && sort === 'date' ? 'ASC' : 'DESC'}`
  }[sort] ?? 'f.size DESC'

  const forceLike = req.query.mode === 'like'
  const likePat = `%${escapeLike(q)}%`

  // --- pass 1: FTS full-text (word/prefix aware, ranked) ---
  // FTS tokenizes BOTH sides identically (unicode61 splits . - _ and spaces),
  // so "alice in" matches "Alice.in.Borderland..." — dots and spaces are the
  // same token boundary. FILE_COLS references the categories alias, so this
  // query MUST join categories; it was missing before, every FTS rows query
  // threw "no such column: c.slug" and was silently swallowed — degrading ALL
  // searches to LIKE substrings, which can never match across separators.
  let rows = null
  let total = 0
  const ftsQ = forceLike ? null : ftsQueryFor(q)
  if (ftsQ) {
    try {
      const base = `FROM files_fts JOIN files f ON f.id = files_fts.rowid JOIN categories c ON c.id = f.category_id WHERE files_fts MATCH ? AND ${catIn}${filters}`
      total = db.prepare(`SELECT COUNT(*) c ${base}`).get(ftsQ, ...catIds, ...filterParams).c
      if (total > 0) {
        rows = db.prepare(
          `SELECT ${FILE_COLS} ${base} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
        ).all(ftsQ, ...catIds, ...filterParams, limit, offset)
      }
    } catch (e) {
      // never swallow silently — a broken FTS pass must be visible in logs
      console.error(`[search] fts pass failed (q=${clip(q, 60)}): ${e.message}`)
    }
  }

  // --- pass 2: substring LIKE fallback (multi-token, separator-insensitive) ---
  // "alice in" → every token must appear as a substring of name or dir, so
  // dotted/dashed/underscored names match too, not just exact-space names.
  if (!rows) {
    const tokens = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t2 => t2.length > 0)
    const cond = tokens.length
      ? tokens.map(() => `(f.name LIKE ? ${LIKE_ESCAPE} OR f.dir LIKE ? ${LIKE_ESCAPE})`).join(' AND ')
      : `(f.name LIKE ? ${LIKE_ESCAPE} OR f.dir LIKE ? ${LIKE_ESCAPE})`
    const likePats = tokens.length
      ? tokens.flatMap(t2 => [`%${escapeLike(t2)}%`, `%${escapeLike(t2)}%`])
      : [likePat, likePat]
    const base = `FROM files f JOIN categories c ON c.id = f.category_id
                  WHERE ${catIn}${filters} AND ${cond}`
    total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...catIds, ...filterParams, ...likePats).c
    const likeOrder = sort === 'size' || sort === 'date' || sort === 'name' ? orderBy : 'f.size DESC, f.name COLLATE NOCASE ASC'
    rows = db.prepare(`SELECT ${FILE_COLS} ${base} ORDER BY ${likeOrder} LIMIT ? OFFSET ?`)
      .all(...catIds, ...filterParams, ...likePats, limit, offset)
  }

  res.json({
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    results: rows.map(r => ({
      id: r.id, name: r.name, path: r.dir, ext: r.ext, size: r.size, mtime: r.mtime,
      cat: { slug: r.cat_slug, name: r.cat_name }
    }))
  })
})

// ---------- single file info ----------
publicRouter.get('/api/file/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' })
  const row = db.prepare(
    `SELECT ${FILE_COLS} FROM files f JOIN categories c ON c.id = f.category_id
     WHERE f.id = ? AND c.enabled = 1`
  ).get(id)
  if (!row) return res.status(404).json({ error: 'not_found' })
  res.json({
    id: row.id, name: row.name, path: row.dir, ext: row.ext, size: row.size, mtime: row.mtime,
    cat: { slug: row.cat_slug, name: row.cat_name }
  })
})

// ---------- stats ----------
publicRouter.get('/api/stats', (req, res) => {
  const agg = db.prepare(
    'SELECT COUNT(*) AS cats, COALESCE(SUM(file_count), 0) AS files, COALESCE(SUM(total_size), 0) AS bytes FROM categories WHERE enabled = 1'
  ).get()
  res.json({
    files: agg.files, bytes: agg.bytes, categories: agg.cats,
    generated: Date.now()
  })
})

// ---------- one-time download links ----------
publicRouter.post('/api/dl', async (req, res) => {
  const ip = clientIp(req)
  const lim = rateLimit({ windowMs: 5 * 60e3, max: 30, key: `dl:${ip}` })
  if (!lim.ok) return res.status(429).json({ error: 'too many links — wait a bit' })

  const id = parseInt(req.body?.id, 10)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' })
  const file = db.prepare(
    `SELECT f.id, f.bucket, f.key FROM files f JOIN categories c ON c.id = f.category_id
     WHERE f.id = ? AND c.enabled = 1`
  ).get(id)
  if (!file) return res.status(404).json({ error: 'not_found' })

  const settings = getSettings()
  const ttlSec = settings.token_ttl_min * 60
  const token = randomToken(24)
  db.prepare(
    'INSERT INTO tokens (token_hash, file_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256hex(token), file.id, Date.now(), Date.now() + ttlSec * 1000)

  res.json({ url: `/get/${token}`, expires_in: ttlSec })
})

// ---------- consume a one-time link ----------
publicRouter.get('/get/:token', (req, res) => {
  const token = String(req.params.token ?? '')
  const row = db.prepare(
    `SELECT t.id, t.used_at, t.expires_at, f.bucket, f.key, f.name
     FROM tokens t JOIN files f ON f.id = t.file_id WHERE t.token_hash = ?`
  ).get(sha256hex(token))

  if (!row) return expiredPage(res, 404, 'link not found')
  if (row.used_at) return expiredPage(res, 410, 'this link has already been used')
  if (row.expires_at < Date.now()) return expiredPage(res, 410, 'this link has expired')

  // HEAD: validate only (download managers probe first) — never reveal the
  // upstream URL and never consume the token.
  if (req.method === 'HEAD') {
    return res.status(200).setHeader('Cache-Control', 'no-store').end()
  }

  // GET: consume the token exactly once
  const used = db.prepare(
    'UPDATE tokens SET used_at = ?, ip = ? WHERE id = ? AND used_at IS NULL'
  ).run(Date.now(), clientIp(req), row.id)
  if (used.changes === 0) return expiredPage(res, 410, 'this link has already been used')

  const settings = getSettings()
  let target
  if (config.dlMode === 'worker') {
    const exp = Math.floor(Date.now() / 1000) + settings.dl_expiry_sec
    const nonce = crypto.randomBytes(10).toString('hex')
    const sig = hmacHex(config.downloadSecret, `${row.bucket}\n${row.key}\n${exp}\n${nonce}`)
    target = `${config.downloadBaseUrl}/d/${b64urlEncode(row.bucket)}/${b64urlEncode(row.key)}?exp=${exp}&n=${nonce}&s=${sig}`
  } else {
    target = presignGet(row.bucket, row.key, settings.dl_expiry_sec)
  }

  res.status(302)
    .setHeader('Cache-Control', 'no-store')
    .setHeader('Location', target)
    .end()
})

// ---------- terminal-styled error pages ----------
function expiredPage (res, code, msg) {
  res.status(code).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>link unavailable — akilas archive</title>
<meta name="robots" content="noindex">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050906;
       color:#c8f7d4;font:14px/1.6 ui-monospace,'Cascadia Mono','JetBrains Mono',Consolas,monospace}
  .box{border:1px solid #1f5c33;background:#07130b;padding:28px 34px;max-width:480px;border-radius:4px;
       box-shadow:0 0 40px rgba(65,255,122,.08)}
  .h{color:#41ff7a;letter-spacing:.2em;font-weight:700;margin-bottom:14px}
  .e{color:#ff6b6b}
  a{color:#6be5ff;text-decoration:none}a:hover{text-decoration:underline}
  .dim{color:#5b8266;font-size:12px;margin-top:16px}
</style></head><body>
<div class="box">
  <div class="h">AKILAS·ARCHIVE</div>
  <div class="e">✗ ${msg}</div>
  <div>one-time links are single-use and expire quickly.<br>go back to the terminal and request a fresh one.</div>
  <div class="dim"><a href="/">← return to terminal</a></div>
</div></body></html>`)
}
