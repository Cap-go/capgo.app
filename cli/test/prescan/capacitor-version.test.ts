// test/prescan/capacitor-version.test.ts
import { describe, expect, it } from 'bun:test'
import { capacitorMajor } from '../../src/build/prescan/capacitor-version'
import { makeProject } from './helpers'

function pkg(deps: Record<string, string>, devDeps: Record<string, string> = {}) {
  return JSON.stringify({ dependencies: deps, devDependencies: devDeps })
}

describe('capacitor-version: capacitorMajor', () => {
  it('reads the major from @capacitor/core', () => {
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/core': '^8.3.1' }) })
    expect(capacitorMajor(dir)).toBe(8)
  })

  it('falls back to @capacitor/ios when core is absent', () => {
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/ios': '~7.2.0' }) })
    expect(capacitorMajor(dir)).toBe(7)
  })

  it('falls back to @capacitor/android when core and ios are absent', () => {
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/android': '6.1.2' }) })
    expect(capacitorMajor(dir)).toBe(6)
  })

  it('prefers @capacitor/core over ios/android', () => {
    const dir = makeProject({ 'package.json': pkg({
      '@capacitor/core': '8.0.0',
      '@capacitor/ios': '7.0.0',
      '@capacitor/android': '6.0.0',
    }) })
    expect(capacitorMajor(dir)).toBe(8)
  })

  it('reads from devDependencies too', () => {
    const dir = makeProject({ 'package.json': pkg({}, { '@capacitor/core': '^8.3.1' }) })
    expect(capacitorMajor(dir)).toBe(8)
  })

  it('prefers dependencies over devDependencies for the same package', () => {
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/core': '^8.0.0' }, { '@capacitor/core': '^7.0.0' }) })
    expect(capacitorMajor(dir)).toBe(8)
  })

  it('returns null when package.json is absent', () => {
    const dir = makeProject({})
    expect(capacitorMajor(dir)).toBeNull()
  })

  it('returns null when package.json is malformed (never throws)', () => {
    const dir = makeProject({ 'package.json': '{ not json' })
    expect(capacitorMajor(dir)).toBeNull()
  })

  it('returns null when a Capacitor dependency range is not a string (never throws)', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ dependencies: { '@capacitor/core': 8 } }) })
    expect(capacitorMajor(dir)).toBeNull()
  })

  it('returns null when no capacitor dependency is present', () => {
    const dir = makeProject({ 'package.json': pkg({ react: '^19.0.0' }) })
    expect(capacitorMajor(dir)).toBeNull()
  })

  it('parses the leading integer from a complex range', () => {
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/core': '>=8.3.1 <9.0.0' }) })
    expect(capacitorMajor(dir)).toBe(8)
  })

  it('grounds clean against a real-shaped Capacitor-8 project (inline fixture)', () => {
    // Self-contained inline fixture mirroring the real tutorial-app package.json
    // Capacitor-8 dependency, so the grounding is REAL on CI (the external
    // tutorial-app checkout does not exist there; reading it returned null and
    // failed this assertion, not a meaningful grounding).
    const dir = makeProject({ 'package.json': pkg({ '@capacitor/core': '^8.0.0', '@capacitor/ios': '^8.0.0' }) })
    expect(capacitorMajor(dir)).toBe(8)
  })
})
