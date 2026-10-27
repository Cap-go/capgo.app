import type { ConsoleClient } from '../src/services/consoleClient'
import type { Database } from '../src/types/database.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canPrepareAgentKey, loadAgentKey } from '../src/services/aiAgentKey'

const mocks = vi.hoisted(() => ({
  findUsablePlainApiKey: vi.fn(),
  createDefaultApiKey: vi.fn(),
  checkPermissions: vi.fn(),
}))

vi.mock('~/services/apikeys', () => ({
  findUsablePlainApiKey: mocks.findUsablePlainApiKey,
  createDefaultApiKey: mocks.createDefaultApiKey,
  shareInFlightApiKeyLoad: (_scope: unknown, load: () => Promise<string | null>) => load(),
}))
vi.mock('~/services/permissions', () => ({ checkPermissions: mocks.checkPermissions }))

const capgo = {} as ConsoleClient<Database>
const appScope = { userId: 'user-1', orgId: 'org-1', appId: 'com.acme.app' }

// Grants exactly the listed permissions; a list asks for all of them.
function grant(...allowed: string[]) {
  mocks.checkPermissions.mockImplementation(async (permissions: string | string[]) =>
    (Array.isArray(permissions) ? permissions : [permissions]).every(permission => allowed.includes(permission)))
}

beforeEach(() => {
  mocks.findUsablePlainApiKey.mockReset().mockResolvedValue(null)
  mocks.createDefaultApiKey.mockReset().mockResolvedValue({ data: { key: 'new-key' }, error: null })
  mocks.checkPermissions.mockReset()
})

describe('AI agent prompt key', () => {
  it('reuses a key the user already owns for the task', async () => {
    grant()
    mocks.findUsablePlainApiKey.mockResolvedValue('owned-key')
    expect(await canPrepareAgentKey(capgo, { ...appScope, task: 'create-channel' })).toBe(true)
    expect(await loadAgentKey(capgo, { ...appScope, task: 'create-channel' }, 'API key')).toBe('owned-key')
    expect(mocks.findUsablePlainApiKey).toHaveBeenCalledWith(capgo, 'user-1', 'org-1', 'com.acme.app', { appRoles: ['app_admin'] })
    expect(mocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('creates an app_admin key only for users who may assign that role', async () => {
    grant('org.update_user_roles', 'org.manage_apikeys')
    expect(await loadAgentKey(capgo, { ...appScope, task: 'request-build' }, 'API key')).toBe('new-key')
    expect(mocks.createDefaultApiKey).toHaveBeenCalledWith(capgo, 'API key', { appId: 'com.acme.app', appRole: 'app_admin' })
  })

  it('creates an org_admin key for add app only for users who may assign it', async () => {
    grant('org.update_user_roles', 'org.manage_apikeys')
    expect(await loadAgentKey(capgo, { ...appScope, appId: null, task: 'add-app' }, 'API key')).toBe('new-key')
    expect(mocks.createDefaultApiKey).toHaveBeenCalledWith(capgo, 'API key', { orgId: 'org-1' })

    grant('org.manage_apikeys')
    expect(await canPrepareAgentKey(capgo, { ...appScope, appId: null, task: 'add-app' })).toBe(false)
  })

  it('lets an app key manager upload bundles with an app_developer key, but not run admin tasks', async () => {
    grant('app.manage_apikeys')
    expect(await loadAgentKey(capgo, { ...appScope, task: 'upload-bundle' }, 'API key')).toBe('new-key')
    expect(mocks.createDefaultApiKey).toHaveBeenCalledWith(capgo, 'API key', { appId: 'com.acme.app', appRole: 'app_developer' })
    expect(await canPrepareAgentKey(capgo, { ...appScope, task: 'create-channel' })).toBe(false)
    expect(await canPrepareAgentKey(capgo, { ...appScope, task: 'request-build' })).toBe(false)
    expect(await loadAgentKey(capgo, { ...appScope, task: 'request-build' }, 'API key')).toBeNull()
  })
})
