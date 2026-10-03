import type { Database } from '../types/supabase.types'
import type { CapgoClient } from '../utils'
import { formatCapgoCliInvokeError, invokeCliHttpFromClient } from '../utils'

// Data reads/writes the CLI used to run directly against the database. They go
// through `private/cli/*` with the caller API key so server-side access rules
// (preview keys, channel-scoped keys) stay identical.

async function toCliDataError(error: Error): Promise<Error> {
  return new Error(await formatCapgoCliInvokeError(error), { cause: error })
}

export interface CliLinkedVersion {
  id: number
  name: string
  deleted: boolean
}

export type CliChannelRow = Database['public']['Tables']['channels']['Row'] & {
  version_info: CliLinkedVersion | null
  rollout_version_info: CliLinkedVersion | null
}

export async function fetchCliChannels(
  client: CapgoClient,
  appId: string,
  name?: string,
  filters: { linkedVersionId?: number } = {},
): Promise<CliChannelRow[]> {
  const { data, error } = await invokeCliHttpFromClient<CliChannelRow[]>(client, 'private/cli/channels', {
    query: {
      app_id: appId,
      name,
      linked_version_id: filters.linkedVersionId ? String(filters.linkedVersionId) : undefined,
    },
  })
  if (error)
    throw await toCliDataError(error)
  return Array.isArray(data) ? data : []
}

export async function fetchLatestBundle(client: CapgoClient, appId: string): Promise<{ id: number, name: string } | null> {
  const { data, error } = await invokeCliHttpFromClient<{ id: number, name: string } | null>(client, 'private/cli/bundles/latest', {
    query: { app_id: appId },
  })
  if (error)
    throw await toCliDataError(error)
  return data?.id && data.name ? { id: data.id, name: data.name } : null
}

export async function setBundlesDeleted(client: CapgoClient, appId: string, names: string[], deleted: boolean): Promise<string[]> {
  const { data, error } = await invokeCliHttpFromClient<{ updated?: string[] }>(client, 'private/cli/bundles/deleted', {
    method: 'POST',
    body: { app_id: appId, names, deleted },
  })
  if (error)
    throw await toCliDataError(error)
  return data?.updated ?? []
}

export async function fetchBundleManifest(client: CapgoClient, appVersionId: number): Promise<{ file_name: string | null, file_hash: string | null }[]> {
  const { data, error } = await invokeCliHttpFromClient<{ file_name: string | null, file_hash: string | null }[]>(client, 'private/cli/manifest', {
    query: { app_version_id: String(appVersionId) },
  })
  if (error)
    throw await toCliDataError(error)
  return Array.isArray(data) ? data : []
}

export async function isAppVisible(client: CapgoClient, appId: string): Promise<boolean> {
  const { data, error } = await invokeCliHttpFromClient<{ visible?: boolean }>(client, 'private/cli/apps/visible', {
    query: { app_id: appId },
  })
  if (error)
    throw await toCliDataError(error)
  return data?.visible === true
}

export async function createOrganization(
  client: CapgoClient,
  name: string,
  managementEmail: string,
): Promise<{ id: string }> {
  // POST /organization accepts API keys and enforces org.create server-side.
  const { data, error } = await invokeCliHttpFromClient<{ id?: string }>(client, 'organization', {
    method: 'POST',
    body: { name, email: managementEmail },
  })
  if (error)
    throw await toCliDataError(error)
  if (!data?.id)
    throw new Error('Organization creation returned no data')
  return { id: data.id }
}
