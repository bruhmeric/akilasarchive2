/* akilas archive · terminal frontend — vanilla JS, zero dependencies */
/* global document, window, fetch, localStorage, matchMedia, setInterval, location */
(() => {
  'use strict'

  // ── helpers ─────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s)
  const screen = $('#screen')
  const input = $('#cli')
  const promptEl = $('#prompt')

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function scrollDown () { $('#term').scrollTop = $('#term').scrollHeight }

  function line (html, cls = '') {
    const d = document.createElement('div')
    d.className = 'line ' + cls
    d.innerHTML = html
    screen.appendChild(d)
    return d
  }
  function text (t, cls = '') {
    const d = document.createElement('div')
    d.className = 'line ' + cls
    d.textContent = t
    screen.appendChild(d)
    return d
  }
  const hr = (ch = '─', n = 56) => text(ch.repeat(n), 'hr')

  function fmtSize (b) {
    if (!Number.isFinite(b) || b < 0) return '—'
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let i = 0; let v = b
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + '\u2009' + u[i]
  }
  function fmtDate (ms) {
    if (!ms) return '—'
    const d = new Date(ms)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US')

  function parseSize (s) {
    const m = String(s).match(/^([\d.]+)\s*(b|kb?|mb?|gb?|tb?)$/i)
    if (!m) return NaN
    const mult = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }
    const key = m[2].toLowerCase()
    return Math.round(parseFloat(m[1]) * (mult[key] ?? NaN))
  }

  function tokenize (raw) {
    const out = []
    let cur = ''; let q = null
    for (const ch of raw) {
      if (q) { if (ch === q) q = null; else cur += ch; continue }
      if (ch === '"' || ch === "'") { q = ch; continue }
      if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = '' } continue }
      cur += ch
    }
    if (cur) out.push(cur)
    return out
  }
  const shq = (s) => (/^[\w./@-]+$/.test(s) ? s : `"${s}"`)

  // ── api ─────────────────────────────────────────────────────
  async function api (path, opts = {}) {
    let res
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      })
    } catch {
      throw new Error('connection failed — check your network')
    }
    if (res.status === 429) throw new Error('rate limited — slow down a little')
    let data = null
    try { data = await res.json() } catch { /* empty */ }
    if (!res.ok) {
      const map = { not_found: 'not found', bad_id: 'invalid id', unknown_category: 'no such category', empty_query: 'empty query' }
      throw new Error(map[data?.error] || `service error (HTTP ${res.status})`)
    }
    return data
  }

  // ── state ───────────────────────────────────────────────────
  const state = {
    cats: [],          // [{slug,name,count,size}]
    stats: { files: 0, bytes: 0, categories: 0 },
    cwd: { cat: null, sub: [] },
    history: JSON.parse(localStorage.getItem('aa_hist') || '[]'),
    histIdx: -1
  }

  async function refreshMeta () {
    try {
      const [cats, stats] = await Promise.all([api('/api/categories'), api('/api/stats')])
      state.cats = cats.categories
      state.stats = stats
      $('#sb-files').textContent = fmtNum(stats.files) + ' files'
    } catch {
      $('#sb-files').textContent = 'offline'
    }
  }

  // ── prompt ──────────────────────────────────────────────────
  function cwdString () {
    const parts = []
    if (state.cwd.cat) parts.push(state.cwd.cat, ...state.cwd.sub)
    return '~' + (parts.length ? '/' + parts.join('/') : '')
  }
  function renderPrompt () {
    promptEl.innerHTML =
      `<span class="u">guest@akilasarchive</span><span class="d">:</span>` +
      `<span class="w">${esc(cwdString())}</span><span class="d">$</span> `
    $('#sb-path').textContent = cwdString()
  }

  // ── path resolution ─────────────────────────────────────────
  function resolvePath (arg) {
    if (!arg || arg === '~') return { cat: null, sub: [] }
    const absolute = arg.startsWith('~') || arg.startsWith('/')
    const base = absolute ? [] : (state.cwd.cat ? [state.cwd.cat, ...state.cwd.sub] : [])
    const segs = []
    for (const tok of arg.replace(/^~\/?|^\//, '').split('/')) {
      if (!tok || tok === '.') continue
      if (tok === '..') { segs.pop(); continue }
      segs.push(tok)
    }
    if (!segs.length) return { cat: null, sub: [] }
    if (!absolute && !state.cwd.cat) {
      // relative from root = absolute
    }
    const cat = state.cats.find(
      (c) => c.slug === segs[0].toLowerCase() || c.name.toLowerCase() === segs[0].toLowerCase())
    if (!cat) {
      const near = state.cats.find((c) => c.slug.startsWith(segs[0].toLowerCase().slice(0, 3)))
      return { err: `no such category: ${segs[0]}${near ? ` — did you mean "${near.name}"?` : ' (try: ls)'}` }
    }
    return { cat: cat.slug, catName: cat.name, sub: segs.slice(1) }
  }

  // ── output: rows ────────────────────────────────────────────
  function rowHead () {
    const d = document.createElement('div')
    d.className = 'row rows-head'
    d.innerHTML = '<span>ID</span><span class="size">SIZE</span><span>DATE</span><span>NAME</span>'
    screen.appendChild(d)
  }

  function fileRow (f, catSlug) {
    const d = document.createElement('div')
    d.className = 'row'
    d.innerHTML =
      `<span class="id">${esc(String(f.id))}</span>` +
      `<span class="size">${esc(fmtSize(f.size))}</span>` +
      `<span class="date">${esc(fmtDate(f.mtime))}</span>` +
      `<span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>`
    d.title = 'click to download'
    d.onclick = () => { exec(`download ${f.id}`, { auto: true }) }
    screen.appendChild(d)
    return d
  }

  function dirRow (name, count, target) {
    const d = document.createElement('div')
    d.className = 'row drow'
    d.innerHTML =
      `<span class="id"></span><span class="size"></span>` +
      `<span class="date">${esc(String(count))} items</span>` +
      `<span class="fname">${esc(name)}/</span>`
    d.title = 'click to open'
    d.onclick = () => { exec(`cd ${shq(target)}`) }
    screen.appendChild(d)
    return d
  }

  function footerNote (msg) { text(msg, 'footer-note') }

  // ════════════════════════════════════════════════════════════
  // COMMANDS
  // ════════════════════════════════════════════════════════════

  async function cmdLs (argv) {
    let page = 1
    let target = null
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-p' || argv[i] === '--page') { page = Math.max(1, parseInt(argv[++i], 10) || 1) } else if (!target) { target = argv[i] }
    }
    const loc = resolvePath(target ?? '')

    if (loc.err) return text(loc.err, 'err')

    if (!loc.cat) {
      if (!state.cats.length) return text('no volumes mounted yet — check back soon.', 'warn')
      text(`~/  ·  ${state.cats.length} categories`, 'dim')
      rowHead()
      for (const c of state.cats) dirRow(c.name, fmtNum(c.count), c.slug)
      footerNote('categories · cd <name> to enter · ls <name> to peek')
      return
    }

    const path = loc.sub.join('/')
    const data = await api(`/api/browse/${encodeURIComponent(loc.cat)}?path=${encodeURIComponent(path)}&page=${page}`)
    text(`${loc.catName ? loc.catName : loc.cat}${path ? '/' + path : ''}/  ·  ${fmtNum(data.files.length + data.dirs.length)} shown${data.hasMore ? ' (more)' : ''}`, 'dim')
    rowHead()
    for (const d of data.dirs) dirRow(d.name, fmtNum(d.count), (path ? path + '/' : '') + d.name)
    for (const f of data.files) fileRow(f)
    if (data.hasMore) footerNote(`— more — run: ls ${shq(target ?? '')} -p ${page + 1}`)
    else if (!data.dirs.length && !data.files.length) footerNote('empty directory')
  }

  async function cmdCd (argv) {
    const loc = resolvePath(argv[0] ?? '')
    if (loc.err) return text(loc.err, 'err')
    if (!loc.cat) { state.cwd = { cat: null, sub: [] }; return }
    if (loc.sub.length) {
      // verify the directory exists
      try {
        await api(`/api/browse/${encodeURIComponent(loc.cat)}?path=${encodeURIComponent(loc.sub.join('/'))}&limit=1`)
      } catch (e) {
        return text(`no such directory: ${loc.sub.join('/')}`, 'err')
      }
    }
    state.cwd = { cat: loc.cat, sub: loc.sub }
  }

  // search flag parser
  function parseSearchArgs (argv) {
    const out = { positional: [], cat: null, type: null, min: null, max: null, sort: null, order: null, page: 1, limit: 25 }
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      const next = () => argv[++i]
      if (a === '-c' || a === '--cat') out.cat = next()
      else if (a === '-t' || a === '--type') out.type = next()
      else if (a === '--min') out.min = parseSize(next() ?? '')
      else if (a === '--max') out.max = parseSize(next() ?? '')
      else if (a === '--sort') out.sort = next()
      else if (a === '--order') out.order = next()
      else if (a === '-p' || a === '--page') out.page = Math.max(1, parseInt(next(), 10) || 1)
      else if (a === '-n' || a === '--limit') out.limit = Math.min(100, Math.max(1, parseInt(next(), 10) || 25))
      else if (a === '--like') out.like = true
      else out.positional.push(a)
    }
    return out
  }

  async function cmdSearch (argv) {
    const f = parseSearchArgs(argv)
    const q = f.positional.join(' ').trim()
    if (!q) {
      text('usage: search <query> [flags]', 'warn')
      text('  -c <cat>       limit to category        -t <ext>    file type (mkv, mp3, pdf…)', 'dim')
      text('  --min <size>   minimum size             --max <size>  maximum size (e.g. 700MB, 1.5GB)', 'dim')
      text('  --sort name|size|date [--order asc|desc]', 'dim')
      text('  -p <page>      next results page        -n <n>      results per page (max 100)', 'dim')
      text('example: search matrix -c movies -t mkv --min 1GB --sort size', 'dim')
      return
    }

    const p = new URLSearchParams()
    p.set('q', q)
    if (f.cat) {
      const cat = state.cats.find((c) => c.slug === f.cat.toLowerCase() || c.name.toLowerCase() === f.cat.toLowerCase())
      if (!cat) return text(`no such category: ${f.cat} (try: ls)`, 'err')
      p.set('cat', cat.slug)
    }
    if (f.type) p.set('type', f.type.replace(/^\./, ''))
    if (Number.isFinite(f.min)) p.set('min', String(f.min))
    if (Number.isFinite(f.max)) p.set('max', String(f.max))
    if (f.sort) p.set('sort', f.sort)
    if (f.order) p.set('order', f.order)
    if (f.like) p.set('mode', 'like')
    p.set('page', String(f.page))
    p.set('limit', String(f.limit))

    const data = await api(`/api/search?${p}`)
    if (!data.total) {
      text(`no matches for "${q}" — try fewer words, a different category, or add --like`, 'warn')
      return
    }
    const scope = f.cat ? ` in ${f.cat}` : ''
    text(`── search "${q}"${scope} · ${fmtNum(data.total)} matches · page ${data.page}/${data.pages} ──`, 'dim')
    rowHead()
    for (const r of data.results) {
      const d = document.createElement('div')
      d.className = 'row'
      d.innerHTML =
        `<span class="id">${esc(String(r.id))}</span>` +
        `<span class="size">${esc(fmtSize(r.size))}</span>` +
        `<span class="date">${esc(fmtDate(r.mtime))}</span>` +
        `<span class="fname" title="${esc(r.name)}"><span style="color:var(--dim)">${esc(r.cat.name)}/</span>${esc(r.path ? r.path + '/' : '')}${esc(r.name)}</span>`
      d.title = 'click to download'
      d.onclick = () => { exec(`download ${r.id}`, { auto: true }) }
      screen.appendChild(d)
    }
    const shown = data.results.length
    const range = `${(data.page - 1) * f.limit + 1}–${(data.page - 1) * f.limit + shown}`
    if (data.page < data.pages) footerNote(`showing ${range} of ${fmtNum(data.total)} · next: search ${shq(q)}${f.cat ? ' -c ' + f.cat : ''} -p ${data.page + 1}`)
    else footerNote(`showing ${range} of ${fmtNum(data.total)} · download <id> to get a link`)
  }

  async function cmdDownload (argv, opts = {}) {
    const id = argv[0]
    if (!id || !/^\d+$/.test(id)) return text('usage: download <id>  — find ids with: search, ls', 'warn')
    const data = await api('/api/dl', { method: 'POST', body: { id: parseInt(id, 10) } })
    const mins = Math.floor(data.expires_in / 60)
    text('✔ one-time download link ready:', 'ok')
    line(`&nbsp;&nbsp;<a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(location.origin + data.url)}</a>`)
    text(`   single-use · expires in ${mins} min${opts.auto ? ' · opening…' : ''}`, 'dim')
    if (opts.auto) {
      const w = window.open(data.url, '_blank', 'noopener')
      if (!w) text('(popup blocked — click the link above)', 'warn')
    }
  }

  async function cmdInfo (argv) {
    const id = argv[0]
    if (!id || !/^\d+$/.test(id)) return text('usage: info <id>', 'warn')
    const f = await api(`/api/file/${parseInt(id, 10)}`)
    const d = document.createElement('div')
    d.className = 'finfo'
    const rows = [
      ['id', `#${f.id}`], ['name', f.name],
      ['path', `${f.cat.name}/${f.path ? f.path + '/' : ''}${f.name}`],
      ['category', f.cat.name], ['type', f.ext ? '.' + f.ext : '—'],
      ['size', fmtSize(f.size)], ['modified', fmtDate(f.mtime)],
      ['download', `run: download ${f.id}`]
    ]
    d.innerHTML = rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('')
    screen.appendChild(d)
  }

  async function cmdTree () {
    if (!state.cats.length) return text('no volumes mounted yet.', 'warn')
    line('<b>~/</b>')
    for (let i = 0; i < state.cats.length; i++) {
      const c = state.cats[i]
      const last = i === state.cats.length - 1
      line(`${esc(last ? '└── ' : '├── ')}<u>${esc(c.name)}/</u>${esc(' '.repeat(Math.max(1, 16 - c.name.length)))}<span style="color:var(--dim)">${fmtNum(c.count)} files · ${fmtSize(c.size)}</span>`)
    }
    footerNote(`total: ${fmtNum(state.stats.files)} files · ${fmtSize(state.stats.bytes)}`)
  }

  async function cmdStats () {
    await refreshMeta()
    line('<b>archive status</b>')
    const rows = [
      ['files', fmtNum(state.stats.files)], ['total size', fmtSize(state.stats.bytes)],
      ['categories', String(state.stats.categories)],
      ['link policy', 'one-time · short-lived'], ['account', 'guest (read-only)']
    ]
    for (const [k, v] of rows) line(`  <span style="color:var(--dim)">${esc(k.padEnd(14, ' '))}</span>${esc(v)}`)
  }

  async function cmdNeofetch () {
    await refreshMeta()
    const logo =
      '   ▄▀█ █▀█ ▀█▀ █▀█ █▀▄▀█\n' +
      '   █▄█ █▄█ ░█░ █▄█ █░▀░█\n' +
      '   ───────────────────'
    const info = [
      'guest@akilasarchive', '──────────────────',
      'os        ArchiveOS 1.0',
      `shell     aash 1.0`,
      `files     ${fmtNum(state.stats.files)}`,
      `storage   ${fmtSize(state.stats.bytes)}`,
      `volumes   ${state.stats.categories}`,
      'links     one-time, expiring',
      'theme     ' + (document.body.dataset.theme || 'green')
    ]
    const lines = logo.split('\n').map((l, i) =>
      line(`  <span style="color:var(--bright)">${esc(l.padEnd(24, ' '))}</span>${esc(info[i] ?? '')}`))
    return lines
  }

  function cmdHelp (argv) {
    const topic = (argv[0] || '').toLowerCase()
    if (topic === 'search') {
      text('search — find files across the archive', 'head')
      text('  search <query> [flags]')
      text('flags:', 'dim')
      text('  -c <cat>      limit to a category (see: ls)', 'dim')
      text('  -t <ext>      file type filter — mkv, mp3, pdf, zip…', 'dim')
      text('  --min <size>  minimum size — e.g. 500MB, 1.5GB', 'dim')
      text('  --max <size>  maximum size', 'dim')
      text('  --sort name|size|date   sort order (default: relevance)', 'dim')
      text('  --order asc|desc        direction', 'dim')
      text('  -p <n>        page number', 'dim')
      text('  -n <n>        results per page (1–100)', 'dim')
      text('  --like        substring search instead of word search', 'dim')
      text('aliases: find, grep', 'dim')
      return
    }
    text('AKILAS ARCHIVE — public file terminal', 'head')
    text('navigation', 'dim')
    text('  ls [path]      list categories / files      cd [path]   change directory')
    text('  tree           archive overview            pwd         where am i')
    text('search', 'dim')
    text('  search <query> find files — run: help search   aliases: find, grep')
    text('download', 'dim')
    text('  download <id>  create a one-time link       info <id>   file details')
    text('misc', 'dim')
    text('  stats · neofetch · about · whoami · date · history · echo · clear')
    text('  theme green|amber|ice · crt on|off · exit')
    hr()
    text('tip: rows are clickable — click a file to download, a folder to open.', 'dim')
  }

  function cmdAbout () {
    line('<b>akilas archive</b> — a public file terminal.')
    text('browse · search · download with single-use links.', 'dim')
    text('files are streamed straight to you from the edge — nothing is proxied.', 'dim')
  }

  // ── jokes / passthrough ─────────────────────────────────────
  const JOKES = {
    sudo: 'guest is not in the sudoers file. this incident will be reported.',
    rm: 'rm: read-only filesystem — this archive is immutable.',
    vim: 'vim: no editors in a browse-only terminal. (you can never leave anyway)',
    nano: 'nano: no editors in a browse-only terminal.',
    emacs: 'emacs: nice try. this terminal weighs less than 512 MB.',
    apt: 'apt: package management is disabled — we only serve files.',
    ping: () => { text('pong — 0.001s (you are already here)', 'ok') },
    top: () => cmdStats(),
    whoami: 'guest',
    exit: () => {
      text('logout — session closed.', 'ok')
      text('refresh the page (or press any key) to reconnect…', 'dim')
      input.blur()
      const reconnect = () => { window.location.reload() }
      window.addEventListener('keydown', reconnect, { once: true })
      window.addEventListener('click', reconnect, { once: true })
    }
  }

  // ── dispatch ────────────────────────────────────────────────
  const CMDS = {
    help: cmdHelp, ls: cmdLs, cd: cmdCd, dir: cmdLs,
    search: cmdSearch, find: cmdSearch, grep: cmdSearch,
    download: cmdDownload, dl: cmdDownload, get: cmdDownload,
    info: cmdInfo, cat: cmdInfo,
    tree: cmdTree, stats: cmdStats, neofetch: cmdNeofetch, about: cmdAbout,
    whoami: () => text(JOKES.whoami), pwd: () => text(cwdString()),
    date: () => text(new Date().toString()),
    echo: (argv) => text(argv.join(' ')),
    clear: () => { screen.innerHTML = '' },
    history: () => state.history.forEach((h, i) => text(`  ${String(i + 1).padStart(3)}  ${h}`, 'dim')),
    theme: (argv) => {
      const t = (argv[0] || '').toLowerCase()
      if (!['green', 'amber', 'ice'].includes(t)) return text('usage: theme green|amber|ice', 'warn')
      document.body.dataset.theme = t
      localStorage.setItem('aa_theme', t)
      text(`theme → ${t}`, 'ok')
    },
    crt: (argv) => {
      const on = (argv[0] || '').toLowerCase() === 'on'
      document.body.classList.toggle('no-crt', !on)
      localStorage.setItem('aa_crt', on ? '1' : '0')
      text(`crt overlay → ${on ? 'on' : 'off'}`, 'ok')
    },
    // jokes
    sudo: () => text(JOKES.sudo, 'warn'),
    rm: () => text(JOKES.rm, 'warn'),
    vim: () => text(JOKES.vim, 'warn'),
    nano: () => text(JOKES.nano, 'warn'),
    emacs: () => text(JOKES.emacs, 'warn'),
    apt: () => text(JOKES.apt, 'warn'),
    ping: JOKES.ping, top: JOKES.top, exit: JOKES.exit, logout: JOKES.exit
  }

  async function exec (raw, opts = {}) {
    const argv = tokenize(raw)
    if (!argv.length) return
    const name = argv[0].toLowerCase()
    const fn = CMDS[name]
    if (!fn) {
      text(`command not found: ${name} — type "help"`, 'err')
      const guess = Object.keys(CMDS).find((c) => c.startsWith(name.slice(0, 2)))
      if (guess) text(`did you mean: ${guess}?`, 'dim')
      return
    }
    try {
      await fn(argv.slice(1), opts)
    } catch (e) {
      text(String(e.message || e), 'err')
    }
    renderPrompt()
    scrollDown()
  }

  // ── input handling ──────────────────────────────────────────
  let busy = false
  async function submit () {
    const raw = input.value
    input.value = ''
    // echo
    line(`<span class="u">guest@akilasarchive</span><span class="d">:</span><span class="w">${esc(cwdString())}</span><span class="d">$</span> ${esc(raw)}`)
    if (!raw.trim()) return
    if (state.history[state.history.length - 1] !== raw) {
      state.history.push(raw)
      if (state.history.length > 200) state.history.shift()
      localStorage.setItem('aa_hist', JSON.stringify(state.history))
    }
    state.histIdx = -1
    busy = true
    try { await exec(raw) } finally { busy = false; input.focus(); scrollDown() }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!busy) submit() }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!state.history.length) return
      state.histIdx = state.histIdx < 0 ? state.history.length - 1 : Math.max(0, state.histIdx - 1)
      input.value = state.history[state.histIdx] ?? ''
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (state.histIdx < 0) return
      state.histIdx++
      if (state.histIdx >= state.history.length) { state.histIdx = -1; input.value = '' } else { input.value = state.history[state.histIdx] }
    } else if (e.key === 'Tab') {
      e.preventDefault()
      complete()
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      screen.innerHTML = ''
    }
  })

  // tab completion: commands + categories
  function complete () {
    const val = input.value
    const parts = val.split(/\s+/)
    const last = parts[parts.length - 1] || ''
    let pool = []
    if (parts.length <= 1) {
      pool = Object.keys(CMDS)
    } else {
      const head = parts[0].toLowerCase()
      if (head === 'cd' || head === 'ls' || head === 'search' || head === 'find' || head === 'grep') {
        const slash = last.lastIndexOf('/')
        const catPart = slash < 0 ? last : last.slice(0, slash)
        pool = state.cats.map((c) => (slash < 0 ? c.slug : catPart + '/' + c.slug))
        // only offer categories for the first path segment
        if (parts.length === 2 && slash < 0) pool = state.cats.map((c) => c.slug)
      } else if (head === 'theme') pool = ['green', 'amber', 'ice']
      else if (head === 'crt') pool = ['on', 'off']
    }
    const hits = pool.filter((p) => p.toLowerCase().startsWith(last.toLowerCase()))
    if (hits.length === 1) {
      parts[parts.length - 1] = hits[0]
      input.value = parts.join(' ') + ' '
    } else if (hits.length > 1) {
      text(hits.join('   '), 'dim')
      scrollDown()
    }
  }

  $('#term').addEventListener('click', (e) => {
    if (String(window.getSelection() ?? '').length) return
    if (e.target.closest('.row, a, button')) return
    input.focus()
  })

  for (const btn of document.querySelectorAll('#chips button')) {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.cmd
      input.focus()
      if (!btn.dataset.cmd.endsWith(' ')) submit()
    })
  }

  // status bar clock
  setInterval(() => {
    const d = new Date()
    $('#sb-clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }, 5000)
  const d0 = new Date()
  $('#sb-clock').textContent = `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`

  // ── boot ────────────────────────────────────────────────────
  const BANNER =
    '   ▄▀█ █▀█ ▀█▀ █▀█ █▀▄▀█\n' +
    '   █▄█ █▄█ ░█░ █▄█ █░▀░█'
  const BANNER_SUB = '· A R C H I V E ·'

  async function boot () {
    // restore prefs
    document.body.dataset.theme = localStorage.getItem('aa_theme') || 'green'
    const crt = localStorage.getItem('aa_crt')
    const small = window.matchMedia('(max-width: 720px)').matches
    document.body.classList.toggle('no-crt', crt === '0' || (crt === null && small))
    renderPrompt()

    const fast = window.matchMedia('(prefers-reduced-motion: reduce)').matches || small
    const steps = [
      ['ArchiveOS 1.0 — booting', 90],
      null, // filled after meta fetch
      ['mounting file volumes', 140],
      ['arming one-time link gateway', 140],
      ['starting shell (aash 1.0)', 160]
    ]
    text('ArchiveOS 1.0 — booting', 'sys')
    if (!fast) await sleep(180)
    await refreshMeta()
    const files = state.stats.files
    const cats = state.stats.categories
    const boot = [
      `[  OK  ] remote storage reachable`,
      `[  OK  ] mounted ${cats} volume${cats === 1 ? '' : 's'}`,
      `[  OK  ] search index: ${fmtNum(files)} files`,
      `[  OK  ] one-time link gateway armed`,
      `[  OK  ] shell ready (aash 1.0)`
    ]
    for (const b of boot) {
      const d = document.createElement('div')
      d.className = 'line sys'
      d.innerHTML = `<span class="boot-tag">[</span><span class="boot-ok">  OK  </span><span class="boot-tag">]</span> ${esc(b.slice(9))}`
      screen.appendChild(d)
      if (!fast) await sleep(120)
    }
    if (state.stats.files === 0 && state.stats.categories === 0) {
      text('[ WAIT ] no volumes mounted yet — archive is being set up', 'warn')
    }
    text('')
    const pre = document.createElement('pre')
    pre.className = 'banner'
    pre.textContent = BANNER
    screen.appendChild(pre)
    text(BANNER_SUB, 'banner-sub')
    text('')
    const motd = document.createElement('div')
    motd.className = 'motd'
    motd.innerHTML =
      `welcome, <span class="k">guest</span>. this is a read-only file terminal.<br>` +
      `&gt; type <span class="k">help</span> for commands · <span class="k">ls</span> to browse · <span class="k">search &lt;name&gt;</span> to find files<br>` +
      `&gt; <span class="k">download &lt;id&gt;</span> gives you a one-time link. rows are clickable.`
    screen.appendChild(motd)
    text('')
    renderPrompt()
    input.focus()
    scrollDown()
  }

  boot()
})()
