// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { R2HTTPMetadata } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import { Buffer } from 'node:buffer'
import { HTTPException } from 'hono/http-exception'
import { cloudlog } from '../utils/logging.ts'

export const REQUEST_METHODS = ['POST', 'HEAD', 'PATCH', 'OPTIONS', 'DELETE'] as const

export const HEADERS = [
  'Authorization',
  'Content-Type',
  'Location',
  'Tus-Extension',
  'Tus-Max-Size',
  'Tus-Resumable',
  'Tus-Version',
  'Upload-Concat',
  'Upload-Defer-Length',
  'Upload-Length',
  'Upload-Metadata',
  'Upload-Offset',
  'X-HTTP-Method-Override',
  'X-Requested-With',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'Forwarded',
] as const

export const HEADERS_LOWERCASE = HEADERS.map((header) => {
  return header.toLowerCase()
}) as Array<Lowercase<(typeof HEADERS)[number]>>

export const TUS_VERSION = '1.0.0'
export const TUS_EXTENSIONS = 'creation,creation-defer-length,creation-with-upload,expiration'

// uploads larger than this will be rejected
export const MAX_UPLOAD_LENGTH_BYTES = 1024 * 1024 * 1024 // 1GB
export const MAX_CHUNK_SIZE_BYTES = 1024 * 1024 * 99 // 99MB
export const ALERT_UPLOAD_SIZE_BYTES = 1024 * 1024 * 20 // 20MB

export const X_CHECKSUM_SHA256 = 'X-Checksum-Sha256'
export const X_UPLOAD_HANDLER_RETRYABLE = 'X-Capgo-DO-Retryable'
export const NO_TRANSFORM_CACHE_CONTROL = 'no-transform'

// how long an unfinished upload lives in ms
export const UPLOAD_EXPIRATION_MS = 1 * 24 * 60 * 60 * 1000 // 1 day

// how much we'll buffer in memory, must be greater than or equal to R2's min part size
// https://developers.cloudflare.com/r2/objects/multipart-objects/#limitations
export const BUFFER_SIZE = 1024 * 1024 * 5

// how much of the upload we've written
export const UPLOAD_OFFSET_KEY = 'upload-offset'

// key for StoredUploadInfo
export const UPLOAD_INFO_KEY = 'upload-info'

export const ALLOWED_HEADERS = HEADERS.join(', ')
export const ALLOWED_METHODS = REQUEST_METHODS.join(', ')
export const EXPOSED_HEADERS = HEADERS.join(', ')

export type AppScopedAttachmentPath = | { kind: 'scoped', app_id: string, owner_org: string } | { kind: 'invalid_scoped' }

export function encodeR2KeyForUploadLocation(r2Key: string): string {
  return r2Key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export function getAttachmentReadCandidateKeys(decodedKey: string, rawRouteKey: string | null | undefined): string[] {
  const candidates = [decodedKey]
  if (rawRouteKey && rawRouteKey !== decodedKey) {
    candidates.push(rawRouteKey)

    const encodedRawRouteKey = encodeR2KeyForUploadLocation(rawRouteKey)
    if (encodedRawRouteKey !== rawRouteKey && encodedRawRouteKey !== decodedKey)
      candidates.push(encodedRawRouteKey)
  }

  return [...new Set(candidates)]
}

export function parseAppScopedAttachmentPath(fileId: unknown): AppScopedAttachmentPath | null {
  if (typeof fileId !== 'string') {
    return null
  }

  const [orgs, owner_org, apps, app_id, ...suffix] = fileId.split('/')
  if (orgs !== 'orgs') {
    return null
  }

  if (!owner_org || apps !== 'apps' || !app_id || suffix.length === 0 || suffix.some(part => part.length === 0)) {
    return { kind: 'invalid_scoped' }
  }

  return { kind: 'scoped', app_id, owner_org }
}

function hasSameReadableAppScope(decodedKey: string, rawRouteKey: string): boolean {
  const decodedScope = parseAppScopedAttachmentPath(decodedKey)
  const rawScope = parseAppScopedAttachmentPath(rawRouteKey)

  if (decodedScope?.kind !== 'scoped' || rawScope?.kind !== 'scoped')
    return false

  return decodedScope.owner_org === rawScope.owner_org && decodedScope.app_id === rawScope.app_id
}

export function getSafeAttachmentReadCandidateKeys(decodedKey: string, rawRouteKey: string | null): string[] {
  const candidateKeys = getAttachmentReadCandidateKeys(decodedKey, rawRouteKey)
  if (candidateKeys.length === 1 || !rawRouteKey || hasSameReadableAppScope(decodedKey, rawRouteKey))
    return candidateKeys

  return [decodedKey]
}

export interface AttachmentHeadReader<T> {
  head: (key: string) => Promise<T | null>
}

export async function headFirstExistingAttachmentCandidate<T>(reader: AttachmentHeadReader<T>, candidateKeys: string[]): Promise<T | null> {
  for (const candidateKey of candidateKeys) {
    const objectInfo = await reader.head(candidateKey)
    if (objectInfo != null)
      return objectInfo
  }

  return null
}

export function withNoTransformCacheControl(cacheControl: string | null | undefined): string {
  if (cacheControl == null || cacheControl.trim() === '') {
    return NO_TRANSFORM_CACHE_CONTROL
  }

  const directives = cacheControl
    .split(',')
    .map(directive => directive.trim().toLowerCase())
    .filter(Boolean)

  if (directives.includes(NO_TRANSFORM_CACHE_CONTROL)) {
    return cacheControl
  }

  return `${cacheControl}, ${NO_TRANSFORM_CACHE_CONTROL}`
}

export function buildFileHttpMetadata(contentType?: string, cacheControl?: string | null): R2HTTPMetadata {
  return {
    ...(contentType ? { contentType } : {}),
    cacheControl: withNoTransformCacheControl(cacheControl),
  }
}

export function readIntFromHeader(headers: Headers, name: string): number {
  const headerString = headers.get(name)
  if (headerString == null) {
    return Number.NaN
  }
  return Number.parseInt(headerString)
}

export function toBase64(v: Uint8Array | ArrayBuffer): string {
  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
  }
  else {
    return Buffer.from(v).toString('base64')
  }
}

function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return ''
  }

  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message.toLowerCase() : ''
}

export function isRetryableDurableObjectResetError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const candidate = error as { retryable?: boolean, durableObjectReset?: boolean, overloaded?: boolean }
    if (candidate.retryable || candidate.durableObjectReset || candidate.overloaded) {
      return true
    }
  }

  const message = getErrorMessage(error)
  return [
    'moved to a different machine',
    'storage operation exceeded timeout',
    'caused object to be reset',
    // Cloudflare raises a generic "internal error; reference = <id>" when the
    // Worker call to the upload Durable Object fails at the infrastructure
    // level. It is transient, so retry it instead of failing the upload.
    'internal error; reference',
  ].some(fragment => message.includes(fragment))
}

// Parse binary data from a base64 string
export function fromBase64(s: string): Uint8Array | undefined {
  try {
    return Buffer.from(s, 'base64')
  }
  catch {
    return undefined
  }
}

export class WritableStreamBuffer {
  buf: ArrayBuffer
  offset: number

  constructor(buf: ArrayBuffer) {
    this.buf = buf
    this.offset = 0
  }

  write(chunk: Uint8Array) {
    const remaining = this.buf.byteLength - this.offset
    if (chunk.byteLength > remaining) {
      throw new RangeError('chunk does not fit')
    }
    this.writeUpTo(chunk)
  }

  writeUpTo(chunk: Uint8Array): number {
    const remaining = this.buf.byteLength - this.offset
    const toWrite = Math.min(remaining, chunk.byteLength)
    new Uint8Array(this.buf, this.offset).set(chunk.subarray(0, toWrite))
    this.offset += toWrite
    return toWrite
  }

  view(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.offset)
  }

  reset() {
    this.offset = 0
  }
}

export interface IntermediatePart {
  kind: 'intermediate'
  bytes: Uint8Array
}

export interface FinalPart {
  kind: 'final'
  bytes: Uint8Array
}

export interface ErrorPart {
  kind: 'error'
  error: HTTPException
  bytes: Uint8Array
}

export type Part = IntermediatePart | FinalPart | ErrorPart

// Take an arbitrary length stream and fill an in-memory buffer, emitting a view of the buffer every time the buffer
// is filled. After emitting an item the buffer is reused, so the caller must finish using the buffer before it
// continues iterating.
//
// If an error is encountered reading the stream, the final part generated by the stream will be an error part
// containing whatever was read before the error was encountered.
export async function* generateParts(c: Context, body: ReadableStream<Uint8Array>, mem: WritableStreamBuffer): AsyncGenerator<Part> {
  try {
    for await (const chunk of body as any) {
      let chunkOffset = 0
      while (chunkOffset < chunk.byteLength) {
        const copied = mem.writeUpTo(chunk.subarray(chunkOffset))
        chunkOffset += copied

        // When we've filled mem, we want to emit a part. But we should only do it if we know
        // there's more body to write. Otherwise, if the upload size is exactly the part size
        // we would end up emitting an empty 'final' part which is unnecessary.
        if (chunk.byteLength > chunkOffset && mem.offset >= mem.buf.byteLength) {
          // the memory buffer's position is at its total length
          yield { kind: 'intermediate', bytes: mem.view() }
          mem.reset()
        }
      }
    }
    yield { kind: 'final', bytes: mem.view() }
  }
  catch (e) {
    const msg = `error reading request body: ${e}`
    cloudlog({ requestId: c.get('requestId'), message: msg })
    yield { kind: 'error', bytes: mem.view(), error: new HTTPException(400, { message: msg }) }
  }
  mem.reset()
}

export type Release = () => void

export class AsyncLock {
  p: Promise<void> | null

  constructor() {
    this.p = null
  }

  // Asynchronously wait for our turn to execute. Returns Release which should be called
  // when the critical section has completed
  async lock(): Promise<Release> {
    // If there is no active promise we can acquire the lock. We loop since
    // someone else may grab the lock before us, in that case we go back
    // to waiting
    while (this.p != null) {
      await this.p
    }
    let resolver: (value: (void | PromiseLike<void>)) => void
    this.p = new Promise((resolve) => {
      resolver = resolve
    })
    return () => {
      this.p = null
      resolver()
    }
  }
}
