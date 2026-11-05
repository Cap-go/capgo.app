import type { Context } from 'hono'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'

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
  let app: AppWithOrg | undefined
  const pg = await getPgClient(c)
  try {
    const result = await pg.query<AppWithOrg>(
      `SELECT a.owner_org, json_build_object('enforce_encrypted_bundles', o.enforce_encrypted_bundles, 'required_encryption_key', o.required_encryption_key) AS orgs
      FROM public.apps a
      JOIN public.orgs o ON o.id = a.owner_org
      WHERE a.app_id = $1`,
      [appId],
    )
    if (result.rows.length === 1)
      app = result.rows[0]
  }
  catch (appError) {
    throw simpleError('cannot_find_app', 'Cannot find app', { supabaseError: appError })
  }
  finally {
    closeClient(c, pg)
  }

  if (!app) {
    throw simpleError('cannot_find_app', 'Cannot find app', { supabaseError: null })
  }

  return app
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
