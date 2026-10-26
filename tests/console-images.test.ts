import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAuthHeaders, getEndpointUrl, getSupabaseClient, ORG_ID, USER_ID, USER_ID_NONMEMBER } from './test-utils'

// Images live in R2 under `images/`. Locally the S3 endpoint is the Supabase
// Storage `capgo` bucket, which is where these objects must land; nothing may
// be written to the legacy Supabase `images` bucket any more.
const LOCAL_R2_BUCKET = 'capgo'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4])

interface StorageResponse<T> {
  data: T | null
  error: { message: string, statusCode?: string } | null
}

const createdPaths: string[] = []

async function upload(path: string, options: { upsert?: boolean } = {}) {
  const response = await fetch(getEndpointUrl('/private/console/images/upload'), {
    method: 'POST',
    headers: {
      ...await getAuthHeaders(),
      'Content-Type': 'image/png',
      'x-image-path': path,
      'x-image-upsert': String(options.upsert ?? false),
    },
    body: PNG_BYTES,
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<StorageResponse<{ path: string }>>
}

async function sign(path: string) {
  const response = await fetch(getEndpointUrl('/private/console/images/sign'), {
    method: 'POST',
    headers: { ...await getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, expiresIn: 60 }),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<StorageResponse<{ signedUrl: string }>>
}

async function imageToken() {
  const response = await fetch(getEndpointUrl('/private/console/images/token'), {
    method: 'POST',
    headers: await getAuthHeaders(),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as StorageResponse<{ token: string, expiresAt: number }>
  expect(body.error).toBeNull()
  return body.data!.token
}

function readUrl(path: string, token: string) {
  const url = new URL(getEndpointUrl('/private/console/images/read'))
  url.searchParams.set('path', path)
  url.searchParams.set('t', token)
  return url
}

async function remove(paths: string[]) {
  const response = await fetch(getEndpointUrl('/private/console/images/remove'), {
    method: 'POST',
    headers: { ...await getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<StorageResponse<{ name: string }[]>>
}

async function r2Has(path: string) {
  const folder = path.split('/').slice(0, -1).join('/')
  const name = path.split('/').at(-1)
  const { data } = await getSupabaseClient().storage.from(LOCAL_R2_BUCKET).list(`images/${folder}`, { search: name })
  return data?.some(entry => entry.name === name) ?? false
}

afterAll(async () => {
  if (createdPaths.length > 0)
    await getSupabaseClient().storage.from(LOCAL_R2_BUCKET).remove(createdPaths.map(path => `images/${path}`))
})

describe('console image endpoints (R2)', () => {
  it('uploads, signs, reads and removes an avatar through R2', async () => {
    const path = `${USER_ID}/r2-avatar-${randomUUID()}.png`
    createdPaths.push(path)

    const uploaded = await upload(path)
    expect(uploaded.error).toBeNull()
    expect(uploaded.data?.path).toBe(path)
    expect(await r2Has(path)).toBe(true)
    const { data: legacy } = await getSupabaseClient().storage.from('images').list(USER_ID, { search: path.split('/').at(-1) })
    expect(legacy ?? []).toHaveLength(0)

    const conflict = await upload(path)
    expect(conflict.error?.statusCode).toBe('409')

    // One token reads every image the user may see; the URL is built locally.
    const token = await imageToken()
    const read = await fetch(readUrl(path, token))
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe('image/png')
    expect(read.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG_BYTES)

    const etag = read.headers.get('etag')
    expect(etag).toBeTruthy()
    const revalidated = await fetch(readUrl(path, token), { headers: { 'if-none-match': etag! } })
    expect(revalidated.status).toBe(304)

    expect((await fetch(readUrl(path, `${token}x`))).status).toBe(401)
    // The token is the user's, not the path's: another user's private folder stays closed.
    expect((await fetch(readUrl(`${USER_ID_NONMEMBER}/avatar.png`, token))).status).toBe(404)

    // The legacy sign endpoint now returns the same kind of relay URL.
    const signed = await sign(path)
    expect(signed.error).toBeNull()
    const signedUrl = new URL(signed.data!.signedUrl)
    expect(signedUrl.pathname).toMatch(/\/images\/read$/)
    expect(signedUrl.searchParams.get('t')).toBeTruthy()

    const removed = await remove([path])
    expect(removed.error).toBeNull()
    expect(removed.data).toEqual([{ name: path }])
    expect(await r2Has(path)).toBe(false)

    const missing = await sign(path)
    expect(missing.error?.statusCode).toBe('404')
  })

  it('uploads an org logo for an org the caller administers', async () => {
    const path = `org/${ORG_ID}/logo/r2-logo-${randomUUID()}.png`
    createdPaths.push(path)

    const uploaded = await upload(path, { upsert: true })
    expect(uploaded.error).toBeNull()
    expect(await r2Has(path)).toBe(true)
  })

  it('refuses to write or delete another user folder', async () => {
    const path = `${USER_ID_NONMEMBER}/r2-forbidden-${randomUUID()}.png`

    const uploaded = await upload(path, { upsert: true })
    expect(uploaded.error?.statusCode).toBe('403')
    expect(await r2Has(path)).toBe(false)

    const removed = await remove([path])
    expect(removed.data).toEqual([])
  })
})
