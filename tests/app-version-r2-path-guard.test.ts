import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_APP_UPLOADER, getSupabaseClient, ORG_ID, USER_ID } from './test-utils'

const APP_ID = 'com.demo.app'
const VICTIM_VERSION_NAME = '1.0.0'
const VICTIM_R2_PATH = `orgs/${ORG_ID}/apps/${APP_ID}/${VICTIM_VERSION_NAME}.zip`

function createApiKeyClient(apikey: string) {
  const supabaseUrl = process.env.SUPABASE_URL as string
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY as string

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        capgkey: apikey,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

describe('app_versions r2_path guard', () => {
  it.concurrent('rejects foreign r2_path retarget from upload-capable API keys', async () => {
    const adminClient = getSupabaseClient()
    const uploaderClient = createApiKeyClient(APIKEY_TEST_APP_UPLOADER)
    const versionName = `r2-path-guard-${randomUUID()}`

    const { data: version, error: insertError } = await adminClient
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: versionName,
        owner_org: ORG_ID,
        user_id: USER_ID,
        deleted: false,
        storage_provider: 'r2-direct',
      })
      .select('id')
      .single()

    expect(insertError).toBeNull()
    expect(version?.id).toBeTypeOf('number')

    try {
      const { error: foreignPathError } = await uploaderClient
        .from('app_versions')
        .update({ r2_path: VICTIM_R2_PATH })
        .eq('id', version!.id)

      expect(foreignPathError).not.toBeNull()
      expect(foreignPathError?.message).toContain('invalid_r2_path')

      const canonicalPath = `orgs/${ORG_ID}/apps/${APP_ID}/${versionName}.zip`
      const { data: canonicalUpdate, error: canonicalError } = await uploaderClient
        .from('app_versions')
        .update({ r2_path: canonicalPath })
        .eq('id', version!.id)
        .select('r2_path')

      expect(canonicalError).toBeNull()
      expect(canonicalUpdate).toEqual([{ r2_path: canonicalPath }])

      const { data: victim, error: victimError } = await adminClient
        .from('app_versions')
        .select('r2_path')
        .eq('app_id', APP_ID)
        .eq('name', VICTIM_VERSION_NAME)
        .single()

      expect(victimError).toBeNull()
      expect(victim?.r2_path).toBe(VICTIM_R2_PATH)
    }
    finally {
      await adminClient.from('app_versions').delete().eq('id', version!.id)
    }
  })
})
