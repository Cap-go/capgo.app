import type { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'

interface PresignOptions {
  method: string
  hostname: string
  path: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  expirySeconds?: number
  protocol?: string
}

function hmac(key: string | Buffer, string: string): string {
  return createHmac('sha256', key).update(string, 'utf8').digest('hex')
}

function encodeUri(str: string, allowSlashes = false): string {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, allowSlashes ? '/' : '%2F')
}

export function presignUrl(options: PresignOptions): string {
  const {
    method,
    hostname,
    path,
    region,
    accessKeyId,
    secretAccessKey,
    expirySeconds = 900,
    protocol = 'https:',
  } = options

  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = datetime.substring(0, 8)
  const [resource, existingQuery] = path.split('?')

  const query = new URLSearchParams(existingQuery)
  query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  query.set('X-Amz-Credential', `${accessKeyId}/${date}/${region}/s3/aws4_request`)
  query.set('X-Amz-Date', datetime)
  query.set('X-Amz-Expires', expirySeconds.toString())
  query.set('X-Amz-SignedHeaders', 'host')

  const canonicalUri = encodeUri(resource, true)
  const canonicalQuery = query.toString().replace(/\+/g, '%20')

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${hostname}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    `${date}/${region}/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')

  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign)

  query.set('X-Amz-Signature', signature)

  return `${protocol}//${hostname}${canonicalUri}?${query.toString().replace(/\+/g, '%20')}`
}
