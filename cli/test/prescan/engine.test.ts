// test/prescan/engine.test.ts
import { describe, expect, it } from 'bun:test'
import { decideOutcome, runPrescan } from '../../src/build/prescan/engine'
import { ALL_CHECKS, IOS_P12_LEGACY_ENFORCE_AFTER, IOS_PRESCAN_EXPANSION_ENFORCE_AFTER } from '../../src/build/prescan/registry'
import type { PrescanCheck, ScanContext } from '../../src/build/prescan/types'
import { makeP12, makeProfileXmlWithCert, makeProject } from './helpers'

const baseCtx = { appId: 'com.demo.app', platform: 'ios', projectDir: '/tmp/none' } as ScanContext

function check(partial: Partial<PrescanCheck>): PrescanCheck {
  return { id: 'test/x', platforms: ['ios', 'android'], run: async () => [], ...partial }
}

describe('runPrescan', () => {
  it('collects findings from applicable checks only', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'a', run: async () => [{ id: 'a', severity: 'error', title: 'bad' }] }),
      check({ id: 'b', platforms: ['android'] }), // not applicable on ios
    ])
    expect(report.checksRun).toBe(1)
    expect(report.counts.error).toBe(1)
  })

  it('copies a check enforcement date onto its findings', async () => {
    const report = await runPrescan(baseCtx, [
      check({
        id: 'rollout',
        enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER,
        run: async () => [{ id: 'rollout', severity: 'error', title: 'bad' }],
      }),
    ])
    expect(report.findings[0]?.enforceAfter).toBe(IOS_PRESCAN_EXPANSION_ENFORCE_AFTER)
  })

  it('isolates crashing checks as info findings', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'boom', run: async () => { throw new Error('kaput') } }),
    ])
    expect(report.counts.error).toBe(0)
    const crash = report.findings.find(f => f.id === 'prescan/check-crashed')
    expect(crash?.severity).toBe('info')
    expect(crash?.detail).toContain('kaput')
  })

  it('keeps crashes from rollout checks information only until their deadline', async () => {
    const report = await runPrescan(baseCtx, [
      check({
        id: 'rollout-boom',
        enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER,
        run: async () => { throw new Error('kaput') },
      }),
    ])
    expect(report.findings[0]?.enforceAfter).toBe(IOS_PRESCAN_EXPANSION_ENFORCE_AFTER)
  })

  it('skips remote checks without apikey and reports one info finding', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'r1', remote: true, run: async () => [{ id: 'r1', severity: 'error', title: 'x' }] }),
      check({ id: 'r2', remote: true }),
    ])
    expect(report.counts.error).toBe(0)
    expect(report.skippedRemote).toBe(2)
    expect(report.findings.find(f => f.id === 'prescan/remote-skipped')?.title).toContain('2')
  })

  it('respects appliesTo', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'c', appliesTo: () => false, run: async () => [{ id: 'c', severity: 'error', title: 'x' }] }),
    ])
    expect(report.checksRun).toBe(0)
  })

  it('times out runaway checks as info', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'slow', run: () => new Promise(() => {}) }),
    ], { checkTimeoutMs: 50 })
    expect(report.findings.find(f => f.id === 'prescan/check-timeout')?.severity).toBe('info')
  })
})

describe('decideOutcome', () => {
  const report = (error: number, warning: number) =>
    ({ findings: [], counts: { error, warning, info: 0 }, skippedRemote: 0, durationMs: 0, checksRun: 0 })

  it('blocks on errors', () => expect(decideOutcome(report(1, 0), {})).toBe('block'))
  it('asks on warnings', () => expect(decideOutcome(report(0, 1), {})).toBe('ask'))
  it('proceeds when clean', () => expect(decideOutcome(report(0, 0), {})).toBe('proceed'))
  it('blocks warnings with failOnWarnings', () => expect(decideOutcome(report(0, 1), { failOnWarnings: true })).toBe('block'))
  it('ignoreFatal always proceeds', () => {
    expect(decideOutcome(report(5, 5), { ignoreFatal: true })).toBe('proceed')
  })

  it('treats rollout findings as information only before their enforcement date', () => {
    const graceReport = {
      findings: [{
        id: 'ios/new-check',
        severity: 'error' as const,
        title: 'critical problem',
        enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER,
      }],
      counts: { error: 1, warning: 0, info: 0 },
      skippedRemote: 0,
      durationMs: 0,
      checksRun: 1,
    }
    expect(decideOutcome(graceReport, { now: new Date('2026-08-13T23:59:59.999Z') })).toBe('proceed')
  })

  it('enforces rollout findings at the exact deadline', () => {
    const graceReport = {
      findings: [{
        id: 'ios/new-check',
        severity: 'error' as const,
        title: 'critical problem',
        enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER,
      }],
      counts: { error: 1, warning: 0, info: 0 },
      skippedRemote: 0,
      durationMs: 0,
      checksRun: 1,
    }
    expect(decideOutcome(graceReport, { now: new Date(IOS_PRESCAN_EXPANSION_ENFORCE_AFTER) })).toBe('block')
  })

  it('still blocks an existing enforced error during the rollout window', () => {
    const mixedReport = {
      findings: [
        { id: 'ios/new-check', severity: 'error' as const, title: 'new', enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER },
        { id: 'ios/existing-check', severity: 'error' as const, title: 'existing' },
      ],
      counts: { error: 2, warning: 0, info: 0 },
      skippedRemote: 0,
      durationMs: 0,
      checksRun: 2,
    }
    expect(decideOutcome(mixedReport, { now: new Date('2026-08-01T00:00:00.000Z') })).toBe('block')
  })
})

describe('fixture helpers', () => {
  it('makeProject writes nested files', () => {
    const dir = makeProject({ 'a/b/c.txt': 'hi' })
    expect(require('node:fs').readFileSync(`${dir}/a/b/c.txt`, 'utf8')).toBe('hi')
  })
  it('makeP12 produces an openable p12 with a sha1', () => {
    const p12 = makeP12()
    expect(p12.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(makeProfileXmlWithCert(p12)).toContain('DeveloperCertificates')
  })
})

describe('registry', () => {
  it('contains all 84 checks with unique ids', () => {
    const ids = ALL_CHECKS.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(84)
    for (const expected of [
      'shared/apikey-permission', 'shared/app-exists', 'shared/credentials-saved',
      'shared/cap-sync-stale', 'shared/node-linker-layout', 'shared/bundle-id-consistency',
      'ios/p12-opens', 'ios/p12-legacy-encryption', 'ios/p12-expiry', 'ios/profile-expiry', 'ios/profile-bundle-match',
      'ios/profile-type-vs-mode', 'ios/cert-profile-pairing', 'ios/targets-covered',
      'ios/infoplist-sanity', 'ios/asc-key-valid',
      // 11 ios plist checks
      'ios/plist-bundle-id-format', 'ios/plist-version-short-format', 'ios/plist-version-build-format',
      'ios/plist-encryption-compliance', 'ios/plist-ats-arbitrary-loads', 'ios/plist-launch-storyboard',
      'ios/plist-orientations-multitasking', 'ios/plist-orientations-present', 'ios/plist-display-name',
      'ios/plist-background-modes-sanity', 'ios/plist-required-device-arm64',
      // 7 ios xcode checks
      'ios/xcode-deployment-target-capacitor', 'ios/xcode-signing-team', 'ios/xcode-bundle-id-mismatch-across-configs',
      'ios/xcode-enable-bitcode-leftover', 'ios/xcode-swift-version-sanity', 'ios/xcode-no-app-target',
      'ios/xcode-multiple-app-targets',
      // 5 ios entitlements checks
      'ios/entitlements-vs-profile-capability', 'ios/entitlements-aps-environment-vs-mode',
      'ios/entitlements-associated-domains-format', 'ios/entitlements-app-groups-format',
      'ios/entitlements-declared-age-range',
      // 3 ios capacitor config checks
      'ios/capacitor-server-url-shipped', 'ios/capacitor-server-cleartext', 'ios/capacitor-allow-navigation-wildcard',
      // 9 ios pods/spm/appicon checks
      'ios/pods-not-installed', 'ios/pods-lock-missing', 'ios/pods-capacitor-missing',
      'ios/spm-package-resolved-missing', 'ios/spm-capacitor-dependency-missing', 'ios/appicon-empty-or-placeholder',
      'ios/appicon-referenced-file-missing', 'ios/appicon-marketing-missing', 'ios/spm-deployment-target-consistency',
      'android/keystore-opens', 'android/keystore-expiry', 'android/cordova-vars-present',
      'android/gradle-props-heuristics', 'android/play-sa-json', 'android/flavor-exists',
      'android/agp8-package-attr',
      // 13 android manifest checks
      'android/manifest-well-formed', 'android/manifest-tag-typo', 'android/manifest-namespace-uri',
      'android/manifest-missing-prefix', 'android/manifest-exported-missing', 'android/manifest-multiple-uses-sdk',
      'android/manifest-duplicate-component', 'android/manifest-unique-permission', 'android/manifest-hardcoded-debuggable',
      'android/manifest-mock-location', 'android/manifest-exported-unprotected', 'android/manifest-query-all-packages',
      'android/manifest-deeplink-valid',
      // 11 android gradle/project checks
      'android/applicationid-present', 'android/capacitor-build-gradle-applied', 'android/gradle-wrapper-present',
      'android/flavor-dimensions', 'android/google-services-file', 'android/local-properties-committed',
      'android/sdk-floors', 'android/target-sdk-play', 'android/min-sdk-capacitor', 'android/min-sdk-dependencies', 'android/version-fields',
      // 2 store-access checks
      'android/play-sa-access', 'ios/asc-key-access',
    ]) expect(ids).toContain(expected)
  })

  it('defers exactly the 35 iOS expansion checks until the hard-coded deadline', () => {
    const deferred = ALL_CHECKS.filter(check => check.enforceAfter === IOS_PRESCAN_EXPANSION_ENFORCE_AFTER)
    expect(deferred.length).toBe(35)
    expect(deferred.every(check => check.id.startsWith('ios/'))).toBe(true)
    expect(ALL_CHECKS.find(check => check.id === 'ios/p12-opens')?.enforceAfter).toBeUndefined()
  })

  it('makes legacy P12 encryption fatal after its dedicated 14-day rollout', () => {
    expect(IOS_P12_LEGACY_ENFORCE_AFTER).toBe('2026-08-17T00:00:00.000Z')
    expect(ALL_CHECKS.find(check => check.id === 'ios/p12-legacy-encryption')?.enforceAfter).toBe(IOS_P12_LEGACY_ENFORCE_AFTER)

    const rolloutReport = {
      findings: [{
        id: 'ios/p12-legacy-encryption',
        severity: 'error' as const,
        title: 'modern P12',
        enforceAfter: IOS_P12_LEGACY_ENFORCE_AFTER,
      }],
      counts: { error: 1, warning: 0, info: 0 },
      skippedRemote: 0,
      durationMs: 0,
      checksRun: 1,
    }
    expect(decideOutcome(rolloutReport, { now: new Date('2026-08-16T23:59:59.999Z') })).toBe('proceed')
    expect(decideOutcome(rolloutReport, { now: new Date(IOS_P12_LEGACY_ENFORCE_AFTER) })).toBe('block')
  })
})

describe('runPrescan crash isolation hardening', () => {
  it('a throwing appliesTo predicate is isolated — the scan still completes', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'bad-predicate', appliesTo: () => { throw new Error('predicate boom') } }),
      check({ id: 'good', run: async () => [{ id: 'good', severity: 'warning', title: 'w' }] }),
    ])
    const crash = report.findings.find(f => f.id === 'prescan/check-crashed')
    expect(crash?.severity).toBe('info')
    expect(crash?.detail).toContain('predicate boom')
    // the healthy check still ran
    expect(report.counts.warning).toBe(1)
    expect(report.checksRun).toBe(1)
  })

  it('crash detail is truncated and base64-looking runs are redacted (never leak blobs)', async () => {
    const blob = 'QmFzZTY0U2VjcmV0'.repeat(20) // 320 chars of base64-ish text
    const report = await runPrescan(baseCtx, [
      check({ id: 'leaky', run: async () => { throw new Error(`parse failed: ${blob} <- secret`) } }),
    ])
    const crash = report.findings.find(f => f.id === 'prescan/check-crashed')
    expect(crash?.detail).toContain('[redacted]')
    expect(crash?.detail).not.toContain(blob)
    expect((crash?.detail ?? '').length).toBeLessThanOrEqual(200)
  })
})
