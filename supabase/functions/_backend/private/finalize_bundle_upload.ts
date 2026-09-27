import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { and, eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'
import * as schema from '../utils/postgres_schema.ts'
import { checkPermissionPg } from '../utils/rbac.ts'

interface FinalizeBundleUploadBody {
  version_id?: unknown
  app_id?: unknown
  name?: unknown
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<FinalizeBundleUploadBody>(c)
  const versionId = body?.version_id
  const appId = body?.app_id
  const versionName = body?.name
  const usesVersionId = versionId !== undefined

  if (usesVersionId && (typeof versionId !== 'number' || !Number.isSafeInteger(versionId) || versionId <= 0))
    return quickError(400, 'error_version_id_invalid', 'version_id must be a positive integer')
  if (!usesVersionId && (typeof appId !== 'string' || !appId || typeof versionName !== 'string' || !versionName))
    return quickError(400, 'error_version_id_invalid', 'version_id or app_id and name are required')

  const pgClient = getPgClient(c, false)
  try {
    await getDrizzleClient(pgClient).transaction(async (tx) => {
      const auth = c.get('auth')
      const apikey = auth?.apikey?.key ?? c.get('capgkey') ?? null
      if (!auth?.userId)
        throw quickError(401, 'not_authorized', 'Not authorized')
      if (!usesVersionId && !(await checkPermissionPg(c, 'app.upload_bundle', { appId: appId as string }, tx, auth.userId, apikey)))
        throw quickError(401, 'not_authorized', 'Not authorized')

      const [version] = await tx
        .select({
          id: schema.app_versions.id,
          appId: schema.app_versions.app_id,
          deleted: schema.app_versions.deleted,
          deletedAt: schema.app_versions.deleted_at,
          storageProvider: schema.app_versions.storage_provider,
        })
        .from(schema.app_versions)
        .where(usesVersionId
          ? eq(schema.app_versions.id, versionId as number)
          : and(eq(schema.app_versions.app_id, appId as string), eq(schema.app_versions.name, versionName as string)))
        .limit(1)
        .for('update')

      if (!version)
        throw quickError(404, 'error_version_not_found', 'Version not found')

      if (usesVersionId && !(await checkPermissionPg(c, 'app.upload_bundle', { appId: version.appId }, tx, auth.userId, apikey)))
        throw quickError(401, 'not_authorized', 'Not authorized')

      if (version.deleted || version.deletedAt)
        throw quickError(400, 'error_version_deleted', 'Deleted versions cannot be finalized')
      if (version.storageProvider === 'r2')
        return
      if (version.storageProvider !== 'r2-direct') {
        throw quickError(400, 'error_version_not_finalizable', 'Version cannot be finalized from its current storage provider', {
          storage_provider: version.storageProvider,
        })
      }

      await tx
        .update(schema.app_versions)
        .set({ storage_provider: 'r2' })
        .where(eq(schema.app_versions.id, version.id))
    })
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    logPgError(c, 'finalize_bundle_upload', error)
    throw simpleError('error_finalize_bundle_upload', 'Failed to finalize version', {}, error)
  }
  finally {
    await closeClient(c, pgClient)
  }

  return c.json(BRES)
})
