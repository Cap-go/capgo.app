import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  executeSQL,
  fetchTestRequest,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  resetAndSeedAppData,
  resetAppData,
  USER_ID,
} from './test-utils.ts'

const id = randomUUID()
const APP_ID = `com.delta.concurrent.${id}`
const PREFIX = `orgs/${ORG_ID}/apps/${APP_ID}/delta`

interface Entry { file_name: string, s3_path: string, file_hash: string }

function entry(name: string, hash: string): Entry {
  return { file_name: name, s3_path: `${PREFIX}/${hash}_${name}`, file_hash: hash }
}

async function createUploadVersion(name: string) {
  const { data, error } = await getSupabaseClient()
    .from('app_versions')
    .insert({
      app_id: APP_ID,
      name,
      checksum: randomUUID().replaceAll('-', ''),
      owner_org: ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      deleted: false,
    })
    .select('id')
    .single()
  if (error || !data)
    throw new Error(`Failed to create version: ${error?.message}`)
  return data.id
}

async function setManifest(name: string, manifest: Entry[]) {
  const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
    method: 'POST',
    retryUnsafe: true,
    headers: { 'Content-Type': 'application/json', 'Authorization': APIKEY_TEST_ALL },
    body: JSON.stringify({ app_id: APP_ID, name, manifest }),
  })
  return { status: response.status, json: await response.json() as { inserted?: number, alreadyPresent?: boolean } }
}

async function versionPaths(versionId: number) {
  const rows = await executeSQL<{ s3_path: string }>(
    `SELECT df.s3_path FROM public.version_files vf
     CROSS JOIN LATERAL unnest(vf.file_ids) WITH ORDINALITY AS e(file_id, ord)
     INNER JOIN public.delta_files df ON df.id = e.file_id
     WHERE vf.app_version_id = $1 ORDER BY e.ord`,
    [versionId],
  )
  return rows.map(row => row.s3_path)
}

describe('delta storage with concurrent uploads sharing files', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
  })

  it('stores each shared file once and every version keeps its own ordered list', async () => {
    const shared = [entry('index.html', 'a1'), entry('vendor.js', 'b2')]
    // Versions sharing files, one with a changed main.js, two identical ones.
    const manifests: Record<string, Entry[]> = {
      v1: [...shared, entry('main.js', 'c1')],
      v2: [...shared, entry('main.js', 'c2')],
      v3: [entry('main.js', 'c2'), ...shared],
      v4: [...shared, entry('main.js', 'c1'), entry('extra.css', 'd1')],
      v5: [...shared, entry('main.js', 'c1')],
      v6: [...shared, entry('main.js', 'c1')],
    }
    const names = Object.keys(manifests).map(key => `${key}-${id.slice(0, 8)}`)
    const ids = await Promise.all(names.map(name => createUploadVersion(name)))
    const [before] = await executeSQL<{ count: number }>('SELECT manifest_bundle_count::int AS count FROM public.apps WHERE app_id = $1', [APP_ID])

    // Every upload at once, plus a concurrent retry of the first version.
    const lists = Object.values(manifests)
    const results = await Promise.all([
      ...names.map((name, index) => setManifest(name, lists[index])),
      setManifest(names[0], lists[0]),
    ])

    expect(results.map(result => result.status)).toEqual(Array.from({ length: results.length }, () => 200))
    // The two requests for the first version: one inserts, the other sees it present.
    const first = [results[0], results[results.length - 1]]
    expect(first.filter(result => result.json.alreadyPresent === true)).toHaveLength(1)
    expect(first.filter(result => result.json.inserted === lists[0].length)).toHaveLength(1)

    // One delta_files row per unique (path, name, hash) for the app.
    const unique = new Set(lists.flat().map(file => `${file.s3_path}|${file.file_hash}`))
    const [files] = await executeSQL<{ count: number }>('SELECT count(*)::int AS count FROM public.delta_files WHERE app_id = $1', [APP_ID])
    expect(files.count).toBe(unique.size)

    for (const [index, versionId] of ids.entries())
      expect(await versionPaths(versionId)).toEqual(lists[index].map(file => file.s3_path))

    const counts = await executeSQL<{ id: number, manifest_count: number }>(
      'SELECT id, manifest_count FROM public.app_versions WHERE id = ANY($1::bigint[])',
      [ids],
    )
    for (const row of counts)
      expect(row.manifest_count).toBe(lists[ids.indexOf(Number(row.id))].length)
    // Each version counted once, even with the concurrent retry.
    const [after] = await executeSQL<{ count: number }>('SELECT manifest_bundle_count::int AS count FROM public.apps WHERE app_id = $1', [APP_ID])
    expect(after.count - before.count).toBe(names.length)

    // A long-deleted version frees only the files nobody else uses.
    await executeSQL(`UPDATE public.app_versions SET deleted = true, deleted_at = now() - interval '8 days' WHERE id = $1`, [ids[3]])
    const [gc] = await executeSQL<{ paths: string[] }>(
      'SELECT public.delta_gc_unreferenced_paths($1::text[]) AS paths',
      [lists[3].map(file => file.s3_path)],
    )
    expect(gc.paths).toEqual([entry('extra.css', 'd1').s3_path])
  })
})
