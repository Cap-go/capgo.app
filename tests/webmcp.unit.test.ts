// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConsoleNavigatePath } from '../src/services/webmcpConsolePaths.ts'

describe('webmcp feature detection', () => {
  beforeEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(document, 'modelContext')
    Reflect.deleteProperty(navigator, 'modelContext')
  })

  it('prefers document.modelContext over navigator.modelContext', async () => {
    const documentContext = { registerTool: vi.fn() }
    const navigatorContext = { registerTool: vi.fn() }
    Object.defineProperty(document, 'modelContext', { value: documentContext, configurable: true })
    Object.defineProperty(navigator, 'modelContext', { value: navigatorContext, configurable: true })

    const { getModelContext } = await import('../src/services/webmcp.ts')
    expect(getModelContext()).toBe(documentContext)
  })

  it('falls back to navigator.modelContext when document.modelContext is missing', async () => {
    const navigatorContext = { registerTool: vi.fn() }
    Object.defineProperty(navigator, 'modelContext', { value: navigatorContext, configurable: true })

    const { getModelContext } = await import('../src/services/webmcp.ts')
    expect(getModelContext()).toBe(navigatorContext)
  })

  it('returns null when WebMCP is unavailable', async () => {
    const { getModelContext, isWebMcpSupported } = await import('../src/services/webmcp.ts')
    expect(getModelContext()).toBeNull()
    expect(isWebMcpSupported()).toBe(false)
  })
})

describe('buildConsoleNavigatePath', () => {
  it('builds common console routes', () => {
    expect(buildConsoleNavigatePath('dashboard')).toBe('/dashboard')
    expect(buildConsoleNavigatePath('apps')).toBe('/apps')
    expect(buildConsoleNavigatePath('app_bundles', { appId: 'com.example.app' }))
      .toBe('/app/com.example.app/bundles')
    expect(buildConsoleNavigatePath('app_channel_detail', {
      appId: 'com.example.app',
      channelId: 42,
    })).toBe('/app/com.example.app/channel/42')
  })

  it('requires app-scoped parameters', () => {
    expect(() => buildConsoleNavigatePath('app_channels')).toThrow('appId is required')
    expect(() => buildConsoleNavigatePath('app_bundle_detail', { appId: 'com.example.app' }))
      .toThrow('bundleId')
  })
})
