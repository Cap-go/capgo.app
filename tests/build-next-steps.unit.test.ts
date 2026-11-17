// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { dismissBuildNextSteps, isBuildActive, isBuildNextStepsDismissed, latestSucceededBuild, savedBuildState } from '../src/services/buildNextSteps'

const NOW = Date.parse('2026-11-17T12:00:00Z')

describe('isBuildActive', () => {
  it.each(['pending', 'running', 'in_progress', 'queued'])('keeps refreshing while a build is %s', (status) => {
    expect(isBuildActive(status)).toBe(true)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'expired', 'released'])('stops refreshing once a build is %s', (status) => {
    expect(isBuildActive(status)).toBe(false)
  })
})

describe('savedBuildState', () => {
  const build = { status: 'succeeded', builder_job_id: 'job_1' }

  it('offers the download while the saved output is current', () => {
    expect(savedBuildState(build, { expires_at: '2026-11-18T00:00:00Z' }, NOW)).toBe('available')
  })

  it('says the saved output expired', () => {
    expect(savedBuildState(build, { expires_at: '2026-11-17T11:00:00Z' }, NOW)).toBe('expired')
  })

  it('explains a succeeded build without a saved output', () => {
    expect(savedBuildState(build, undefined, NOW)).toBe('not-saved')
  })

  it('shows nothing for builds that did not succeed', () => {
    expect(savedBuildState({ status: 'failed' }, undefined, NOW)).toBe('none')
    expect(savedBuildState({ status: 'running' }, undefined, NOW)).toBe('none')
  })
})

describe('latestSucceededBuild', () => {
  it('picks the newest succeeded build', () => {
    const builds = [
      { id: 'c', status: 'running', created_at: '2026-11-17T10:00:00Z' },
      { id: 'a', status: 'succeeded', created_at: '2026-11-15T10:00:00Z' },
      { id: 'b', status: 'succeeded', created_at: '2026-11-16T10:00:00Z' },
    ]
    expect(latestSucceededBuild(builds)).toBe(builds[2])
  })

  it('returns nothing before the first success', () => {
    expect(latestSucceededBuild([{ status: 'failed', created_at: '2026-11-15T10:00:00Z' }])).toBeUndefined()
  })
})

describe('next steps dismissal', () => {
  beforeEach(() => localStorage.clear())

  it('remembers the dismissal per app', () => {
    expect(isBuildNextStepsDismissed('com.example.a')).toBe(false)
    dismissBuildNextSteps('com.example.a')
    expect(isBuildNextStepsDismissed('com.example.a')).toBe(true)
    expect(isBuildNextStepsDismissed('com.example.b')).toBe(false)
  })
})
