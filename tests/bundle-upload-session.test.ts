import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { brotliDecompressSync, crc32 } from 'node:zlib'
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
  const { data } = await getSupabaseClient().from('app_versions').select('id, storage_provider, checksum, deleted, native_packages, min_update_version, cli_version, owner_org, r2_path').eq('app_id', APPNAME).eq('name', name).maybeSingle()
  return data
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Hash of the live bundle object, read straight from storage. */
async function liveBundleHash(name: string) {
  const row = await versionRow(name)
  const { data, error } = await getSupabaseClient().storage.from('capgo').download(`orgs/${row!.owner_org}/apps/${APPNAME}/${name}.zip`)
  expect(error).toBeNull()
  return sha256(new Uint8Array(await data!.arrayBuffer()))
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

    // A range would silently pick CRC32 for a SHA-256 updater: only the installed version is accepted.
    const rangeUpdater = await prepare('6.0.0', { updater_version: '^7.40.0' })
    expect(rangeUpdater.data.error).toBe('invalid_updater_version')
    expect(await versionRow('6.0.0')).toBeNull()

    const unknownField = await prepare('6.0.0', { unexpected: true })
    expect(unknownField.data.error).toBe('invalid_body')

    const blocked = await prepare('6.0.0', { native_packages: [{ name: '@capacitor/camera', version: '6.0.0' }], fail_on_incompatible: true })
    expect(blocked.status).toBe(400)
    expect(blocked.data.error).toBe('incompatible_bundle')
    expect(await versionRow('6.0.0')).toBeNull()
  })

  it('keeps the packer checksum algorithm (--force-crc32-checksum)', async () => {
    const forcedSha = await prepare('14.0.0', { channel: 'upload-session-crc', updater_version: '5.0.0', checksum_algorithm: 'sha256' })
    expect(forcedSha.data.error).toBe('invalid_options')
    expect(await versionRow('14.0.0')).toBeNull()

    const zip = bundleZip('notifyAppReady(); // 14')
    const checksum = crc32(zip).toString(16).padStart(8, '0')
    const prepared = await prepare('14.0.0', { channel: 'upload-session-crc', checksum_algorithm: 'crc32', checksum })
    expect(prepared.status).toBe(200)
    expect(prepared.data.checksum_algorithm).toBe('crc32')
    await putZip(prepared.data.bundle_upload.url, zip)
    const completed = await api('complete', { upload_token: prepared.data.upload_token })
    expect(completed.status).toBe(200)
    expect(completed.data.checksum).toBe(checksum)
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

  it('lets only one complete win and keeps the live bundle immutable', async () => {
    const zip = bundleZip('notifyAppReady(); // 12')
    const prepared = await prepare('12.0.0', { channel: 'upload-session-race' })
    expect(prepared.status).toBe(200)
    // Clients only ever get a signed URL for a staging key, never for the bundle path.
    expect(prepared.data.bundle_upload.url).toContain('/upload-sessions-expire-after-1-day/')
    expect(prepared.data.bundle_upload.url).not.toContain('12.0.0.zip')
    await putZip(prepared.data.bundle_upload.url, zip)

    const token = { upload_token: prepared.data.upload_token }
    const [first, second] = await Promise.all([api('complete', token), api('complete', token)])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const loser = first.status === 409 ? first : second
    expect(['upload_in_progress', 'upload_already_completed']).toContain(loser.data.error)
    expect(await versionRow('12.0.0')).toMatchObject({ storage_provider: 'r2', deleted: false, checksum: sha256(zip) })
    expect(await liveBundleHash('12.0.0')).toBe(sha256(zip))

    const again = await api('complete', token)
    expect(again.status).toBe(409)
    expect(again.data.error).toBe('upload_already_completed')
    const aborted = await api('abort', token)
    expect(aborted.status).toBe(409)
    expect(aborted.data.error).toBe('upload_already_completed')
    expect(await versionRow('12.0.0')).toMatchObject({ storage_provider: 'r2', deleted: false })

    // Replaying the old signed URL only rewrites the (now unused) staging key.
    await putZip(prepared.data.bundle_upload.url, bundleZip('evil(); notifyAppReady()'))
    expect(await liveBundleHash('12.0.0')).toBe(sha256(zip))
    expect((await api('complete', token)).data.error).toBe('upload_already_completed')
  })

  it('refuses a concurrent prepare of the same version instead of overwriting it', async () => {
    const results = await Promise.all([prepare('13.0.0', { channel: 'upload-session-race' }), prepare('13.0.0', { channel: 'upload-session-race' })])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    const winner = results.find(result => result.status === 200)!
    expect(results.find(result => result.status === 409)!.data.error).toBe('version_already_exists')
    expect((await versionRow('13.0.0'))?.id).toBe(winner.data.version_id)
    expect((await api('abort', { upload_token: winner.data.upload_token })).status).toBe(200)
  })

  it('re-checks compatibility when the channel changed between prepare and complete', async () => {
    const camera = { name: '@capacitor/camera', version: '6.0.0' }
    const channel = 'upload-session-recheck'
    async function upload(version: string, nativePackages: unknown[], overrides: Record<string, unknown> = {}) {
      const prepared = await prepare(version, { channel, native_packages: nativePackages, ...overrides })
      expect(prepared.status).toBe(200)
      await putZip(prepared.data.bundle_upload.url, bundleZip(`notifyAppReady(); // ${version}`))
      return prepared
    }

    const base = await upload('11.0.0', [camera])
    expect((await api('complete', { upload_token: base.data.upload_token })).status).toBe(200)

    // Compatible with 11.0.0 at prepare time.
    const pending = await upload('11.0.1', [camera], { fail_on_incompatible: true })
    expect(pending.data.channels).toEqual([expect.objectContaining({ name: channel, compatibility: 'compatible', current_version: '11.0.0' })])

    // Meanwhile the channel moves to a bundle built against another native plugin version.
    const moved = await upload('11.0.2', [{ ...camera, version: '7.0.0' }])
    expect((await api('complete', { upload_token: moved.data.upload_token })).status).toBe(200)

    const completed = await api('complete', { upload_token: pending.data.upload_token })
    expect(completed.status).toBe(400)
    expect(completed.data.error).toBe('incompatible_bundle')
    expect(await versionRow('11.0.1')).toBeNull()
    const { data: channelRow } = await getSupabaseClient().from('channels').select('version').eq('app_id', APPNAME).eq('name', channel).single()
    expect(channelRow?.version).toBe((await versionRow('11.0.2'))?.id)
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
