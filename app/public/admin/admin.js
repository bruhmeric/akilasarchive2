/* akilas archive · root console — vanilla JS */
/* global document, fetch, setInterval, location */
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
  }
  document.querySelectorAll('.side nav button').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view))
  })

  // ── login ──
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = $('#login-err')
    const btn = $('#login-form button[type=submit]')
    err.hidden = true
    btn.disabled = true
    const pw = $('#login-pw').value
    try {
      // direct fetch (not api()): a 401 here must show the SERVER's message
      // ("invalid password" / "locked — retry in N min"), not the generic
      // unauthorized handler used for expired sessions.
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pw })
      })
      let data = null
      try { data = await res.json() } catch { /* not json */ }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
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
      await refreshAll()
    } catch (ex) {
      $('#login-pw').value = pw
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
    $('#env-info').innerHTML = [
      ['download gateway', s.dl_mode + ' → ' + s.download_base],
      ['cloudflare account', s.r2_account],
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
