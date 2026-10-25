import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, getBaseData, getSupabaseClient, headers, postUpdate, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.upload.session.${id}`
const UPDATER_VERSION = '7.40.0'

function bundleZip(js = 'CapacitorUpdater.notifyAppReady()', extra: Record<string, string> = {}) {
  const zip = new AdmZip()
  zip.addFile('index.html', Buffer.from('<html><script src="app.js"></script></html>'))
  zip.addFile('app.js', Buffer.from(js))
  for (const [name, content] of Object.entries(extra))
    zip.addFile(name, Buffer.from(content))
  return zip.toBuffer()
}

async function api(path: string, body: unknown) {
  const response = await fetch(`${BASE_URL}/bundle/upload/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() as any }
}

async function prepare(version: string, overrides: Record<string, unknown> = {}) {
  return api('prepare', {
    app_id: APPNAME,
    version,
    channel: 'production',
    updater_version: UPDATER_VERSION,
    native_packages: [],
    ...overrides,
  })
}

async function putZip(url: string, zip: Buffer) {
  const response = await fetch(url, { method: 'PUT', body: new Uint8Array(zip), headers: { 'Content-Type': 'application/zip' } })
  expect(response.ok).toBe(true)
}

async function versionRow(name: string) {
  const { data } = await getSupabaseClient().from('app_versions').select('id, storage_provider, checksum, deleted, native_packages, min_update_version, cli_version').eq('app_id', APPNAME).eq('name', name).maybeSingle()
  return data
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('bundle upload sessions', () => {
  it('uploads a bundle end to end like `capgo bundle upload`', async () => {
    const zip = bundleZip()
    const prepared = await prepare('2.0.0', { comment: 'from mcp', cli_version: '8.95.0' })
    expect(prepared.status).toBe(200)
    expect(prepared.data.upload_token).toBeTypeOf('string')
    expect(prepared.data.bundle_upload.method).toBe('PUT')
    expect(prepared.data.checksum_algorithm).toBe('sha256')
    expect(prepared.data.channels).toEqual([expect.objectContaining({ name: 'production', compatibility: 'compatible' })])
    expect((await versionRow('2.0.0'))?.storage_provider).toBe('r2-direct')

    const early = await api('complete', { upload_token: prepared.data.upload_token })
    expect(early.status).toBe(409)
    expect(early.data.error).toBe('upload_missing')
    expect((await versionRow('2.0.0'))?.deleted).toBe(false)

    await putZip(prepared.data.bundle_upload.url, zip)
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(200)
    expect(completed.data.checksum).toBe(createHash('sha256').update(zip).digest('hex'))
    expect(completed.data.channels_updated).toEqual(['production'])

    const row = await versionRow('2.0.0')
    expect(row).toMatchObject({ storage_provider: 'r2', checksum: completed.data.checksum, cli_version: '8.95.0' })
    const { data: channel } = await getSupabaseClient().from('channels').select('version').eq('app_id', APPNAME).eq('name', 'production').single()
    expect(channel?.version).toBe(row?.id)

    const again = await api('complete', { upload_token: prepared.data.upload_token })
    expect(again.status).toBe(409)
    expect(again.data.error).toBe('upload_already_completed')

    // Same content again: the channel already serves this checksum.
    const prepareSame = await prepare('2.0.1', { checksum: completed.data.checksum })
    expect(prepareSame.status).toBe(400)
    expect(prepareSame.data.error).toBe('same_checksum')
  })

  it('rejects a checksum mismatch and removes the unfinished version', async () => {
    const prepared = await prepare('3.0.0', { checksum: 'a'.repeat(64), ignore_checksum_check: true })
    expect(prepared.status).toBe(200)
    await putZip(prepared.data.bundle_upload.url, bundleZip('notifyAppReady(); // 3'))
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(400)
    expect(completed.data.error).toBe('checksum_mismatch')
    expect(await versionRow('3.0.0')).toBeNull()
  })

  it('enforces notifyAppReady unless opted out', async () => {
    const prepared = await prepare('4.0.0')
    await putZip(prepared.data.bundle_upload.url, bundleZip('console.log("no ready call")'))
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(400)
    expect(completed.data.error).toBe('notify_app_ready_missing')
    expect(await versionRow('4.0.0')).toBeNull()

    const optOut = await prepare('4.0.1', { ignore_notify_app_ready: true, channel: 'upload-session-optout' })
    expect(optOut.status).toBe(200)
    await putZip(optOut.data.bundle_upload.url, bundleZip('console.log("no ready call")'))
    const done = await api('complete', { upload_token: optOut.data.upload_token })
    expect(done.status).toBe(200)
    expect(done.data.channels_updated).toEqual(['upload-session-optout'])
  })

  it('aborts an unfinished upload, even after the zip was sent', async () => {
    const prepared = await prepare('5.0.0', { channel: 'upload-session-abort' })
    await putZip(prepared.data.bundle_upload.url, bundleZip('notifyAppReady(); // 5'))
    const aborted = await api('abort', { upload_token: prepared.data.upload_token })
    expect(aborted.status).toBe(200)
    expect(aborted.data.aborted).toBe(true)
    expect(await versionRow('5.0.0')).toBeNull()
  })

  it('applies version, option and compatibility checks at prepare', async () => {
    const exists = await prepare('2.0.0')
    expect(exists.status).toBe(409)
    expect(exists.data.error).toBe('version_already_exists')

    const existsOk = await prepare('2.0.0', { version_exists_ok: true })
    expect(existsOk.status).toBe(200)
    expect(existsOk.data).toMatchObject({ skipped: true, reason: 'VERSION_EXISTS' })

    const conflict = await prepare('6.0.0', { min_update_version: '1.0.0', auto_min_update_version: true })
    expect(conflict.data.error).toBe('invalid_options')

    const noUpdater = await prepare('6.0.0', { updater_version: undefined })
    expect(noUpdater.data.error).toBe('missing_updater_version')

    const unknownField = await prepare('6.0.0', { unexpected: true })
    expect(unknownField.data.error).toBe('invalid_body')

    const blocked = await prepare('6.0.0', { native_packages: [{ name: '@capacitor/camera', version: '6.0.0' }], fail_on_incompatible: true })
    expect(blocked.status).toBe(400)
    expect(blocked.data.error).toBe('incompatible_bundle')
    expect(await versionRow('6.0.0')).toBeNull()
  })

  it('refuses tampered tokens', async () => {
    const prepared = await prepare('7.0.0', { channel: 'upload-session-token' })
    const [prefix, body, signature] = (prepared.data.upload_token as string).split('.')
    const forged = `${prefix}.${body}x.${signature}`
    const completed = await api('complete', { upload_token: forged })
    expect(completed.status).toBe(401)
    expect(completed.data.error).toBe('invalid_upload_token')
    await api('abort', { upload_token: prepared.data.upload_token })
  })

  // Delta is a Workers-only feature, like the files config advertises to the CLI.
  it.skipIf(process.env.USE_CLOUDFLARE_WORKERS !== 'true')('builds the delta manifest from the uploaded zip', async () => {
    const big = 'notifyAppReady(); '.repeat(1000)
    const prepared = await prepare('9.0.0', { delta: true, channel: 'upload-session-delta' })
    expect(prepared.status).toBe(200)
    expect(prepared.data.delta).toBe('server')
    await putZip(prepared.data.bundle_upload.url, bundleZip(big, { 'assets/a.css': 'body{}' }))
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(200)
    expect(completed.data.delta).toMatchObject({ mode: 'server', files: 3 })
    const row = await versionRow('9.0.0')
    const { data: manifest } = await getSupabaseClient().from('manifest').select('file_name, file_hash').eq('app_version_id', row!.id)
    // Like the CLI, files worth compressing are stored as Brotli under a `.br` name.
    expect(manifest?.map(entry => entry.file_name).sort()).toEqual(['app.js.br', 'assets/a.css', 'index.html'])
    const appJs = manifest?.find(entry => entry.file_name === 'app.js.br')
    expect(appJs?.file_hash).toBe(createHash('sha256').update(big).digest('hex'))

    // A device gets the manifest pointing at what the server wrote. Serve it on
    // production for one request, then put production back on its stable bundle.
    const { data: production } = await getSupabaseClient().from('channels').select('id, version').eq('app_id', APPNAME).eq('name', 'production').single()
    await getSupabaseClient().from('channels').update({ version: row!.id }).eq('id', production!.id)
    const update = await postUpdate({ ...getBaseData(APPNAME), device_id: randomUUID(), plugin_version: UPDATER_VERSION, version_name: '9.0.0-0', version_build: '9.0.0' })
    await getSupabaseClient().from('channels').update({ version: production!.version }).eq('id', production!.id)
    expect(update.status).toBe(200)
    const json = await update.json<{ version?: string, manifest?: Array<{ file_name: string, download_url: string }> }>()
    expect(json.version).toBe('9.0.0')
    const served = json.manifest?.find(entry => entry.file_name === 'app.js.br')
    expect(served?.download_url).toContain('/delta/')
    // Locally the plugin worker reads its own R2 emulation, not the S3 gateway the API writes
    // to (in production both are the same bucket), so check the stored bytes in storage directly.
    const storedPath = decodeURIComponent(new URL(served!.download_url).pathname.split('/files/read/attachments/')[1])
    const { data: stored, error } = await getSupabaseClient().storage.from('capgo').download(storedPath)
    expect(error).toBeNull()
    expect(brotliDecompressSync(Buffer.from(await stored!.arrayBuffer())).toString()).toBe(big)
  })

  it.skipIf(process.env.USE_CLOUDFLARE_WORKERS !== 'true')('publishes a delta pack and rejects tampered blobs', async () => {
    const files = { 'index.html': '<html></html>', 'app.js': 'notifyAppReady()' }
    function pack(tamper = false) {
      const zip = new AdmZip()
      const entries = Object.entries(files).map(([fileName, content], index) => {
        const bytes = Buffer.from(content)
        zip.addFile(`files/${index}`, tamper && index === 1 ? Buffer.from('evil') : bytes)
        return {
          id: index,
          file_name: fileName,
          compression: 'none',
          file_hash: createHash('sha256').update(bytes).digest('hex'),
          uploaded_bytes_sha256: createHash('sha256').update(bytes).digest('hex'),
          uploaded_bytes_size: bytes.length,
          pack_path: `files/${index}`,
        }
      })
      zip.addFile('capgo-delta-manifest.json', Buffer.from(JSON.stringify({ protocol_version: 1, file_hash_format: 'sha256_hex', delta_encryption: { enabled: false }, entries })))
      return zip.toBuffer()
    }

    const tampered = await prepare('10.0.0', { delta_pack: true, channel: 'upload-session-pack' })
    expect(tampered.data.delta).toBe('pack')
    await putZip(tampered.data.bundle_upload.url, bundleZip('notifyAppReady(); // 10'))
    await putZip(tampered.data.delta_pack_upload.url, pack(true))
    const rejected = await api('complete', { upload_token: tampered.data.upload_token })
    expect(rejected.status).toBe(400)
    expect(rejected.data.error).toBe('delta_pack_invalid')
    expect(await versionRow('10.0.0')).toBeNull()

    const prepared = await prepare('10.0.0', { delta_pack: true, channel: 'upload-session-pack' })
    await putZip(prepared.data.bundle_upload.url, bundleZip('notifyAppReady(); // 10'))
    await putZip(prepared.data.delta_pack_upload.url, pack())
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(200)
    expect(completed.data.delta).toMatchObject({ mode: 'pack', files: 2 })
  })

  it('sets a progressive rollout on a channel with a stable bundle', async () => {
    const conflict = await prepare('8.0.0', { rollout_percentage: 10, delete_linked_bundle_on_upload: true })
    expect(conflict.data.error).toBe('invalid_options')

    const missingStable = await prepare('8.0.0', { rollout_percentage: 10, channel: 'upload-session-no-stable' })
    expect(missingStable.data.error).toBe('rollout_requires_stable_bundle')

    const prepared = await prepare('8.0.0', { rollout_percentage: 10 })
    expect(prepared.status).toBe(200)
    await putZip(prepared.data.bundle_upload.url, bundleZip('notifyAppReady(); // 8'))
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(200)
    expect(completed.data.channels_updated).toEqual(['production'])
    const { data: channel } = await getSupabaseClient().from('channels').select('version, rollout_version, rollout_percentage_bps, rollout_enabled').eq('app_id', APPNAME).eq('name', 'production').single()
    const stable = await versionRow('2.0.0')
    const rolled = await versionRow('8.0.0')
    expect(channel).toMatchObject({ version: stable?.id, rollout_version: rolled?.id, rollout_percentage_bps: 1000, rollout_enabled: true })
  })
})
