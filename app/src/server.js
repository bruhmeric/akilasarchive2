import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import { db, cleanup, getSettings } from './db.js'
import { seedAdminPassword } from './auth.js'
import { startScheduler, compactFileIdsAtBoot } from './indexer.js'
import { publicRouter } from './routes/public.js'
import { adminRouter } from './routes/admin.js'
import { rateLimit } from './util.js'
import { bootHints as turnstileBootHints } from './turnstile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true) // behind Caddy
app.set('etag', 'strong')

app.use(express.json({ limit: '64kb' }))

// generic API rate limit (cheap safety)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const burst = req.path.startsWith('/api/dl') ? 40 : 240
    const rl = rateLimit({ windowMs: 60e3, max: burst, key: `api:${req.ip || 'unknown'}` })
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter))
      return res.status(429).json({ error: 'rate limited — slow down' })
    }
  }
  next()
})

// admin API (login handled inside)
app.use('/admin/api', adminRouter)

// public API + one-time links
app.use(publicRouter)

// static UI (terminal + admin SPA shell)
app.use(express.static(publicDir, {
  index: 'index.html',
  maxAge: '1h',
  setHeaders (res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
    // the admin SPA evolves with deploys — a STALE admin.js from the browser
    // cache produces "impossible" states (e.g. submitting logins without the
    // captcha code the server now requires). no-cache still 304s via etag,
    // so this is cheap for a single-user control plane.
    else if (filePath.includes(`${path.sep}admin${path.sep}`)) res.setHeader('Cache-Control', 'no-cache')
  }
}))

// JSON 404 for API paths, plain 404 otherwise
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api')) {
    return res.status(404).json({ error: 'not_found' })
  }
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title>' +
    '<body style="background:#050906;color:#c8f7d4;font:14px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
    '404 — nothing here. <a style="color:#6be5ff" href="/">terminal</a></body>')
})

// error handler — never leak internals to public clients
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isAuthed = req.path.startsWith('/admin/')
  console.error(`[error] ${req.method} ${req.path}:`, err.message)
  res.status(err.status || 500).json({
    error: isAuthed ? clipErr(err) : 'internal error'
  })
})

function clipErr (e) {
  return String(e?.message ?? 'internal error').slice(0, 200)
}

// ---------- boot ----------
seedAdminPassword()

// one-shot: compact file ids to 1..N if an older DB (or a mid-run crash) left
// them climbing — no-op when ids are already contiguous
const compactedIds = compactFileIdsAtBoot()

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('─'.repeat(56))
  console.log(`  ${config.name} v${config.version}`)
  console.log(`  listening on :${config.port}  (behind Caddy on 80/443)`)
  console.log(`  dl mode: ${config.dlMode} → ${config.downloadBaseUrl}`)
  console.log(`  index interval: ${getSettings().index_interval_hours}h`)
  if (compactedIds) console.log(`  file ids compacted → 1..${compactedIds} (ids now match the archive size)`)
  for (const line of turnstileBootHints()) console.log(line)
  console.log('─'.repeat(56))
})

startScheduler(() => getSettings().index_interval_hours)
setInterval(cleanup, 10 * 60e3).unref?.()
cleanup()

function shutdown () {
  console.log('\n[shutdown] closing…')
  server.close(() => {
    try { db.close() } catch { /* ignore */ }
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 4000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
