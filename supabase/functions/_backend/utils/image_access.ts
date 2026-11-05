import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { z } from 'zod'
import { closeClient, getPgClient } from './pg.ts'
import { checkPermission, checkPermissionInMemberOrgs } from './rbac.ts'

// Image objects moved from the Supabase Storage `images` bucket to R2, so the
// bucket's RLS policies no longer guard them. These checks carry the same rules
// over to the API, which is the only path into R2:
// - `public/...`                readable by anyone signed in
// - `org/{orgId}/logo/...`      read: org.read, write/delete: org.update_settings
// - `org/{orgId}/{appId}/...`   read: app.read, write/delete: app.update_settings,
//                               plus org.create_app for the onboarding `icon` of
//                               an app that does not exist yet or still onboards
// - `{userId}/...`              the user themself, or (read only) anyone who can
//                               read the members of an org that user belongs to

export type ImageAccess = 'read' | 'write' | 'delete'

type ParsedImagePath
  = | { kind: 'public' }
    | { kind: 'org_logo', orgId: string }
    | { kind: 'app', orgId: string, appId: string, fileName: string }
    | { kind: 'user', userId: string }

const uuidSchema = z.uuid()

export function parseImagePath(path: string): ParsedImagePath | null {
  const segments = path.split('/')
  if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..') || path.includes('\0'))
    return null

  const [first, second, third] = segments
  if (first === 'public')
    return { kind: 'public' }
  if (first === 'org') {
    if (segments.length < 4 || !uuidSchema.safeParse(second).success)
      return null
    if (third === 'logo')
      return { kind: 'org_logo', orgId: second }
    return { kind: 'app', orgId: second, appId: third, fileName: segments.at(-1)! }
  }
  if (!uuidSchema.safeParse(first).success)
    return null
  return { kind: 'user', userId: first }
}

async function canWriteAppImage(c: Context<MiddlewareKeyVariables>, orgId: string, appId: string, fileName: string) {
  // Resolve the app with the admin client: an app hidden from the caller must
  // not look missing, or an org.create_app grant could overwrite its icon.
  let app: { owner_org: string, need_onboarding: boolean | null } | undefined
  try {
    const pg = await getPgClient(c)
    try {
      const result = await pg.query<{ owner_org: string, need_onboarding: boolean | null }>('SELECT owner_org, need_onboarding FROM public.apps WHERE app_id = $1 LIMIT 1', [appId])
      app = result.rows[0]
    }
    finally {
      closeClient(c, pg)
    }
  }
  catch {
    return false
  }
  if (app && app.owner_org !== orgId)
    return false
  if (app && await checkPermission(c, 'app.update_settings', { orgId, appId }))
    return true
  // Create-only grants may write the onboarding icon only.
  if (fileName !== 'icon' || (app && app.need_onboarding !== true))
    return false
  return checkPermission(c, 'org.create_app', { orgId })
}

export async function canAccessImagePath(c: Context<MiddlewareKeyVariables>, path: string, access: ImageAccess) {
  const callerId = c.get('auth')?.userId
  if (!callerId)
    return false
  const parsed = parseImagePath(path)
  if (!parsed)
    return false

  switch (parsed.kind) {
    case 'public':
      return access === 'read'
    case 'org_logo':
      return checkPermission(c, access === 'read' ? 'org.read' : 'org.update_settings', { orgId: parsed.orgId })
    case 'app':
      if (access === 'read')
        return checkPermission(c, 'app.read', { orgId: parsed.orgId, appId: parsed.appId })
      if (access === 'delete')
        return checkPermission(c, 'app.update_settings', { orgId: parsed.orgId, appId: parsed.appId })
      return canWriteAppImage(c, parsed.orgId, parsed.appId, parsed.fileName)
    case 'user':
      if (parsed.userId === callerId)
        return true
      // One query over the owner's memberships, like the storage policy it replaces.
      return access === 'read' && checkPermissionInMemberOrgs(c, 'org.read_members', parsed.userId)
  }
}
