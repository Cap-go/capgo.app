import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { getBuildOnboardingRecoveryAdvice } from '../src/build/onboarding/recovery.ts'
import { CAPACITOR_SPLASH_SCREEN_PACKAGE, CAPGO_UPDATER_PACKAGE, getSplashScreenInstallState, getUpdaterInstallState } from '../src/init/updater.ts'
import { renderOnboardingSupportBundle, writeOnboardingSupportBundle } from '../src/onboarding-support.ts'
import { splitRunnerCommand } from '../src/runner-command.ts'

let failures = 0

function writeFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function withTempProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-updater-state-'))
  try {
    fn(root)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeProjectPackage(root, dependencies) {
  writeFile(join(root, 'package.json'), JSON.stringify({ dependencies }))
}

function writeUpdaterInstall(root, version = '7.0.1') {
  writeFile(join(root, 'node_modules', '@capgo', 'capacitor-updater', 'package.json'), JSON.stringify({ version }))
}

function writeSplashScreenInstall(root, version = '8.0.0') {
  writeFile(join(root, 'node_modules', '@capacitor', 'splash-screen', 'package.json'), JSON.stringify({ version }))
}

function readSplashScreenState(root) {
  return getSplashScreenInstallState(join(root, 'package.json'))
}

function readUpdaterState(root) {
  return getUpdaterInstallState(join(root, 'package.json'))
}

function t(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

t('build onboarding advice suggests platform creation commands', () => {
  const advice = getBuildOnboardingRecoveryAdvice('No ios/ directory found.', 'no-platform', 'bunx', 'com.example.app')
  if (!advice.commands.includes('bunx cap add ios'))
    throw new Error('Expected bunx cap add ios command in recovery advice')
  if (!advice.commands.includes('bunx cap sync ios'))
    throw new Error('Expected bunx cap sync ios command in recovery advice')
})

t('build onboarding advice suggests login and build request after missing auth', () => {
  const advice = getBuildOnboardingRecoveryAdvice('No Capgo API key found.', 'requesting-build', 'bunx', 'com.example.app')
  if (!advice.commands.includes('bunx @capgo/cli@latest login'))
    throw new Error('Expected login command in recovery advice')
  if (!advice.commands.includes('bunx @capgo/cli@latest build request com.example.app --platform ios'))
    throw new Error('Expected build request command in recovery advice')
})

t('build onboarding advice for an unsigned/expired Apple agreement points at the agreements page', () => {
  const advice = getBuildOnboardingRecoveryAdvice(
    'Apple is blocking App Store Connect API access because your developer account has a required agreement that is unsigned or has expired.',
    'verifying-key',
    'bunx',
    'com.example.app',
  )
  if (!advice.summary.some(line => line.toLowerCase().includes('required agreement')))
    throw new Error('Expected agreement-specific summary line')
  if (!advice.docs.includes('https://appstoreconnect.apple.com/agreements'))
    throw new Error('Expected the App Store Connect agreements page in docs')
  if (advice.summary.some(line => line.includes('Double-check the .p8')))
    throw new Error('Agreement errors must NOT surface the credential-checklist advice')
})

t('runner command helper rejects unexpected executors', () => {
  let threw = false
  try {
    splitRunnerCommand('sh -c')
  }
  catch {
    threw = true
  }

  if (!threw)
    throw new Error('Expected unsupported runner to throw')
})

t('updater install state requires package.json declaration', () => {
  withTempProject((root) => {
    writeProjectPackage(root, { '@capacitor/core': '^7.0.0' })
    writeUpdaterInstall(root)

    const state = readUpdaterState(root)
    if (state.ready)
      throw new Error('Expected updater state to fail without declaration')
    if (!state.details.some(detail => detail.includes(`Missing ${CAPGO_UPDATER_PACKAGE}`)))
      throw new Error('Expected missing declaration detail')
  })
})

t('updater install state requires node_modules install', () => {
  withTempProject((root) => {
    writeProjectPackage(root, {
      '@capacitor/core': '^7.0.0',
      [CAPGO_UPDATER_PACKAGE]: '^7.0.0',
    })

    const state = readUpdaterState(root)
    if (state.ready)
      throw new Error('Expected updater state to fail without node_modules install')
    if (!state.details.some(detail => detail.includes(`Cannot resolve ${CAPGO_UPDATER_PACKAGE}`)))
      throw new Error('Expected missing install detail')
  })
})

t('updater install state passes with declaration and install', () => {
  withTempProject((root) => {
    writeProjectPackage(root, {
      '@capacitor/core': '^7.0.0',
      [CAPGO_UPDATER_PACKAGE]: '^7.0.0',
    })
    writeUpdaterInstall(root)

    const state = readUpdaterState(root)
    if (!state.ready)
      throw new Error(`Expected updater state to pass: ${state.details.join(', ')}`)
    if (state.declaredVersion !== '^7.0.0')
      throw new Error('Expected declared updater version')
    if (state.installedVersion !== '7.0.1')
      throw new Error('Expected installed updater version')
  })
})

t('splash screen install state requires package.json declaration', () => {
  withTempProject((root) => {
    writeProjectPackage(root, { '@capacitor/core': '^8.0.0' })
    writeSplashScreenInstall(root)

    const state = readSplashScreenState(root)
    if (state.ready)
      throw new Error('Expected splash screen state to fail without declaration')
    if (!state.details.some(detail => detail.includes(`Missing ${CAPACITOR_SPLASH_SCREEN_PACKAGE}`)))
      throw new Error('Expected missing splash screen declaration detail')
  })
})

t('splash screen install state requires node_modules install', () => {
  withTempProject((root) => {
    writeProjectPackage(root, {
      '@capacitor/core': '^8.0.0',
      [CAPACITOR_SPLASH_SCREEN_PACKAGE]: '^8.0.0',
    })

    const state = readSplashScreenState(root)
    if (state.ready)
      throw new Error('Expected splash screen state to fail without node_modules install')
    if (!state.details.some(detail => detail.includes(`Cannot resolve ${CAPACITOR_SPLASH_SCREEN_PACKAGE}`)))
      throw new Error('Expected missing splash screen install detail')
  })
})

t('splash screen install state passes with declaration and install', () => {
  withTempProject((root) => {
    writeProjectPackage(root, {
      '@capacitor/core': '^8.0.0',
      [CAPACITOR_SPLASH_SCREEN_PACKAGE]: '^8.0.0',
    })
    writeSplashScreenInstall(root)

    const state = readSplashScreenState(root)
    if (!state.ready)
      throw new Error(`Expected splash screen state to pass: ${state.details.join(', ')}`)
    if (state.declaredVersion !== '^8.0.0')
      throw new Error('Expected declared splash screen version')
    if (state.installedVersion !== '8.0.0')
      throw new Error('Expected installed splash screen version')
  })
})

t('support bundle renderer includes commands and docs', () => {
  const output = renderOnboardingSupportBundle({
    kind: 'init',
    appId: 'com.example.app',
    currentStep: 'Step 4/12 · Add Integration Code',
    packageManager: 'bun',
    cwd: '/Users/example/project',
    error: 'Something failed',
    commands: ['bunx @capgo/cli@latest doctor'],
    docs: ['https://capgo.app/docs/getting-started/onboarding/'],
    sections: [{ title: 'Context', lines: ['line one'] }],
    logs: ['log one'],
  })

  if (!output.includes('bunx @capgo/cli@latest doctor'))
    throw new Error('Expected command in support bundle output')
  if (!output.includes('https://capgo.app/docs/getting-started/onboarding/'))
    throw new Error('Expected docs URL in support bundle output')
  if (!output.includes('Current step: Step 4/12 · Add Integration Code'))
    throw new Error('Expected current step in support bundle output')
})

t('support bundle writer persists a file', () => {
  const originalHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'capgo-home-'))
  process.env.HOME = home
  try {
    const filePath = writeOnboardingSupportBundle({
      kind: 'build-init',
      appId: 'com.example.app',
      error: 'broken',
    })

    if (!filePath)
      throw new Error('Expected support bundle file path')
    if (!existsSync(filePath))
      throw new Error('Expected support bundle file to exist')

    const contents = readFileSync(filePath, 'utf8')
    if (!contents.includes('Capgo build-init support bundle'))
      throw new Error('Expected support bundle header in file')
  }
  finally {
    rmSync(home, { recursive: true, force: true })
    if (originalHome === undefined)
      delete process.env.HOME
    else
      process.env.HOME = originalHome
  }
})

t('support bundle writer fails safely when the home path is not writable', () => {
  const blockedDir = mkdtempSync(join(tmpdir(), 'capgo-support-blocked-'))
  const blockedPath = join(blockedDir, 'not-a-directory')
  writeFileSync(blockedPath, 'not-a-directory', 'utf8')

  const filePath = writeOnboardingSupportBundle({
    kind: 'init',
    appId: 'com.example.app',
    error: 'broken',
  }, blockedPath)

  if (filePath !== null)
    throw new Error('Expected support bundle writer to fail safely')

  rmSync(blockedDir, { recursive: true, force: true })
})

if (failures > 0) {
  console.error(`\n❌ ${failures} onboarding recovery test(s) failed`)
  process.exit(1)
}

console.log('\n✅ onboarding recovery tests passed')
