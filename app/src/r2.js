import crypto from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import config from './config.js'
import { decodeXmlEntities, sleep } from './util.js'

let client = null

function getClient () {
  if (!client) {
    client = new AwsClient({
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
      region: 'auto',
      service: 's3'
    })
  }
  return client
}

function extractXmlMessage (xml) {
  const m = String(xml ?? '').match(/<Message>([\s\S]*?)<\/Message>/)
  return m ? decodeXmlEntities(m[1]) : ''
}

/**
 * List a bucket's objects (ListObjectsV2), SigV4 header-signed.
 * Metadata-only network call — no file bytes are transferred.
 */
export async function listObjects (bucket, { continuationToken, maxKeys = 1000, retries = 2 } = {}) {
  const url = new URL(`${config.r2.endpoint}/${bucket}`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('max-keys', String(maxKeys))
  if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      const signed = await getClient().sign(new Request(url, { method: 'GET' }), {
        aws: { region: 'auto', service: 's3' }
      })
      res = await fetch(signed)
    } catch (e) {
      lastErr = new Error(`R2 network error (${bucket}): ${e.message}`)
      await sleep(300 * 2 ** attempt)
      continue
    }
    if (res.ok) {
      const xml = await res.text()
      return parseListXml(xml)
    }
    if (res.status >= 500 && attempt < retries) {
      lastErr = new Error(`R2 HTTP ${res.status} while listing ${bucket}`)
      await sleep(300 * 2 ** attempt)
      continue
    }
    const body = await res.text().catch(() => '')
    const msg = extractXmlMessage(body)
    const hint =
      res.status === 404 ? 'bucket does not exist (check the bucket name)' :
      res.status === 401 || res.status === 403 ? 'access denied (check your R2 API token permissions)' :
      msg || 'unknown R2 error'
    throw new Error(`R2 list failed for "${bucket}" (HTTP ${res.status}): ${hint}`)
  }
  throw lastErr ?? new Error('R2 list failed')
}

function parseListXml (xml) {
  const objects = []
  const re = /<Contents>([\s\S]*?)<\/Contents>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const key = pickTag(block, 'Key')
    if (key === null || key === '' || key.endsWith('/')) continue // skip dir markers
    objects.push({
      key,
      size: parseInt(pickTag(block, 'Size') ?? '0', 10) || 0,
      lastModified: Date.parse(pickTag(block, 'LastModified') ?? '') || null
    })
  }
  const truncated = (pickTag(xml, 'IsTruncated') ?? 'false') === 'true'
  const nextToken = truncated ? pickTag(xml, 'NextContinuationToken') : null
  return { objects, nextToken }
}

function pickTag (xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? decodeXmlEntities(m[1]) : null
}

/** Quick bucket validation used by the admin panel. */
export async function testBucket (bucket) {
  try {
    const { objects } = await listObjects(bucket, { maxKeys: 5 })
    return { ok: true, sample: objects.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------------------------------------------------------------------------
// Manual SigV4 presigned GET (only used when DL_MODE=presign fallback).
// ---------------------------------------------------------------------------
const enc = (s) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const sha256hexRaw = (s) => crypto.createHash('sha256').update(s).digest('hex')
const hmacRaw = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()

export function presignGet (bucket, key, expiresSeconds) {
  const host = `${config.r2.accountId}.r2.cloudflarestorage.com`
  const canonicalUri = '/' + [bucket, ...String(key).split('/')].map(enc).join('/')

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/auto/s3/aws4_request`

  const q = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.r2.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ].map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')

  const canonicalRequest =
    `GET\n${canonicalUri}\n${q}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`

  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hexRaw(canonicalRequest)}`

  let signingKey = hmacRaw(`AWS4${config.r2.secretAccessKey}`, dateStamp)
  signingKey = hmacRaw(signingKey, 'auto')
  signingKey = hmacRaw(signingKey, 's3')
  signingKey = hmacRaw(signingKey, 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return `https://${host}${canonicalUri}?${q}&X-Amz-Signature=${signature}`
}

export const r2Endpoint = config.r2.endpoint
