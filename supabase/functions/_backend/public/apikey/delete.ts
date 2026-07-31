import type { Database } from '../../utils/supabase.types.ts'
import { BRES, honoFactory, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { deleteOwnedApiKeyByIdentifier, ensureApiKeyCanManageTargetOrgIds, ensureApiKeyManagementAllowed, getApiKeyBindingOrgIds, isValidApiKeyIdFormat, requireApiKeyManagementAuth, selectOwnedApiKeyByIdentifier } from './scope.ts'

const app = honoFactory.createApp()

app.delete('/:id', middlewareAuth(), async (c) => {
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication')
  const authApikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row'] | undefined

  await ensureApiKeyManagementAllowed(c, auth, authApikey, 'cannot_delete_apikey')

  const id = c.req.param('id')
  if (!id) {
    throw simpleError('api_key_id_required', 'API key ID is required')
  }

  // Validate id format to prevent PostgREST filter injection
  if (!isValidApiKeyIdFormat(id)) {
    throw simpleError('invalid_id_format', 'API key ID must be a valid UUID or number')
  }

  const { data: apikey, error: apikeyError } = await selectOwnedApiKeyByIdentifier(c, auth, id)
  if (!apikey || apikeyError) {
    throw quickError(404, 'api_key_not_found', 'API key not found', { supabaseError: apikeyError })
  }
  if (auth.authType === 'apikey' && authApikey?.id === apikey.id) {
    throw quickError(401, 'cannot_delete_apikey', 'API keys cannot delete themselves', { apikeyId: authApikey.id })
  }
  await ensureApiKeyCanManageTargetOrgIds(c, auth, authApikey, apikey.rbac_id ? await getApiKeyBindingOrgIds(c, apikey.rbac_id) : [], 'cannot_delete_apikey')

  const { error } = await deleteOwnedApiKeyByIdentifier(c, auth, id)

  if (error) {
    throw quickError(500, 'failed_to_delete_apikey', 'Failed to delete API key', { supabaseError: error })
  }

  return c.json(BRES)
})

export default app
