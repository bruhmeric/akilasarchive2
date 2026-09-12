/**
 * akilas-archive download gateway — Cloudflare Worker
 *
 * Validates one-time HMAC links issued by the VPS app, then streams the
 * object straight from R2 to the visitor. File bytes never touch the VPS.
 *
 * URL shape:  /d/<base64url(bucket)>/<base64url(key)>?exp=<unix>&n=<nonce>&s=<hmac>
 * Signature:  HMAC-SHA256(DOWNLOAD_SECRET, `${bucket}\n${key}\n${exp}\n${nonce}`)
 *
 * Supports GET/HEAD and Range requests (resumable / segmented downloads).
 */
import { AwsClient } from 'aws4fetch'

const enc = new TextEncoder()

function b64urlDecode (s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

async function hmacHex (secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function safeEqualHex (a, b) {
  a = String(a); b = String(b)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function page (code, title, detail) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050906;
color:#c8f7d4;font:14px/1.6 ui-monospace,'Cascadia Mono',Consolas,monospace}
.box{border:1px solid #1f5c33;background:#07130b;padding:28px 34px;max-width:460px;border-radius:4px}
.h{color:#41ff7a;letter-spacing:.2em;font-weight:700;margin-bottom:12px}
.e{color:#ff6b6b;margin-bottom:8px}
a{color:#6be5ff;text-decoration:none}
</style></head><body><div class="box"><div class="h">AKILAS·ARCHIVE</div>
<div class="e">✗ ${detail}</div><div>go back to the <a href="https://akilasarchive.site/">terminal</a> and request a fresh one-time link.</div>
</div></body></html>`
  return new Response(body, {
    status: code,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
  })
}

function contentDisposition (key) {
  const raw = key.split('/').pop() || 'download'
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;\r\n]/g, '_')
  const utf8 = encodeURIComponent(raw).replace(/['()]/g, escape)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

export default {
  async fetch (request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'Cache-Control': 'no-store' } })
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return page(405, 'method not allowed', 'method not allowed')
    }

    const m = url.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/)
    if (!m) return page(404, 'not found', 'link not found')

    const exp = parseInt(url.searchParams.get('exp') ?? '', 10)
    const nonce = url.searchParams.get('n') ?? ''
    const sig = url.searchParams.get('s') ?? ''
    if (!exp || !nonce || !sig) return page(400, 'bad link', 'malformed link')

    if (!Number.isFinite(exp) || Date.now() / 1000 > exp) {
      return page(410, 'expired', 'this link has expired')
    }

    const bucket = b64urlDecode(m[1])
    const key = b64urlDecode(m[2])

    if (!env.DOWNLOAD_SECRET || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID) {
      return page(500, 'misconfigured', 'gateway is missing configuration — check worker secrets')
    }

    const expected = await hmacHex(env.DOWNLOAD_SECRET, `${bucket}\n${key}\n${exp}\n${nonce}`)
    if (!safeEqualHex(expected, sig)) {
      return page(403, 'invalid', 'invalid link signature')
    }

    // fetch the object from R2 via the S3 API
    const r2 = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      region: 'auto',
      service: 's3'
    })
    const path = '/' + [bucket, ...key.split('/')].map(encodeURIComponent).join('/')
    const target = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com${path}`

    const headers = {}
    if (request.headers.get('range')) headers.Range = request.headers.get('range')

    let upstream
    try {
      const signed = await r2.sign(new Request(target, { method: request.method, headers }))
      upstream = await fetch(signed)
    } catch (e) {
      return page(502, 'upstream error', 'storage unreachable — try again shortly')
    }

    if (upstream.status === 404 || upstream.status === 403) {
      return page(404, 'not found', 'file not found')
    }
    if (!upstream.ok && upstream.status !== 206) {
      return page(502, 'upstream error', 'storage error — try again shortly')
    }

    const out = new Headers()
    out.set('Content-Disposition', contentDisposition(key))
    out.set('Accept-Ranges', 'bytes')
    out.set('Cache-Control', 'no-store')
    out.set('X-Robots-Tag', 'noindex')
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h)
      if (v) out.set(h, v)
    }
    if (!out.has('Content-Type')) out.set('Content-Type', 'application/octet-stream')

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: out
    })
  }
}
