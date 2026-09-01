// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCicdAiPrompt,
  cicdModeInstruction,
  cicdSetupStorageKey,
  isCicdSetupComplete,
  isCicdSetupValidated,
  loadCicdSetupProgress,
  markCicdSetupValidated,
  requiredCicdReleases,
  saveCicdSetupProgress,
} from '../src/utils/gettingStartedCicd.ts'

describe('getting started CI/CD setup', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it.concurrent('requires one CI/CD release per chosen setup', () => {
    expect(requiredCicdReleases(null)).toEqual([])
    expect(requiredCicdReleases('prod')).toEqual(['production'])
    expect(requiredCicdReleases('prod_preprod')).toEqual(['preprod', 'production'])
    expect(requiredCicdReleases('prod_preprod_pr')).toEqual(['pr', 'preprod', 'production'])
  })

  it.concurrent('adapts the AI prompt to the app id, channels, and required releases', () => {
    const prompt = buildCicdAiPrompt('com.demo.app', 'prod_preprod_pr')
    expect(prompt).toContain('com.demo.app')
    expect(prompt).toContain('npx @capgo/cli@latest')
    expect(prompt).toContain(cicdModeInstruction('prod_preprod_pr'))
    expect(prompt).toContain('--channel production')
    expect(prompt).toContain('--channel preprod')
    expect(prompt).toContain('CHANNEL="pr-')
    expect(prompt).toContain('github.event.number')
    expect(prompt).toContain('CAPGO_TOKEN')
    expect(prompt).toContain('\njobs:\n')
    expect(prompt).toContain("github.event.pull_request.head.repo.full_name == github.repository")
    expect(buildCicdAiPrompt('com.demo.app', 'prod')).toContain('\njobs:\n')
  })

  it('is complete only after every required release is checked', () => {
    const key = cicdSetupStorageKey('user-1', 'com.demo.app')
    expect(key).toBe('capgo.gettingStarted.cicd.user-1.com.demo.app')

    saveCicdSetupProgress('user-1', 'com.demo.app', {
      mode: 'prod_preprod',
      releases: { production: true },
      validated: false,
    })
    expect(isCicdSetupComplete(loadCicdSetupProgress('user-1', 'com.demo.app'))).toBe(false)

    saveCicdSetupProgress('user-1', 'com.demo.app', {
      mode: 'prod_preprod',
      releases: { production: true, preprod: true },
      validated: false,
    })
    expect(isCicdSetupComplete(loadCicdSetupProgress('user-1', 'com.demo.app'))).toBe(true)
    expect(isCicdSetupValidated('user-1', 'com.demo.app')).toBe(false)

    markCicdSetupValidated('user-1', 'com.demo.app')
    expect(loadCicdSetupProgress('user-1', 'com.demo.app').validated).toBe(true)
    expect(isCicdSetupValidated('user-1', 'com.demo.app')).toBe(true)
  })
})
