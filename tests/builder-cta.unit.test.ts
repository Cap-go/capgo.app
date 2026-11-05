import { createRequire } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// trackEvent is fire-and-forget (void) and never asserted, so a shared module
// mock is safe under concurrent execution. Everything else (select, openUrl,
// hasCredentials) is passed per-test, so there is no shared mutable state.
vi.mock('../cli/src/analytics/track.ts', () => ({ trackEvent: vi.fn() }))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this import
import { decideBuilderCtaSurface, maybePromptBuilderCta } from '../cli/src/bundle/builder-cta.ts'

const baseParams = {
  incompatible: true,
  interactive: true,
  hasCredentials: false,
  appId: 'com.app',
  orgId: 'org1',
  apikey: 'k',
  incompatibleCount: 2,
}

const learnUrl = 'https://capgo.app/native-build/'

interface CliClackPrompts {
  isCancel: (value: unknown) => boolean
  log: {
    warn: (message: string) => void
  }
  select: <Value>(opts: {
    message: string
    options: { value: Value, label: string }[]
    signal: AbortSignal
    input: PassThrough
    output: Writable
  }) => Promise<Value | symbol>
}

let cliClackPrompts: Promise<CliClackPrompts> | undefined

// Resolve from the CLI package so the test drives the same module instance as
// the CLI code, whichever node_modules layout the install produced.
const cliClackPromptsUrl = pathToFileURL(createRequire(new URL('../cli/package.json', import.meta.url)).resolve('@clack/prompts')).href

function getCliClackPrompts(): Promise<CliClackPrompts> {
  cliClackPrompts ??= import(cliClackPromptsUrl) as Promise<CliClackPrompts>
  return cliClackPrompts
}

async function getClackCancelSymbol(): Promise<symbol> {
  const { isCancel, select } = await getCliClackPrompts()
  const input = new PassThrough()
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const choice = await select({
    message: 'Cancel fixture',
    options: [{ value: 'yes', label: 'yes' }],
    signal: AbortSignal.abort(),
    input,
    output,
  })
  expect(isCancel(choice)).toBe(true)
  return choice as symbol
}

describe('decideBuilderCtaSurface', () => {
  const base = { incompatible: true, interactive: true, hasCredentials: false }
  it.concurrent('skips when compatible', () => {
    expect(decideBuilderCtaSurface({ ...base, incompatible: false })).toBe('skip')
  })
  it.concurrent('shows the CI ad when non-interactive', () => {
    expect(decideBuilderCtaSurface({ ...base, interactive: false })).toBe('ci-ad')
  })
  it.concurrent('prompts onboarding when interactive with no credentials', () => {
    expect(decideBuilderCtaSurface(base)).toBe('prompt-onboarding')
  })
  it.concurrent('prompts build when interactive with credentials', () => {
    expect(decideBuilderCtaSurface({ ...base, hasCredentials: true })).toBe('prompt-build')
  })
})

describe('maybePromptBuilderCta', () => {
  it('returns continue when compatible', async () => {
    const select = vi.fn()
    expect(await maybePromptBuilderCta({ ...baseParams, incompatible: false, select })).toBe('continue')
    expect(select).not.toHaveBeenCalled()
  })

  it('launches onboarding on yes (no credentials) with a selector and learn option', async () => {
    const select = vi.fn().mockResolvedValue('yes')
    expect(await maybePromptBuilderCta({ ...baseParams, hasCredentials: false, select })).toBe('launch-onboarding')
    expect(select).toHaveBeenCalledTimes(1)
    const msg = select.mock.calls[0][0].message as string
    expect(msg).toContain('Would you like to configure Capgo Builder now?')
    expect(select.mock.calls[0][0].options).toEqual([
      { value: 'yes', label: '✅ Yes' },
      { value: 'no', label: '❌ No' },
      { value: 'learn', label: '📖 Learn what Capgo Builder is' },
    ])
  })

  it('launches build on accept (credentials present) with the build question', async () => {
    const select = vi.fn().mockResolvedValue('yes')
    expect(await maybePromptBuilderCta({ ...baseParams, hasCredentials: true, select })).toBe('launch-build')
    expect(select.mock.calls[0][0].message as string).toContain('Start a native build with Capgo Builder now?')
  })

  it('continues on no without a second prompt', async () => {
    const select = vi.fn().mockResolvedValue('no')
    expect(await maybePromptBuilderCta({ ...baseParams, select })).toBe('continue')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('aborts when the selector is cancelled', async () => {
    const cancelChoice = await getClackCancelSymbol()
    const select = vi.fn().mockResolvedValue(cancelChoice)

    expect(await maybePromptBuilderCta({ ...baseParams, select })).toBe('abort')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('opens the learn page and asks again', async () => {
    const select = vi.fn()
      .mockResolvedValueOnce('learn')
      .mockResolvedValueOnce('no')
    const openUrl = vi.fn().mockResolvedValue(undefined)

    expect(await maybePromptBuilderCta({ ...baseParams, select, openUrl })).toBe('continue')
    expect(openUrl).toHaveBeenCalledWith(learnUrl)
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('opens the learn page before launching a build on yes', async () => {
    const select = vi.fn()
      .mockResolvedValueOnce('learn')
      .mockResolvedValueOnce('yes')
    const openUrl = vi.fn().mockResolvedValue(undefined)

    expect(await maybePromptBuilderCta({ ...baseParams, hasCredentials: true, select, openUrl })).toBe('launch-build')
    expect(openUrl).toHaveBeenCalledWith(learnUrl)
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('warns and asks again when opening the learn page fails', async () => {
    const select = vi.fn()
      .mockResolvedValueOnce('learn')
      .mockResolvedValueOnce('yes')
    const openUrl = vi.fn().mockRejectedValue(new Error('browser unavailable'))
    const { log } = await getCliClackPrompts()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    try {
      expect(await maybePromptBuilderCta({ ...baseParams, select, openUrl })).toBe('launch-onboarding')
      expect(openUrl).toHaveBeenCalledWith(learnUrl)
      expect(warn).toHaveBeenCalledWith(`Could not open your browser automatically. Visit: ${learnUrl}`)
      expect(select).toHaveBeenCalledTimes(2)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('shows the CI ad and continues when non-interactive', async () => {
    const select = vi.fn()
    expect(await maybePromptBuilderCta({ ...baseParams, interactive: false, select })).toBe('continue')
    expect(select).not.toHaveBeenCalled()
  })
})
