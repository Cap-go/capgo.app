// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCicdAiPrompt,
  cicdModeInstruction,
  cicdSetupStorageKey,
  forgetCicdSetupProgress,
  isCicdSetupComplete,
  isCicdSetupValidated,
  loadCicdSetupProgress,
  markCicdSetupValidated,
  requiredCicdReleases,
  saveCicdSetupProgress,
} from '../src/utils/gettingStartedCicd.ts'

const TEST_USER = 'getting-started-cicd-unit-user'
const TEST_APP = 'com.test.gettingstarted.cicd.app'

describe('getting started CI/CD setup', () => {
  afterEach(() => {
    forgetCicdSetupProgress(TEST_USER, TEST_APP)
  })

  it.concurrent('requires one CI/CD release per chosen setup', () => {
    expect(requiredCicdReleases(null)).toEqual([])
    expect(requiredCicdReleases('prod')).toEqual(['production'])
    expect(requiredCicdReleases('prod_preprod')).toEqual(['preprod', 'production'])
    expect(requiredCicdReleases('prod_preprod_pr')).toEqual(['pr', 'preprod', 'production'])
  })

  it.concurrent('adapts the AI prompt to the app id, channels, and required releases', () => {
    const prompt = buildCicdAiPrompt('com.demo.app', 'prod_preprod_pr')
    const buildPr = prompt.slice(prompt.indexOf('build-pr:'), prompt.indexOf('deploy-preview:'))
    const preview = prompt.slice(prompt.indexOf('deploy-preview:'))
    expect(prompt).toContain('com.demo.app')
    expect(prompt).toContain('npx @capgo/cli@latest')
    expect(prompt).toContain(cicdModeInstruction('prod_preprod_pr'))
    expect(prompt).toContain('--channel production')
    expect(prompt).toContain('--channel preprod')
    expect(prompt).toContain('workflow_dispatch')
    expect(prompt).toContain('preview_channel')
    expect(prompt).toContain('CAPGO_TOKEN')
    expect(prompt).toContain('\njobs:\n')
    expect(buildPr).toContain('if: github.event_name == \'pull_request\'')
    expect(buildPr).not.toContain('CAPGO_TOKEN')
    expect(preview).toContain('CAPGO_TOKEN')
    expect(preview).toContain('github.event_name == \'workflow_dispatch\'')
    expect(buildCicdAiPrompt('com.demo.app', 'prod')).toContain('\njobs:\n')
  })

  it('is complete only after every required release is checked', () => {
    const key = cicdSetupStorageKey(TEST_USER, TEST_APP)
    expect(key).toBe(`capgo.gettingStarted.cicd.${TEST_USER}.${TEST_APP}`)

    saveCicdSetupProgress(TEST_USER, TEST_APP, {
      mode: 'prod_preprod',
      releases: { production: true },
      validated: false,
    })
    expect(isCicdSetupComplete(loadCicdSetupProgress(TEST_USER, TEST_APP))).toBe(false)

    saveCicdSetupProgress(TEST_USER, TEST_APP, {
      mode: 'prod_preprod',
      releases: { production: true, preprod: true },
      validated: false,
    })
    expect(isCicdSetupComplete(loadCicdSetupProgress(TEST_USER, TEST_APP))).toBe(true)
    expect(isCicdSetupValidated(TEST_USER, TEST_APP)).toBe(false)

    markCicdSetupValidated(TEST_USER, TEST_APP)
    expect(loadCicdSetupProgress(TEST_USER, TEST_APP).validated).toBe(true)
    expect(isCicdSetupValidated(TEST_USER, TEST_APP)).toBe(true)
  })
})
