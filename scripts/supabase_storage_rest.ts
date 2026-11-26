// Plain-fetch client for the few Supabase Storage REST calls admin scripts make
// (list, download, remove). Sends the same apikey/Authorization headers as
// supabase-js, so it behaves the same against the cloud gateway and a local stack.

export interface StorageListEntry {
  name: string
  id: string | null
  updated_at?: string
  created_at?: string
}

export interface SupabaseStorageRest {
  list: (bucket: string, prefix: string, options: { limit: number, offset: number }) => Promise<StorageListEntry[]>
  download: (bucket: string, path: string) => Promise<Blob>
  remove: (bucket: string, paths: string[]) => Promise<void>
}

function encodeObjectPath(path: string) {
  return path.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')
}

async function failure(response: Response, action: string) {
  const body = await response.text().catch(() => '')
  let message = body
  try {
    const parsed = JSON.parse(body) as { message?: string, error?: string }
    message = parsed.message || parsed.error || body
  }
  catch {}
  return new Error(`Storage ${action} failed (${response.status}): ${message || response.statusText}`)
}

export function createSupabaseStorageRest(supabaseUrl: string, key: string): SupabaseStorageRest {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1`
  const headers = { apikey: key, Authorization: `Bearer ${key}` }

  return {
    async list(bucket, prefix, { limit, offset }) {
      const response = await fetch(`${base}/object/list/${encodeURIComponent(bucket)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
      })
      if (!response.ok)
        throw await failure(response, `list of "${prefix}"`)
      return await response.json() as StorageListEntry[]
    },
    async download(bucket, path) {
      const response = await fetch(`${base}/object/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`, { headers })
      if (!response.ok)
        throw await failure(response, `download of "${path}"`)
      return await response.blob()
    },
    async remove(bucket, paths) {
      const response = await fetch(`${base}/object/${encodeURIComponent(bucket)}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      })
      if (!response.ok)
        throw await failure(response, 'remove')
    },
  }
}
