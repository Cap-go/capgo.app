import assert from 'node:assert/strict'
import { buildRenameWorkspaceFiles, isAndroidStudioRunning, TRAPEZE_PROJECT_VERSION, verifyRenamed } from '../src/build/onboarding/android/android-rename.ts'

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

// ─── buildRenameWorkspaceFiles ─────────────────────────────────────────────

t('buildRenameWorkspaceFiles emits a type:module package.json with a pinned Trapeze dep', () => {
  const { packageJson } = buildRenameWorkspaceFiles('ee.forgr.app', 'android')
  const parsed = JSON.parse(packageJson)
  assert.equal(parsed.type, 'module')
  assert.equal(parsed.devDependencies['@trapezedev/project'], TRAPEZE_PROJECT_VERSION)
  // Pinned exactly — no range specifier so the rename behavior is reproducible.
  assert.ok(/^\d+\.\d+\.\d+$/.test(TRAPEZE_PROJECT_VERSION), 'version must be exact (x.y.z)')
})

t('buildRenameWorkspaceFiles emits a rename.mjs that reads the appId from argv', () => {
  const { renameMjs } = buildRenameWorkspaceFiles('ee.forgr.app', 'android')
  assert.match(renameMjs, /process\.argv\[2\]/)
  // The appId is NOT interpolated into the script — it always flows in via argv.
  assert.ok(!renameMjs.includes('ee.forgr.app'), 'package must not be templated into the script')
})

t('buildRenameWorkspaceFiles always calls all three setters in order', () => {
  const { renameMjs } = buildRenameWorkspaceFiles('ee.forgr.app', 'android')
  const iPkg = renameMjs.indexOf('setPackageName(appId)')
  const iAppId = renameMjs.indexOf('setApplicationId(appId)')
  const iNs = renameMjs.indexOf('setNamespace(appId)')
  assert.ok(iPkg >= 0, 'must call setPackageName')
  assert.ok(iAppId >= 0, 'must call setApplicationId')
  assert.ok(iNs >= 0, 'must call setNamespace — never skipped (AGP 8 requires it)')
  assert.ok(iPkg < iAppId && iAppId < iNs, 'setters must run in order: package → applicationId → namespace')
  assert.match(renameMjs, /project\.commit\(\)/)
  assert.match(renameMjs, /@trapezedev\/project/)
})

t('buildRenameWorkspaceFiles bakes the resolved android dir into the MobileProject config', () => {
  const { renameMjs } = buildRenameWorkspaceFiles('ee.forgr.app', 'android')
  // The configured native path is JSON-escaped into the MobileProject config.
  assert.ok(renameMjs.includes('path: "android"'), 'default android dir must be in the MobileProject config')
})

t('buildRenameWorkspaceFiles honors a NON-default android dir (configured platform path)', () => {
  const androidDir = 'apps/mobile/platforms/android-native'
  const { renameMjs } = buildRenameWorkspaceFiles('ee.forgr.app', androidDir)
  // The configured path is baked in verbatim, never the hardcoded ./android, so
  // Trapeze edits the right native project (P1: stale ./android must not be hit).
  assert.ok(renameMjs.includes(`path: ${JSON.stringify(androidDir)}`), 'must target the configured androidDir')
  assert.ok(!renameMjs.includes('path: "android"'), 'must NOT fall back to the default android dir')
})

// ─── isAndroidStudioRunning ────────────────────────────────────────────────

t('isAndroidStudioRunning reports running on darwin when pgrep output is non-empty', () => {
  assert.equal(isAndroidStudioRunning('darwin', '4321\n'), 'running')
  assert.equal(isAndroidStudioRunning('darwin', '  812  '), 'running')
})

t('isAndroidStudioRunning reports not-running on darwin when pgrep output is empty', () => {
  assert.equal(isAndroidStudioRunning('darwin', ''), 'not-running')
  assert.equal(isAndroidStudioRunning('darwin', '   \n  '), 'not-running')
})

t('isAndroidStudioRunning reports unknown on non-darwin platforms regardless of output', () => {
  assert.equal(isAndroidStudioRunning('win32', '4321'), 'unknown')
  assert.equal(isAndroidStudioRunning('linux', ''), 'unknown')
  assert.equal(isAndroidStudioRunning('linux', '999'), 'unknown')
})

// ─── verifyRenamed ─────────────────────────────────────────────────────────

t('verifyRenamed returns true when the target is among the gradle ids', () => {
  assert.equal(verifyRenamed(['ee.forgr.app', 'ee.forgr.app.dev'], 'ee.forgr.app'), true)
})

t('verifyRenamed returns false when the target is absent (never claim false success)', () => {
  assert.equal(verifyRenamed(['ee.forgr.old'], 'ee.forgr.app'), false)
  assert.equal(verifyRenamed([], 'ee.forgr.app'), false)
})

console.log('OK')
