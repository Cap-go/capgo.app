import type { Context } from 'hono'
import { simpleError } from '../../utils/hono.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'

// Organization encryption policy shared by bundle create and upsert.

export interface AppWithOrg {
  owner_org: string
  orgs: {
    enforce_encrypted_bundles: boolean
    required_encryption_key: string | null
  }
}

export async function getAppOrganization(c: Context, appId: string): Promise<AppWithOrg> {
  // Admin read: org security settings are needed for enforcement regardless of caller RLS.
  const { data: app, error: appError } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org, orgs!inner(enforce_encrypted_bundles, required_encryption_key)')
    .eq('app_id', appId)
    .single()

  if (appError || !app) {
    throw simpleError('cannot_find_app', 'Cannot find app', { supabaseError: appError })
  }

  return app as unknown as AppWithOrg
}

export function checkEncryptedBundleEnforcement(
  appWithOrg: AppWithOrg,
  sessionKey: string | null | undefined,
  keyId: string | null | undefined,
): void {
  if (!appWithOrg.orgs.enforce_encrypted_bundles) {
    return
  }

  if (!sessionKey || sessionKey === '') {
    throw simpleError('encryption_required', 'This organization requires all bundles to be encrypted. Please upload an encrypted bundle with a session_key.', {
      enforce_encrypted_bundles: true,
    })
  }

  const requiredKey = appWithOrg.orgs.required_encryption_key
  if (requiredKey && requiredKey !== '') {
    if (!keyId || keyId === '') {
      throw simpleError('encryption_key_required', 'This organization requires bundles to be encrypted with a specific key. The uploaded bundle does not have a key_id.', {
        enforce_encrypted_bundles: true,
        required_encryption_key: true,
      })
    }

    const matches = keyId === requiredKey.substring(0, 20) || keyId.startsWith(requiredKey)
    if (!matches) {
      throw simpleError('encryption_key_mismatch', 'This organization requires bundles to be encrypted with a specific key. The uploaded bundle was encrypted with a different key.', {
        enforce_encrypted_bundles: true,
        required_encryption_key: true,
        expected_key_prefix: `${requiredKey.substring(0, 4)}...`,
      })
    }
  }
}
