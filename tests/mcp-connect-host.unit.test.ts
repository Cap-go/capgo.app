import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConsoleApiHost } from '~/services/consoleApiHost'

describe('MCP connect hosted URL', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses the China API host on console.capgo.com.cn', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.com.cn', origin: 'https://console.capgo.com.cn' },
    })
    const hostedMcpUrl = `${getConsoleApiHost().replace(/\/$/, '')}/mcp`
    expect(hostedMcpUrl).toBe('https://api.capgo.com.cn/mcp')
  })
})