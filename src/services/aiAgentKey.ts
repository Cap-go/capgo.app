import type { ConsoleClient } from '~/services/consoleClient'
import type { Database } from '~/types/database.types'
import { createDefaultApiKey, findUsablePlainApiKey, shareInFlightApiKeyLoad } from '~/services/apikeys'
import { checkPermissions } from '~/services/permissions'

/** Console tasks a copied AI agent prompt can perform. */
export type AiAgentKeyTask = 'add-app' | 'upload-bundle' | 'create-channel' | 'request-build'

/**
 * App roles whose key can finish each app task. Uploading to a channel needs
 * app.upload_bundle and channel.promote_bundle; creating a channel with --default or
 * --self-assign also needs channel.update_settings; a native build uses the signing stored
 * on Capgo and a new platform stores signing, both needing app settings rights. Only
 * app_admin grants those settings rights.
 */
export function agentKeyAppRoles(task: AiAgentKeyTask): readonly string[] | undefined {
  if (task === 'add-app')
    return undefined
  return task === 'upload-bundle' ? ['app_admin', 'app_developer', 'app_uploader'] : ['app_admin']
}

export interface AgentKeyScope {
  userId: string
  orgId: string
  /** Every task except `add-app`. */
  appId: string | null
  task: AiAgentKeyTask
}

interface AgentKeyPlan {
  /** A live key the user already owns that can do the task. */
  existingKey: string | null
  /** The role a new key may get, or null when the user cannot create a key that works. */
  createRole: 'org_admin' | 'app_admin' | 'app_developer' | null
}

/**
 * Which key the prompt would carry. Only someone who can manage user roles may give a key
 * org_admin or app_admin (the API rejects it otherwise); an app API key manager may still
 * create an app_developer key, which is enough to upload a bundle.
 */
async function agentKeyPlan(capgo: ConsoleClient<Database>, scope: AgentKeyScope): Promise<AgentKeyPlan> {
  const appRoles = agentKeyAppRoles(scope.task)
  const [existingKey, canAssignAdminRoles] = await Promise.all([
    findUsablePlainApiKey(capgo, scope.userId, scope.orgId, scope.appId, { appRoles }),
    checkPermissions(['org.update_user_roles', 'org.manage_apikeys'], { orgId: scope.orgId }).catch(() => false),
  ])
  if (canAssignAdminRoles)
    return { existingKey, createRole: scope.task === 'add-app' ? 'org_admin' : 'app_admin' }
  if (scope.task === 'upload-bundle' && scope.appId && await checkPermissions('app.manage_apikeys', { appId: scope.appId }).catch(() => false))
    return { existingKey, createRole: 'app_developer' }
  return { existingKey, createRole: null }
}

/** Whether a copied prompt can carry a working key, so the AI option is never a dead end. */
export async function canPrepareAgentKey(capgo: ConsoleClient<Database>, scope: AgentKeyScope): Promise<boolean> {
  try {
    const plan = await agentKeyPlan(capgo, scope)
    return !!plan.existingKey || !!plan.createRole
  }
  catch (error) {
    console.warn('Cannot check the API key for the AI agent prompt', error)
    return false
  }
}

/** Reuses a key the user owns for the task, otherwise creates the narrowest one they may create. */
export function loadAgentKey(capgo: ConsoleClient<Database>, scope: AgentKeyScope, keyName: string): Promise<string | null> {
  const appRoles = agentKeyAppRoles(scope.task)
  return shareInFlightApiKeyLoad({ userId: scope.userId, orgId: scope.orgId, appId: scope.appId, appRoles }, async () => {
    const plan = await agentKeyPlan(capgo, scope)
    if (plan.existingKey)
      return plan.existingKey
    if (!plan.createRole)
      return null
    const { data, error } = await createDefaultApiKey(capgo, keyName, plan.createRole === 'org_admin'
      ? { orgId: scope.orgId }
      : { appId: scope.appId, appRole: plan.createRole })
    if (error)
      throw error
    return typeof data?.key === 'string' ? data.key : findUsablePlainApiKey(capgo, scope.userId, scope.orgId, scope.appId, { appRoles })
  })
}
