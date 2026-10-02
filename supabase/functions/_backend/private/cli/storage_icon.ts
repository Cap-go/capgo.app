import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { assertAllowedImagePath } from '../../utils/storage.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'

const MAX_ICON_BYTES = 5 * 1024 * 1024

const uploadIconBodySchema = z.object({
  app_id: z.string().min(1),
  org_id: z.uuid(),
  content_base64: z.string().min(1),
  content_type: z.string().min(1),
  upsert: z.boolean().optional(),
})

export async function uploadCliAppIcon(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  const bodyRaw = await parseBody<unknown>(c)
  const bodyParsed = safeParseSchema(uploadIconBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }

  const body = bodyParsed.data
  if (!isValidAppId(body.app_id)) {
    throw quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }

  const iconPath = `org/${body.org_id}/${body.app_id}/icon`
  const normalizedPath = assertAllowedImagePath(iconPath, { orgId: body.org_id, appId: body.app_id })
  if (!normalizedPath) {
    throw quickError(400, 'invalid_icon_path', 'Icon path must belong to this app organization', {
      app_id: body.app_id,
      org_id: body.org_id,
    })
  }

  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(body.content_base64), char => char.charCodeAt(0))
  }
  catch {
    throw quickError(400, 'invalid_icon_payload', 'Icon payload must be valid base64')
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) {
    throw quickError(400, 'invalid_icon_size', 'Icon payload size is invalid', {
      max_bytes: MAX_ICON_BYTES,
      size_bytes: bytes.byteLength,
    })
  }

  const supabase = supabaseApikey(c, apikey.key)
  const { data: existingApp } = await supabase
    .from('apps')
    .select('app_id')
    .eq('app_id', body.app_id)
    .maybeSingle()

  const allowed = existingApp
    ? await checkPermission(c, 'app.update_settings', { appId: body.app_id })
    : await checkPermission(c, 'org.create_app', { orgId: body.org_id })

  if (!allowed) {
    throw quickError(403, 'cannot_upload_icon', 'You cannot upload an icon for this app', {
      app_id: body.app_id,
      org_id: body.org_id,
    })
  }

  const { error: uploadError } = await supabaseAdmin(c)
    .storage
    .from('images')
    .upload(normalizedPath, bytes, {
      contentType: body.content_type,
      upsert: body.upsert === true,
    })

  if (uploadError) {
    const statusCode = typeof uploadError === 'object' && uploadError && 'statusCode' in uploadError
      ? String((uploadError as { statusCode?: unknown }).statusCode)
      : ''
    if (!body.upsert && statusCode === '409')
      return c.json({ path: normalizedPath, conflict: true }, 409)
    throw simpleError('cannot_upload_icon', 'Cannot upload app icon', { error: uploadError })
  }

  return c.json({ path: normalizedPath })
}
