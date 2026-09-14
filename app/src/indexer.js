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

  // 4) renumber ids → contiguous 1..N across the whole archive. files.id is
  //    what the terminal shows (#12, `download 12`), so it must track the
  //    archive, not the AUTOINCREMENT high-water mark (which only climbs —
  //    a few re-index cycles had live ids starting at 3000).
  try { renumberFiles() } catch (e) { console.error('[indexer] renumber failed:', e.message) }

  state.current = { id: categoryId, name: cat.name, phase: 'done', listed }
}

export function status () {
  return {
    running: state.running,
    queued: [...state.queued],
    current: state.current
  }
}

// ---------- id renumbering ----------
// files.id is what the terminal renders (#12) and what `download 12` takes,
// so it should read like an index into the archive. SQLite AUTOINCREMENT never
// reuses ids, and every re-index deletes + re-inserts a category's rows, so
// ids only climb (a live DB indexed a few times showed ids starting at 3000).
// Renumbering the whole table to contiguous 1..N — after every successful
// index, after category deletes, and once at boot when needed — keeps ids
// meaningful: same file set ⇒ same ids, ordered category → dir → name.
const RENUMBER_ORDER = 'category_id, dir COLLATE NOCASE, name COLLATE NOCASE, key'

/**
 * Renumber files.id to contiguous 1..N in one transaction:
 *   1. snapshot files + old→new id map
 *   2. remap tokens.file_id (active one-time links keep downloading the SAME
 *      object); unused links to a vanished file are deleted (their old id may
 *      be recycled onto a different file — they were dead links anyway)
 *   3. rebuild files with explicit ids — the INSERT/DELETE triggers keep
 *      files_fts (rowid = files.id) in sync automatically
 * Returns the file count, or 0 when there is nothing to do.
 */
export function renumberFiles () {
  const count = db.prepare('SELECT COUNT(*) AS c FROM files').get().c
  if (!count) return 0

  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS temp.files_copy; DROP TABLE IF EXISTS temp.id_map;')
    db.exec('CREATE TEMP TABLE files_copy AS SELECT category_id, bucket, key, dir, name, ext, size, mtime FROM files')
    db.exec(`CREATE TEMP TABLE id_map AS
             SELECT id AS old_id, ROW_NUMBER() OVER (ORDER BY ${RENUMBER_ORDER}) AS new_id FROM files`)

    // prune FIRST (evaluated against the OLD ids): unused links whose file is
    // gone — after the remap below they would be indistinguishable from
    // freshly-remapped links and get wrongly deleted
    db.prepare(
      'DELETE FROM tokens WHERE used_at IS NULL AND file_id NOT IN (SELECT old_id FROM id_map)'
    ).run()
    // then remap: active one-time links keep downloading the SAME object
    db.prepare(
      'UPDATE tokens SET file_id = (SELECT new_id FROM id_map WHERE old_id = file_id) WHERE file_id IN (SELECT old_id FROM id_map)'
    ).run()

    db.exec('DELETE FROM files')
    db.exec(`INSERT INTO files (id, category_id, bucket, key, dir, name, ext, size, mtime)
             SELECT ROW_NUMBER() OVER (ORDER BY ${RENUMBER_ORDER}), category_id, bucket, key, dir, name, ext, size, mtime
             FROM files_copy`)

    // keep the AUTOINCREMENT counter low for the next per-category re-index
    // (its freshly inserted rows get compacted right back down at step 4)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'files'").run()
    }
    db.exec('DROP TABLE temp.id_map; DROP TABLE temp.files_copy;')
  })
  tx()
  return count
}

/**
 * Boot-time compaction: renumber only when ids are not already exactly 1..N
 * (DB written before this fix, or a category was deleted). Cheap COUNT/MIN/MAX
 * probe — a no-op on a healthy table. Returns the file count when a renumber
 * ran, 0 otherwise.
 */
export function compactFileIdsAtBoot () {
  try {
    const { c, mn, mx } = db.prepare('SELECT COUNT(*) AS c, MIN(id) AS mn, MAX(id) AS mx FROM files').get()
    if (!c || (mn === 1 && mx === c)) return 0
    return renumberFiles()
  } catch (e) {
    console.error('[indexer] boot id compaction failed:', e.message)
    return 0
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
