import { FunctionsHttpError } from '@supabase/supabase-js'
import { useSupabase } from '~/services/supabase'

export type DedicatedBuilderStatus = 'requested' | 'provisioning' | 'active' | 'suspended' | 'cancelled'
export type DedicatedWorkerStatus = 'unknown' | 'idle' | 'busy' | 'offline'

export interface DedicatedBuilder {
  id: string
  org_id: string
  status: DedicatedBuilderStatus
  requested_by: string | null
  use_case: string | null
  monthly_builds_estimate: number | null
  platforms: string[]
  allow_shared_fallback: boolean
  pool_id: string | null
  worker_name: string | null
  worker_status: DedicatedWorkerStatus
  worker_current_job_id: string | null
  worker_last_seen_at: string | null
  activated_at: string | null
  suspended_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  active_dedicated_builds: number
}

interface DedicatedBuilderResponse {
  dedicated_builder: DedicatedBuilder | null
  status?: string
}

export class DedicatedBuilderApiError extends Error {
  code: string
  status: number

  constructor(code: string, status: number, message?: string) {
    super(message || code)
    this.name = 'DedicatedBuilderApiError'
    this.code = code
    this.status = status
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = useSupabase()
  const { data: currentSession } = await supabase.auth.getSession()
  if (!currentSession.session)
    throw new Error('Not authenticated')

  return {
    'Content-Type': 'application/json',
    'authorization': `Bearer ${currentSession.session.access_token}`,
  }
}

async function normalizeInvokeError(error: unknown): Promise<never> {
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    let code = 'request_failed'
    try {
      const payload = await error.context.clone().json() as { error?: string, status?: string }
      code = payload.error || payload.status || code
    }
    catch {
      // keep default code
    }
    throw new DedicatedBuilderApiError(code, error.context.status, code)
  }
  throw error
}

export async function fetchDedicatedBuilder(orgId: string): Promise<DedicatedBuilder | null> {
  const supabase = useSupabase()
  const { data, error } = await supabase.functions.invoke<DedicatedBuilderResponse>(
    `private/dedicated_builder/${orgId}`,
    { method: 'GET' },
  )
  if (error)
    await normalizeInvokeError(error)
  return data?.dedicated_builder ?? null
}

export async function requestDedicatedBuilder(input: {
  orgId: string
  useCase?: string
  monthlyBuildsEstimate?: number | null
  platforms?: string[]
}): Promise<DedicatedBuilder> {
  const supabase = useSupabase()
  const { data, error } = await supabase.functions.invoke<DedicatedBuilderResponse>(
    'private/dedicated_builder',
    {
      method: 'POST',
      body: {
        org_id: input.orgId,
        use_case: input.useCase || undefined,
        monthly_builds_estimate: input.monthlyBuildsEstimate ?? undefined,
        platforms: input.platforms,
      },
    },
  )
  if (error)
    await normalizeInvokeError(error)
  if (!data?.dedicated_builder)
    throw new Error('Missing dedicated builder in response')
  return data.dedicated_builder
}

export async function updateDedicatedBuilder(
  orgId: string,
  body: { allow_shared_fallback?: boolean, cancel?: boolean },
): Promise<DedicatedBuilder> {
  // Keep auth headers explicit for PATCH through functions.invoke compatibility.
  const headers = await getAuthHeaders()
  const supabase = useSupabase()
  const { data, error } = await supabase.functions.invoke<DedicatedBuilderResponse>(
    `private/dedicated_builder/${orgId}`,
    {
      method: 'PATCH',
      headers,
      body,
    },
  )
  if (error)
    await normalizeInvokeError(error)
  if (!data?.dedicated_builder)
    throw new Error('Missing dedicated builder in response')
  return data.dedicated_builder
}
