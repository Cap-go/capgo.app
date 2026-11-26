import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('buildChinaConsoleCliApiHostArg', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('appends --api-host only on the China console', async () => {
    vi.stubGlobal('window', { location: { hostname: 'console.capgo.com.cn' } })
    const { buildChinaConsoleCliApiHostArg, CHINA_API_HOST } = await import('../src/services/consoleApiHost')
    expect(buildChinaConsoleCliApiHostArg()).toBe(` --api-host ${CHINA_API_HOST}`)
  })

  it('does not append --api-host on preprod or global prod console hosts', async () => {
    const { buildChinaConsoleCliApiHostArg } = await import('../src/services/consoleApiHost')

    vi.stubEnv('VITE_API_HOST', 'https://api.preprod.capgo.app')
    vi.stubGlobal('window', { location: { hostname: 'console.preprod.capgo.app' } })
    expect(buildChinaConsoleCliApiHostArg()).toBe('')

    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubGlobal('window', { location: { hostname: 'console.capgo.app' } })
    expect(buildChinaConsoleCliApiHostArg()).toBe('')
  })
})