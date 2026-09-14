/**
 * Cloudflare Turnstile — canonical server-side verification.
 *
 * Follows the siteverify contract from
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/:
 *   1. the browser solves the widget and the token is submitted with the login
 *      request as `cf-turnstile-response` (tokens are single-use, ~300s TTL)
 *   2. the backend POSTs { secret, response, remoteip } form-encoded to
 *      https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   3. login is allowed only when success === true AND the action matches the
 *      protected surface AND the solving page's hostname is in the allowlist
 *
 * Fail-closed: any network/HTTP error rejects the login (canonical behavior).
 * When TURNSTILE_SECRET is unset the gate is disabled entirely (backward
 * compatible with existing deployments and local dev).
 */
import config from './config.js'

const LOGIN_ACTION = 'login'
const expectedHostnames = new Set(config.turnstile.hostnames)

/** true when the server-side gate is active (TURNSTILE_SECRET is set) */
export function turnstileEnabled () {
  return !!config.turnstile.secret
}

/** safe summary for admin-facing status payloads — never includes the secret */
export function turnstileStatus () {
  return {
    enabled: turnstileEnabled(),
    site_key: !!config.turnstile.siteKey,
    hostnames: [...expectedHostnames]
  }
}

export function bootHints () {
  const t = config.turnstile
  const lines = []
  if (t.siteKey && t.secret) {
    lines.push(`  [turnstile] enabled on admin login · hostnames: ${[...expectedHostnames].join(', ') || '(NONE — all logins will be rejected!)'}`)
  } else if (t.siteKey && !t.secret) {
    lines.push('  [turnstile] TURNSTILE_SITE_KEY set but TURNSTILE_SECRET missing — widget renders, verification OFF')
  } else if (!t.siteKey && t.secret) {
    lines.push('  [turnstile] TURNSTILE_SECRET set but TURNSTILE_SITE_KEY missing — widget will NOT render; add the site key or login becomes impossible')
  }
  if (turnstileEnabled() && expectedHostnames.size === 0) {
    lines.push('  [turnstile] hostname allowlist empty (TURNSTILE_HOSTNAMES + PUBLIC_BASE_URL) — every login will be rejected')
  }
  return lines
}

/**
 * Verify a login-captcha token.
 * @param {string|undefined} token `cf-turnstile-response` from the request body
 * @param {string} ip client IP, sent as remoteip (optional, best-effort)
 * @returns {Promise<{ok: true}|{ok: false, reason: 'missing'|'malformed'|'invalid'|'unreachable'}>}
 */
export async function verifyLoginToken (token, ip) {
  if (!turnstileEnabled()) return { ok: true }

  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' }
  if (token.length > 2048) return { ok: false, reason: 'malformed' }

  const params = { secret: config.turnstile.secret, response: token }
  if (ip && ip !== 'unknown') params.remoteip = ip

  let result
  try {
    const r = await fetch(config.turnstile.verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams(params)
    })
    if (!r.ok) throw new Error(`siteverify ${r.status}`)
    result = await r.json()
  } catch {
    // network error / timeout / non-200 from siteverify → fail closed
    return { ok: false, reason: 'unreachable' }
  }

  if (
    !result.success ||
    result.action !== LOGIN_ACTION ||
    !expectedHostnames.has(result.hostname)
  ) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true }
}
