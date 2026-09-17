import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

function createContext(onboarding: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: { app_id: 'com.example.app', onboarding } as { app_id: string, onboarding: unknown } | null, error: null as { message: string } | null })),
  }
  return {
    main: { auth: { id: 'user-1' } as { id: string } | undefined },
    supabase: { from: vi.fn(() => query) },
    query,
    organization: {
      awaitInitialLoad: vi.fn(async () => true),
      getOrgByAppId: vi.fn(() => ({ gid: 'owning-org' })),
      setCurrentOrganization: vi.fn(),
    },
  }
}

const storage = new AsyncLocalStorage<ReturnType<typeof createContext>>()

function context() {
  const current = storage.getStore()
  if (!current)
    throw new Error('Missing navigation test context')
  return current
}

vi.mock('~/services/supabase', () => ({ useSupabase: () => context().supabase }))
vi.mock('~/stores/main', () => ({ useMainStore: () => context().main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => context().organization }))

async function createNavigation() {
  const component = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/app/:app/getting-started', name: '/app/[app].getting-started', component },
      { path: '/onboarding/app', component },
      { path: '/dashboard', component },
      { path: '/login', component },
    ],
  })
  const committed: string[] = []
  router.afterEach(to => committed.push(to.path))
  const { install } = await import('../src/modules/onboarding-setup')
  install({ router } as any)
  return { router, committed }
}

describe('Getting started navigation', () => {
  it.concurrent('redirects v3 before committing the legacy route and selects the app organization', async () => {
    const current = createContext({ setup: { todo_list_version: 3 } })
    await storage.run(current, async () => {
      const { router, committed } = await createNavigation()
      await router.push('/app/com.example.app/getting-started')
      expect(router.currentRoute.value.fullPath).toBe('/onboarding/app?resume=com.example.app&step=setup')
      expect(committed).toEqual(['/onboarding/app'])
      expect(current.supabase.from).toHaveBeenCalledWith('apps')
      expect(current.query.eq).toHaveBeenCalledExactlyOnceWith('app_id', 'com.example.app')
      expect(current.organization.setCurrentOrganization).toHaveBeenCalledWith('owning-org')
    })
  })

  it.concurrent.each([1, 2])('keeps the legacy page for version %i from the authenticated app read', async (version) => {
    const current = createContext({ setup: { todo_list_version: version } })
    await storage.run(current, async () => {
      const { router } = await createNavigation()
      await router.push('/app/com.example.app/getting-started')
      expect(router.currentRoute.value.path).toBe('/app/com.example.app/getting-started')
      expect(current.organization.setCurrentOrganization).not.toHaveBeenCalled()
    })
  })

  it.concurrent('does not redirect an app the authenticated client cannot read', async () => {
    const current = createContext({ setup: { todo_list_version: 3 } })
    current.query.maybeSingle.mockResolvedValue({ data: null, error: null })
    await storage.run(current, async () => {
      const { router } = await createNavigation()
      await router.push('/app/com.example.app/getting-started')
      expect(router.currentRoute.value.path).toBe('/app/com.example.app/getting-started')
      expect(current.organization.setCurrentOrganization).not.toHaveBeenCalled()
    })
  })

  it.concurrent('leaves a failed lookup to the existing page error handling', async () => {
    const current = createContext({ setup: { todo_list_version: 3 } })
    current.query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'App lookup unavailable' } })
    await storage.run(current, async () => {
      const { router } = await createNavigation()
      await router.push('/app/com.example.app/getting-started')
      expect(router.currentRoute.value.path).toBe('/app/com.example.app/getting-started')
      expect(current.organization.setCurrentOrganization).not.toHaveBeenCalled()
    })
  })

  it.concurrent('does not read app data before authentication', async () => {
    const current = createContext({ setup: { todo_list_version: 3 } })
    current.main.auth = undefined
    await storage.run(current, async () => {
      const { router } = await createNavigation()
      await router.push('/app/com.example.app/getting-started')
      expect(current.supabase.from).not.toHaveBeenCalled()
    })
  })

  it.concurrent('does not query app versions on other dashboard routes', async () => {
    const current = createContext({ setup: { todo_list_version: 3 } })
    await storage.run(current, async () => {
      const { router } = await createNavigation()
      await router.push('/dashboard')
      expect(router.currentRoute.value.path).toBe('/dashboard')
      expect(current.supabase.from).not.toHaveBeenCalled()
    })
  })
})
