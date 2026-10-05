import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

async function createNavigation() {
  const component = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/app/:app/getting-started', name: '/app/[app].getting-started', component },
      { path: '/app/new', component },
      { path: '/onboarding/app', component },
      { path: '/dashboard', component },
    ],
  })
  const committed: string[] = []
  router.afterEach(to => committed.push(to.path))
  const { install } = await import('../src/modules/onboarding-setup')
  install({ router } as any)
  return { router, committed }
}

describe('getting started navigation', () => {
  it.concurrent.each(['/onboarding/app', '/app/new'])('forwards %s resume links to Getting started before committing', async (path) => {
    const { router, committed } = await createNavigation()
    await router.push(`${path}?resume=com.example.app&step=setup`)
    expect(router.currentRoute.value.fullPath).toBe('/app/com.example.app/getting-started')
    expect(committed).toEqual(['/app/com.example.app/getting-started'])
  })

  it.concurrent('encodes the resumed app id', async () => {
    const { router } = await createNavigation()
    await router.push({ path: '/onboarding/app', query: { resume: 'com.example/app' } })
    expect(router.currentRoute.value.path).toBe('/app/com.example%2Fapp/getting-started')
  })

  it.concurrent.each(['/onboarding/app', '/app/new'])('keeps %s without a resume id on the creation flow', async (path) => {
    const { router } = await createNavigation()
    await router.push(path)
    expect(router.currentRoute.value.path).toBe(path)
  })

  it.concurrent('does not touch Getting started or other dashboard routes', async () => {
    const { router } = await createNavigation()
    await router.push('/app/com.example.app/getting-started')
    expect(router.currentRoute.value.path).toBe('/app/com.example.app/getting-started')
    await router.push('/dashboard?resume=com.example.app')
    expect(router.currentRoute.value.path).toBe('/dashboard')
  })
})
