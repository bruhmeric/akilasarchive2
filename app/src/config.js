import path from 'node:path'

const APP_VERSION = '1.0.0'
const APP_NAME = 'Akilas Archive'

function envStr (name, def) {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return v
}

function envInt (name, def) {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) ? v : def
}

function required (name, hint) {
  const v = process.env[name]
  if (!v) {
    console.error(`\n[FATAL] Missing required environment variable: ${name}`)
    console.error(`         ${hint}\n`)
    process.exit(1)
  }
  return v
}

const publicBaseUrl = envStr('PUBLIC_BASE_URL', 'https://akilasarchive.site')

const config = {
  version: APP_VERSION,
  name: APP_NAME,
  port: envInt('PORT', 3000),
  dataDir: envStr('DATA_DIR', path.join(process.cwd(), 'data')),

  // --- Cloudflare R2 (S3-compatible API) ---
  r2: {
    accountId: required('R2_ACCOUNT_ID', 'Find it in Cloudflare dashboard -> R2 -> right sidebar "Account ID".'),
    accessKeyId: required('R2_ACCESS_KEY_ID', 'Create an R2 API token with "Object Read & Write" and copy the Access Key ID.'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY', 'Secret Access Key from the same R2 API token.')
  },

  // --- download gateway ---
  downloadSecret: required('DOWNLOAD_SECRET', 'Shared HMAC secret between this app and the Cloudflare Worker. Generate: openssl rand -hex 32'),
  dlMode: envStr('DL_MODE', 'worker') === 'presign' ? 'presign' : 'worker',
  downloadBaseUrl: envStr('DOWNLOAD_BASE_URL', 'https://dl.akilasarchive.site').replace(/\/+$/, ''),
  dlExpirySeconds: envInt('DL_EXPIRY_SECONDS', 300),

  // --- auth ---
  sessionSecret: required('SESSION_SECRET', 'Signs admin session cookies. Generate: openssl rand -hex 32'),
  adminPassword: envStr('ADMIN_PASSWORD', 'changeme123'),
  // ADMIN_PASSWORD_FORCE=1 → on boot, overwrite the stored (DB) password with
  // ADMIN_PASSWORD. Recovers you when the first boot seeded a different value.
  adminPasswordForce: /^(1|true|yes)$/i.test(envStr('ADMIN_PASSWORD_FORCE', '')),
  cookieSecure: publicBaseUrl.startsWith('https://'), // legacy hint — cookie Secure flag is decided per-request from the actual scheme (req.secure)

  // --- behaviour ---
  tokenTtlMinutes: envInt('TOKEN_TTL_MINUTES', 10),
  indexIntervalHours: envInt('INDEX_INTERVAL_HOURS', 6)
}

config.r2.endpoint = `https://${config.r2.accountId}.r2.cloudflarestorage.com`

export default config
