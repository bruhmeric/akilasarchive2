/* akilas archive · root console — vanilla JS */
/* global document, fetch, setInterval, location, window */
(() => {
  'use strict'

  const $ = (s) => document.querySelector(s)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  function fmtSize (b) {
    if (!Number.isFinite(b) || b < 0) return '—'
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let i = 0; let v = b
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + u[i]
  }
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US')
  function fmtDate (ms) {
    if (!ms) return 'never'
    const d = new Date(ms)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  function fmtDur (s) {
    if (s < 60) return s + 's'
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
  }

  async function api (path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    })
    if (res.status === 401) { showLogin(); throw new Error('unauthorized') }
    let data = null
    try { data = await res.json() } catch { /* empty */ }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
  }

  function toast (msg, isErr = false) {
    const t = $('#toast')
    t.textContent = msg
    t.className = isErr ? 'err' : ''
    t.hidden = false
    clearTimeout(toast._t)
    toast._t = setTimeout(() => { t.hidden = true }, 3800)
  }

  // ── views ──
  function showLogin () {
    $('#login').hidden = false
    $('#app').hidden = true
    $('#login-pw').focus()
    initTurnstile()
  }
  function showApp () {
    $('#login').hidden = true
    $('#app').hidden = false
  }

  function switchView (name) {
    for (const b of document.querySelectorAll('.side nav button')) {
      b.classList.toggle('on', b.dataset.view === name)
    }
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + name
    if (name === 'logs') loadLogs()
    if (name === 'stats') loadStats()
  }
  document.querySelectorAll('.side nav button').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view))
  })

  // ── Cloudflare Turnstile (login human verification) ──
  // The server owns the config (TURNSTILE_SITE_KEY / TURNSTILE_SECRET) and
  // exposes the PUBLIC site key at /admin/api/turnstile; the widget renders
  // only when that key exists. Tokens are single-use: after any failed login
  // the widget is reset so the next attempt gets a fresh one (canonical
  // lifecycle from the Turnstile integration guide).
  const TURNSTILE = { siteKey: null, enforced: false, widgetId: null, scriptPromise: null }

  async function initTurnstile () {
    if (TURNSTILE.siteKey !== null) return // already resolved (fetch once per page)
    try {
      const res = await fetch('/admin/api/turnstile', { credentials: 'same-origin' })
      if (!res.ok) return
      const data = await res.json()
      TURNSTILE.siteKey = data.site_key || null
      TURNSTILE.enforced = !!data.enforced
    } catch { return } // offline / proxy hiccup — the server 403 will explain
    if (!TURNSTILE.siteKey) return
    const box = $('#turnstile')
    if (!box) return
    box.hidden = false
    loadTurnstileApi().then(renderTurnstile).catch(() => { /* script failed — submit will surface it */ })
  }

  function loadTurnstileApi () {
    if (window.turnstile) return Promise.resolve() // already loaded (or mocked)
    if (TURNSTILE.scriptPromise) return TURNSTILE.scriptPromise
    TURNSTILE.scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('turnstile script failed to load'))
      document.head.appendChild(s)
    })
    return TURNSTILE.scriptPromise
  }

  function renderTurnstile () {
    if (!window.turnstile || TURNSTILE.widgetId !== null) return
    const el = $('#turnstile')
    if (!el || !TURNSTILE.siteKey) return
    TURNSTILE.widgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE.siteKey,
      action: 'login',
      theme: 'dark',
      size: 'flexible',
      callback: () => { $('#login-err').hidden = true } // solved → clear stale error
    })
  }

  function turnstileToken () {
    if (TURNSTILE.widgetId === null || !window.turnstile) return null
    try { return window.turnstile.getResponse(TURNSTILE.widgetId) || null } catch { return null }
  }

  // single-use tokens: every failed attempt must re-challenge
  function resetTurnstile () {
    if (TURNSTILE.widgetId === null || !window.turnstile) return
    try { window.turnstile.reset(TURNSTILE.widgetId) } catch { /* ignore */ }
  }

  function removeTurnstile () {
    if (TURNSTILE.widgetId === null || !window.turnstile) return
    try { window.turnstile.remove(TURNSTILE.widgetId) } catch { /* ignore */ }
    TURNSTILE.widgetId = null
  }

  // ── login ──
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = $('#login-err')
    const btn = $('#login-form button[type=submit]')
    err.hidden = true
    btn.disabled = true
    const pw = $('#login-pw').value

    // captcha gate client-side: don't even send a request without a token
    const tsToken = turnstileToken()
    if (TURNSTILE.siteKey && !tsToken) {
      btn.disabled = false
      err.textContent = '✗ ' + (TURNSTILE.widgetId === null
        ? 'verification required, but the widget could not load — check TURNSTILE_SITE_KEY / reload'
        : 'complete the human verification first')
      err.hidden = false
      return
    }

    try {
      // direct fetch (not api()): a 401 here must show the SERVER's message
      // ("invalid password" / "locked — retry in N min" / captcha 403s), not the
      // generic unauthorized handler used for expired sessions.
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(tsToken ? { password: pw, 'cf-turnstile-response': tsToken } : { password: pw })
      })
      let data = null
      try { data = await res.json() } catch { /* not json */ }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`) // catch block resets the widget (single-use token)
      $('#login-pw').value = ''
      // verify the session cookie actually persisted — previously a dropped
      // cookie bounced the UI back here SILENTLY (looked like "nothing happens")
      const check = await fetch('/admin/api/session', { credentials: 'same-origin' })
      if (!check.ok) {
        let hint = 'login accepted, but the session cookie was not kept by the browser'
        if (data?.secure && location.protocol === 'http:') hint += ' — cookie was marked Secure over plain HTTP'
        else hint += ' — are cookies blocked for this site?'
        throw new Error(hint)
      }
      showApp()
      removeTurnstile()
      await refreshAll()
    } catch (ex) {
      $('#login-pw').value = pw
      resetTurnstile()
      const msg = /Failed to fetch|NetworkError/i.test(ex.message) ? 'network error — site unreachable' : (ex.message || 'login failed')
      err.textContent = '✗ ' + msg
      err.hidden = false
    } finally {
      btn.disabled = false
    }
  })

  $('#logout').addEventListener('click', async () => {
    try { await api('/admin/api/logout', { method: 'POST' }) } catch { /* ignore */ }
    location.reload()
  })

  // ── data ──
  let STATUS = null

  async function refreshAll () {
    try {
      STATUS = await api('/admin/api/status')
    } catch { return }
    const s = STATUS

    $('#ver').textContent = 'v' + (s.version || '')
    $('#default-warn').hidden = !s.password_is_default

    // dashboard
    const files = s.categories.reduce((a, c) => a + c.file_count, 0)
    const bytes = s.categories.reduce((a, c) => a + c.total_size, 0)
    $('#d-files').textContent = fmtNum(files)
    $('#d-size').textContent = fmtSize(bytes)
    $('#d-cats').textContent = s.categories.filter((c) => c.enabled).length + ' / ' + s.categories.length
    $('#d-tokens').textContent = fmtNum(s.tokens_today?.used || 0) + ' used · ' + fmtNum(s.tokens_today?.issued || 0) + ' issued'
    $('#d-db').textContent = fmtSize(s.db_bytes)
    $('#d-up').textContent = fmtDur(s.uptime_s)

    // indexer
    const idx = $('#indexer-state')
    if (s.indexer.running) {
      const c = s.indexer.current || {}
      idx.innerHTML = `<span class="spin"></span><span class="live">indexing "${esc(c.name ?? '')}" — ${fmtNum(c.listed ?? 0)} objects${s.indexer.queued.length ? ' · ' + s.indexer.queued.length + ' queued' : ''}</span>`
    } else {
      idx.innerHTML = 'idle · scheduler every ' + (s.settings.index_interval_hours || 0) + 'h'
    }

    // tables
    renderCats($('#dash-cats'), s.categories, false)
    renderCats($('#cats-table'), s.categories, true)

    // settings
    $('#s-interval').value = s.settings.index_interval_hours
    $('#s-ttl').value = s.settings.token_ttl_min
    $('#s-expiry').value = s.settings.dl_expiry_sec

    // env info
    const t = s.turnstile
    $('#env-info').innerHTML = [
      ['download gateway', s.dl_mode + ' → ' + s.download_base],
      ['cloudflare account', s.r2_account],
      ['login captcha', t && t.enabled ? 'turnstile on · ' + (t.hostnames || []).join(', ') : 'off'],
      ['re-index interval', s.settings.index_interval_hours + 'h'],
      ['one-time link TTL', s.settings.token_ttl_min + ' min'],
      ['download window', s.settings.dl_expiry_sec + ' s']
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
  }

  function renderCats (tbl, cats, full) {
    if (!cats.length) {
      tbl.innerHTML = '<tr><td class="dim">no categories yet — add one above</td></tr>'
      return
    }
    const head = '<tr>' +
      (full ? '<th></th>' : '') + '<th>name</th>' + (full ? '<th>bucket</th>' : '') +
      '<th class="num">files</th><th class="num">size</th>' +
      (full ? '<th>last index</th><th>status</th><th></th>' : '') + '</tr>'
    const rows = cats.map((c) => {
      const toggle = full
        ? `<td><span class="sw ${c.enabled ? 'on' : ''}" data-toggle="${c.id}" title="serve / hide"></span></td>`
        : ''
      const status = c.last_error
        ? `<td class="err-cell" title="${esc(c.last_error)}">✗ ${esc(c.last_error.slice(0, 40))}</td>`
        : c.last_index_at
          ? `<td class="dim">ok · ${esc(fmtDate(c.last_index_at))}</td>`
          : '<td class="dim">not indexed yet</td>'
      const actions = full
        ? `<td style="white-space:nowrap">
             <button class="btn mini" data-reindex="${c.id}">reindex</button>
             <button class="btn mini danger" data-del="${c.id}">remove</button>
           </td>`
        : ''
      return `<tr${c.enabled ? '' : ' style="opacity:.5"'}>
        ${toggle}<td><b>${esc(c.name)}</b><div class="dim" style="font-size:11px">~/${esc(c.slug)}</div></td>
        ${full ? `<td class="dim">${esc(c.bucket)}</td>` : ''}
        <td class="num">${fmtNum(c.file_count)}</td>
        <td class="num">${fmtSize(c.total_size)}</td>
        ${full ? `<td class="dim">${esc(fmtDate(c.last_index_at))}</td>` : ''}
        ${full ? status : ''}${actions}</tr>`
    }).join('')
    tbl.innerHTML = head + rows
  }

  // table interactions (event delegation)
  document.addEventListener('click', async (e) => {
    const t = e.target
    const toggle = t.closest('[data-toggle]')
    if (toggle) {
      const id = toggle.dataset.toggle
      const cat = STATUS?.categories?.find((c) => String(c.id) === String(id))
      try {
        await api(`/admin/api/categories/${id}`, { method: 'PATCH', body: { enabled: cat ? !cat.enabled : true } })
        toast('category updated')
        await refreshAll()
      } catch (ex) { toast(ex.message, true) }
      return
    }
    const reidx = t.closest('[data-reindex]')
    if (reidx) {
      try {
        await api('/admin/api/reindex', { method: 'POST', body: { id: +reidx.dataset.reindex } })
        toast('reindex queued')
        await refreshAll()
      } catch (ex) { toast(ex.message, true) }
      return
    }
    const del = t.closest('[data-del]')
    if (del) {
      const id = del.dataset.del
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1'
        del.textContent = 'sure?'
        setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'remove' }, 3000)
        return
      }
      try {
        await api(`/admin/api/categories/${id}`, { method: 'DELETE' })
        toast('category removed')
        await refreshAll()
      } catch (ex) { toast(ex.message, true) }
      return
    }
  })

  // ── add category ──
  $('#add-cat').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = $('#add-cat button[type=submit]')
    btn.disabled = true
    btn.textContent = 'validating bucket…'
    try {
      await api('/admin/api/categories', {
        method: 'POST',
        body: { name: $('#cat-name').value, bucket: $('#cat-bucket').value.trim().toLowerCase() }
      })
      toast('category added — indexing started')
      $('#cat-name').value = ''
      $('#cat-bucket').value = ''
      await refreshAll()
    } catch (ex) {
      toast(ex.message, true)
    } finally {
      btn.disabled = false
      btn.textContent = 'add & index'
    }
  })

  // ── reindex all ──
  $('#reindex-all').addEventListener('click', async () => {
    try {
      await api('/admin/api/reindex', { method: 'POST', body: {} })
      toast('full reindex queued')
      await refreshAll()
    } catch (ex) { toast(ex.message, true) }
  })

  // ── settings ──
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      await api('/admin/api/settings', {
        method: 'POST',
        body: {
          index_interval_hours: +$('#s-interval').value,
          token_ttl_min: +$('#s-ttl').value,
          dl_expiry_sec: +$('#s-expiry').value
        }
      })
      toast('settings saved')
      await refreshAll()
    } catch (ex) { toast(ex.message, true) }
  })

  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      await api('/admin/api/password', {
        method: 'POST',
        body: { current: $('#pw-cur').value, next: $('#pw-new').value }
      })
      toast('password changed — other sessions logged out')
      $('#pw-cur').value = ''
      $('#pw-new').value = ''
      $('#default-warn').hidden = true
    } catch (ex) { toast(ex.message, true) }
  })

  // ── statistics ──
  async function loadStats () {
    let s
    try {
      s = await api('/admin/api/stats')
    } catch (ex) {
      $('#stats-cards').innerHTML = ''
      toast(ex.message, true)
      return
    }
    renderStats(s)
  }

  function barRows (rows) {
    // rows → [{label, value, display}] with bar width relative to max
    const max = Math.max(...rows.map(r => r.value), 1)
    return rows.map(r => {
      const w = Math.max(2, Math.round((r.value / max) * 100))
      return `<div class="barrow">
        <span class="barlabel" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="bartrack"><span class="bar" style="width:${w}%"></span></span>
        <span class="barval">${esc(r.display ?? fmtNum(r.value))}</span>
      </div>`
    }).join('') || '<div class="dim" style="padding:6px 0">no data</div>'
  }

  function renderStats (s) {
    const t = s.totals || {}
    // overview cards
    const cards = [
      ['files indexed', fmtNum(t.files)],
      ['total size', fmtSize(t.bytes)],
      ['average file', fmtSize(t.avg_size)],
      ['categories', s.enabled_categories + ' / ' + (s.categories || []).length + ' enabled'],
      ['links used', fmtNum(s.links?.retained?.used || 0) + ' · ' + fmtNum(s.links?.retained?.issued || 0) + ' issued'],
      ['unique downloaders', fmtNum(s.links?.retained?.unique_ips || 0)]
    ]
    $('#stats-cards').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')

    // per-category table
    const totalBytes = (s.categories || []).reduce((a, c) => a + (c.bytes || 0), 0) || 1
    $('#stats-cats').innerHTML = '<tr><th>category</th><th>status</th><th class="num">files</th><th class="num">size</th><th class="num">avg</th><th class="num">% of archive</th><th>last index</th></tr>' +
      (s.categories || []).map(c => {
        const pct = ((c.bytes / totalBytes) * 100).toFixed(1)
        const status = c.enabled ? '<span class="ok-cell">serving</span>' : '<span class="dim">disabled</span>'
        const idx = c.last_error
          ? `<span class="err-cell" title="${esc(c.last_error)}">✗ error</span>`
          : `<span class="dim">${esc(fmtDate(c.last_index_at))}</span>`
        return `<tr${c.enabled ? '' : ' style="opacity:.5"'}>
          <td><b>${esc(c.name)}</b></td><td>${status}</td>
          <td class="num">${fmtNum(c.files)}</td><td class="num">${fmtSize(c.bytes)}</td>
          <td class="num">${fmtSize(c.avg_size)}</td><td class="num">${pct}%</td>
          <td>${idx}</td></tr>`
      }).join('') || '<tr><td class="dim">no categories</td></tr>'
    $('#stats-cats-note').textContent = 'sorted by size · generated ' + fmtDate(s.generated_at)

    // file types
    $('#stats-ext').innerHTML = barRows(
      (s.extensions || []).map(e => ({ label: '.' + e.ext, value: e.files, display: fmtNum(e.files) + ' · ' + fmtSize(e.bytes) })))

    // size distribution
    $('#stats-sizes').innerHTML = barRows(
      (s.size_buckets || []).map(b => ({ label: b.bucket.replace(/^[0-9] /, ''), value: b.files, display: fmtNum(b.files) })))

    // links per day (14d)
    const l = s.links || {}
    $('#stats-days').innerHTML = barRows(
      (s.downloads_by_day || []).map(d => ({ label: d.day.slice(5), value: d.used, display: fmtNum(d.used) })))
    $('#stats-links-note').textContent =
      `24h: ${fmtNum(l.last_24h?.used || 0)} used / ${fmtNum(l.last_24h?.issued || 0)} issued · 7d: ${fmtNum(l.last_7d?.used || 0)} used / ${fmtNum(l.last_7d?.issued || 0)} issued · link records are pruned ~24h after expiry`

    // top downloads / largest / newest
    const fileTable = (head, rows, rowFn) => '<tr>' + head.map(h => `<th${h[1] ? ` class="${h[1]}"` : ''}>${h[0]}</th>`).join('') + '</tr>' +
      (rows.length ? rows.map(rowFn).join('') : '<tr><td class="dim" colspan="' + head.length + '">no data yet</td></tr>')

    $('#stats-top').innerHTML = fileTable(
      [['file'], ['category'], ['downloads', 'num'], ['size', 'num']],
      s.top_downloads || [],
      f => `<tr><td style="overflow-wrap:anywhere">${esc(f.name)}</td><td class="dim">${esc(f.cat)}</td><td class="num">${fmtNum(f.downloads)}</td><td class="num">${fmtSize(f.size)}</td></tr>`)

    $('#stats-largest').innerHTML = fileTable(
      [['file'], ['category'], ['size', 'num']],
      s.largest_files || [],
      f => `<tr><td style="overflow-wrap:anywhere">${esc(f.name)}</td><td class="dim">${esc(f.cat)}</td><td class="num">${fmtSize(f.size)}</td></tr>`)

    $('#stats-newest').innerHTML = fileTable(
      [['file'], ['category'], ['size', 'num'], ['added/modified', '']],
      s.newest_files || [],
      f => `<tr><td style="overflow-wrap:anywhere">${esc(f.name)}</td><td class="dim">${esc(f.cat)}</td><td class="num">${fmtSize(f.size)}</td><td class="dim">${esc(fmtDate(f.mtime))}</td></tr>`)
  }

  // ── logs ──
  async function loadLogs () {
    try {
      const { logs } = await api('/admin/api/logs')
      $('#log-table').innerHTML =
        '<tr><th>time</th><th>action</th><th>detail</th></tr>' +
        (logs.length
          ? logs.map((l) => `<tr><td class="dim" style="white-space:nowrap">${esc(fmtDate(l.at))}</td><td>${esc(l.action)}</td><td class="dim" style="overflow-wrap:anywhere">${esc(l.detail ?? '')}</td></tr>`).join('')
          : '<tr><td class="dim">no entries</td></tr>')
    } catch { /* ignore */ }
  }

  // ── boot ──
  ; (async () => {
    try {
      await api('/admin/api/session')
      showApp()
      await refreshAll()
      setInterval(() => { if (!$('#app').hidden && !document.hidden) refreshAll() }, 4000)
    } catch {
      showLogin()
    }
  })()
})()
