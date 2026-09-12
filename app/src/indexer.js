import { db, adminLog } from './db.js'
import { listObjects } from './r2.js'
import { clip, splitObjectKey, yieldLoop } from './util.js'

const state = {
  running: false,
  current: null, // { id, name, phase, listed, error }
  queued: []
}

export function enqueueCategory (categoryId) {
  if (!state.queued.includes(categoryId)) {
    state.queued.push(categoryId)
    kick()
  }
}

function kick () {
  if (state.running) return
  state.running = true
  run().catch(e => console.error('[indexer] crash:', e.message)).finally(() => {
    state.running = false
    if (state.queued.length) kick()
  })
}

async function run () {
  while (state.queued.length) {
    const id = state.queued.shift()
    try {
      await indexCategory(id)
    } catch (e) {
      console.error('[indexer] category failed:', e.message)
      try {
        db.prepare('UPDATE categories SET last_error = ? WHERE id = ?').run(clip(e.message, 300), id)
        state.current = { id, phase: 'error', error: clip(e.message, 200) }
      } catch { /* ignore */ }
    }
  }
}

async function indexCategory (categoryId) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId)
  if (!cat) return
  state.current = { id: categoryId, name: cat.name, bucket: cat.bucket, phase: 'preparing', listed: 0 }
  const t0 = Date.now()

  // 1) clear previous index in chunks (keeps the event loop responsive)
  while (true) {
    const n = db.prepare(
      'DELETE FROM files WHERE category_id = ? AND id IN (SELECT id FROM files WHERE category_id = ? LIMIT 5000)'
    ).run(categoryId, categoryId).changes
    if (n < 5000) break
    await yieldLoop()
  }

  // 2) stream the bucket listing page by page
  const ins = db.prepare(
    'INSERT INTO files (category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  let token
  let listed = 0
  let pages = 0
  do {
    const { objects, nextToken } = await listObjects(cat.bucket, { continuationToken: token })
    pages++
    if (objects.length) {
      const tx = db.transaction(objs => {
        for (const o of objs) {
          const { dir, name, ext } = splitObjectKey(o.key)
          ins.run(categoryId, cat.bucket, o.key, dir, name, ext, o.size, o.lastModified)
        }
      })
      tx(objects)
    }
    listed += objects.length
    state.current = { id: categoryId, name: cat.name, bucket: cat.bucket, phase: 'indexing', listed }
    token = nextToken
    await yieldLoop()
  } while (token && pages < 10000)

  // 3) finalize stats
  const stats = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM files WHERE category_id = ?').get(categoryId)
  db.prepare(
    'UPDATE categories SET last_index_at = ?, last_index_ms = ?, last_error = NULL, file_count = ?, total_size = ? WHERE id = ?'
  ).run(Date.now(), Date.now() - t0, stats.c, stats.s, categoryId)
  adminLog('index_ok', `"${cat.name}" (${cat.bucket}): ${stats.c} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  state.current = { id: categoryId, name: cat.name, phase: 'done', listed }
}

export function status () {
  return {
    running: state.running,
    queued: [...state.queued],
    current: state.current
  }
}

/** Periodic re-index of stale enabled categories. */
export function startScheduler (getIntervalHours) {
  const tick = () => {
    try {
      const h = getIntervalHours()
      if (!h || h <= 0) return
      const stale = db.prepare(
        'SELECT id FROM categories WHERE enabled = 1 AND (last_index_at IS NULL OR last_index_at < ?)'
      ).all(Date.now() - h * 3600e3)
      for (const c of stale) enqueueCategory(c.id)
    } catch (e) {
      console.error('[indexer] scheduler error:', e.message)
    }
  }
  setTimeout(tick, 8000).unref?.()
  setInterval(tick, 10 * 60e3).unref?.()
}
