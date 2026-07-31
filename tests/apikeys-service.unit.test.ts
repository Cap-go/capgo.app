import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/supabase.types'
import { describe, expect, it, vi } from 'vitest'
import { createAiApiKey } from '../src/services/apikeys'

interface ApiKeyInvokePayload {
  body: {
    bindings: Array<{
      role_name: string
      scope_type: 'org' | 'app'
      org_id: string
      app_id?: string
    }>
    global_permissions?: string[]
  }
}

function createSupabaseMock() {
  const invoke = vi.fn().mockResolvedValue({ data: {}, error: null })
  const supabase = {
    functions: { invoke },
  } as unknown as SupabaseClient<Database>

  return { invoke, supabase }
}

describe('createAiApiKey', () => {
  it.concurrent('creates a member key with only the selected app bindings', async () => {
    const { invoke, supabase } = createSupabaseMock()

    await createAiApiKey(supabase, 'Preview key', {
      orgIds: ['org-a', 'org-b'],
      role: 'member',
      apps: [
        { uuid: 'app-a', orgId: 'org-a', role: 'app_preview' },
        { uuid: 'app-b', orgId: 'org-b', role: 'app_reader' },
      ],
    })

    const payload = invoke.mock.calls[0]?.[1] as ApiKeyInvokePayload
    expect(payload.body.bindings).toEqual([
      { role_name: 'app_preview', scope_type: 'app', org_id: 'org-a', app_id: 'app-a' },
      { role_name: 'app_reader', scope_type: 'app', org_id: 'org-b', app_id: 'app-b' },
    ])
    expect(payload.body.bindings.some(binding => binding.role_name === 'org_member')).toBe(false)
    expect(payload.body.global_permissions).toBeUndefined()
  })

  it.concurrent('requires a member key to select at least one app', async () => {
    const { supabase } = createSupabaseMock()

    await expect(createAiApiKey(supabase, 'Empty member key', {
      orgIds: ['org-a'],
      role: 'member',
      apps: [],
    })).rejects.toThrow('Select at least one app for a member API key')
  })
})
