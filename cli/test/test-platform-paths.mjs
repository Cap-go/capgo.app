import assert from 'node:assert/strict'
import { getPlatformDirFromCapacitorConfig, normalizeNativeDependencyPathsInText, normalizeRelPath } from '../src/build/platform-paths.ts'

function t(name, fn) {
  try {
    fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n`)
    throw e
  }
}

t('normalizeRelPath strips trailing slashes', () => {
  assert.equal(normalizeRelPath('android/'), 'android')
  assert.equal(normalizeRelPath('projects/app/android////'), 'projects/app/android')
})

t('normalizeRelPath strips leading ./', () => {
  assert.equal(normalizeRelPath('./android'), 'android')
  assert.equal(normalizeRelPath('././android/'), 'android')
})

t('normalizeRelPath normalizes windows separators', () => {
  assert.equal(normalizeRelPath('projects\\app\\android\\'), 'projects/app/android')
  assert.equal(normalizeRelPath('projects\\\\app\\\\android\\\\'), 'projects/app/android')
})

t('normalizeRelPath returns empty for "."', () => {
  assert.equal(normalizeRelPath('.'), '')
  assert.equal(normalizeRelPath('./'), '')
  assert.equal(normalizeRelPath('  .  '), '')
})

t('getPlatformDirFromCapacitorConfig uses configured path', () => {
  assert.equal(
    getPlatformDirFromCapacitorConfig({ android: { path: 'projects/app/android' } }, 'android'),
    'projects/app/android',
  )
})

t('getPlatformDirFromCapacitorConfig falls back on "."', () => {
  assert.equal(
    getPlatformDirFromCapacitorConfig({ android: { path: '.' } }, 'android'),
    'android',
  )
})


t('normalizeNativeDependencyPathsInText fixes Windows separators in SPM paths', () => {
  const input = 'let package = Package(dependencies: [.package(name: "CapacitorApp", path: "..\\..\\..\\node_modules\\@capacitor\\app")])'
  const expected = 'let package = Package(dependencies: [.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")])'
  assert.equal(normalizeNativeDependencyPathsInText(input), expected)
})

t('normalizeNativeDependencyPathsInText fixes Windows separators in CocoaPods and Gradle paths', () => {
  const input = [
    "pod 'CapacitorApp', :path => '..\\node_modules\\@capacitor\\app'",
    "project(':capacitor-app').projectDir = new File('..\\node_modules\\@capacitor\\app\\android')",
  ].join('\n')
  const expected = [
    "pod 'CapacitorApp', :path => '../node_modules/@capacitor/app'",
    "project(':capacitor-app').projectDir = new File('../node_modules/@capacitor/app/android')",
  ].join('\n')
  assert.equal(normalizeNativeDependencyPathsInText(input), expected)
})


process.stdout.write('OK\n')
