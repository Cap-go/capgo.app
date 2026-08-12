#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyInitAutoTestChange,
  beginFreshInitProgress,
  captureInitGitSnapshot,
  classifyInitGitChanges,
  createInitGitChangeScope,
  declineInitProgressResume,
  discardResumedInitProgress,
  ensureGitRepoCleanBeforeInit,
  getDirtyGitStatusActionOptions,
  getGitRepoStatus,
  getInitProgressStateForTesting,
  getInitOtaVersionBase,
  getInitSuggestedOtaVersion,
  getInitUpdaterPluginConfig,
  getResumedOnboardingAccessError,
  getNativePlatformAvailability,
  injectInitCode,
  isSuccessfulInitCommandResult,
  isSuccessfulInitProcessResult,
  isOnlyAllowedInitAutoTestChange,
  mergeInitGitChanges,
  parseInitGitChanges,
  restoreInitProgressState,
  resolveInitNativeResetTarget,
  revertInitAutoTestChangeContent,
  runInheritedCommand,
  runTrackedInitMutation,
  trackInitGitChanges,
  tryResumeOnboarding,
} from '../src/init/command.ts'
import {
  createMissingExecutableError,
  getAvailablePackageManagers,
  getMissingPackageManagerExecutable,
  getPackageManagerInfo,
  isPackageManagerAvailable,
  preparePackageManagerCommandEnvironment,
  probeExecutable,
  resolveExecutableProbeError,
  supportsYarnDlx,
  waitForCommandResult,
} from '../src/init/command-execution.ts'
import { usesAlwaysDirectUpdate } from '../src/updaterConfig.ts'
import { getPMAndCommand, setPMAndCommand } from '../src/utils.ts'

let failures = 0

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-init-guardrails-'))
  try {
    fn(root)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function withTempDirAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-init-guardrails-'))
  try {
    await fn(root)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function initializeGitRepo(root, files) {
  execSync('git init', { cwd: root, stdio: 'ignore' })
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' })
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'ignore' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'ignore' })
  for (const [filePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, filePath)), { recursive: true })
    writeFileSync(join(root, filePath), content, 'utf8')
  }
  execSync('git add .', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' })
}

function getRawInitGitStatus(root) {
  return execSync('git -c status.renames=copies status --porcelain=v2 -z --untracked-files=all', {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tryCreateTestSymlink(target, filePath) {
  try {
    symlinkSync(target, filePath)
    return true
  }
  catch (error) {
    if (['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error?.code))
      return false
    throw error
  }
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

t('command probe reports executables missing from PATH', () => {
  const result = probeExecutable('__capgo_missing_package_manager__', { env: { PATH: '' } })

  assert.equal(result.available, false)
  assert.equal(result.error?.code, 'ENOENT')
})

t('command probe rejects executables whose version check fails', () => {
  const result = probeExecutable(process.execPath, { args: ['-e', 'process.exit(7)'] })

  assert.equal(result.available, false)
  assert.equal(result.status, 7)
})

t('command probe times out an unresponsive executable', () => {
  const result = probeExecutable(process.execPath, {
    args: ['-e', 'setTimeout(() => {}, 1_000)'],
    timeoutMs: 20,
  })

  assert.equal(result.available, false)
  assert.equal(result.error?.code, 'ETIMEDOUT')
})

t('package manager probes and commands share the Corepack environment', () => {
  const commandEnvironment = { PATH: '/usr/bin' }

  assert.equal(preparePackageManagerCommandEnvironment(commandEnvironment), commandEnvironment)
  assert.equal(commandEnvironment.COREPACK_ENABLE_PROJECT_SPEC, '0')
})

t('missing executable error explains the PATH mismatch', () => {
  const error = createMissingExecutableError('bun', '/usr/local/bin:/usr/bin')

  assert.equal(error.code, 'ENOENT')
  assert.match(error.message, /Cannot find executable "bun" in PATH/)
  assert.match(error.message, /\/usr\/local\/bin:\/usr\/bin/)
})

t('package manager discovery returns only installed alternatives', () => {
  const available = getAvailablePackageManagers('bun', command => ['npm', 'npx', 'pnpm', 'pnpm exec'].includes(command))

  assert.deepEqual(available, ['npm', 'pnpm'])
})

t('package manager availability includes its Capacitor runner', () => {
  assert.equal(isPackageManagerAvailable('npm', command => command === 'npm'), false)
  assert.equal(isPackageManagerAvailable('npm', command => command === 'npm' || command === 'npx'), true)
  assert.equal(getMissingPackageManagerExecutable('npm', command => command === 'npm'), 'npx')
  assert.equal(getMissingPackageManagerExecutable('npm', command => command === 'npm' || command === 'npx'), undefined)
  assert.equal(getMissingPackageManagerExecutable('yarn', command => command === 'yarn'), 'yarn dlx')
  assert.equal(getMissingPackageManagerExecutable('yarn', command => command === 'yarn' || command === 'yarn dlx'), undefined)
})

t('Yarn dlx availability rejects Yarn Classic', () => {
  assert.equal(supportsYarnDlx('1.22.22'), false)
  assert.equal(supportsYarnDlx('2.0.0'), true)
  assert.equal(supportsYarnDlx('4.10.3'), true)
  assert.equal(supportsYarnDlx('not-a-version'), false)
})

t('probe error resolution preserves runner incompatibility details', () => {
  const compatibilityError = new Error('Runner "yarn dlx" requires Yarn 2 or newer.')
  const resolved = resolveExecutableProbeError('yarn dlx', {
    available: false,
    error: compatibilityError,
    status: 0,
  })

  assert.equal(resolved, compatibilityError)
})

t('package manager metadata uses matching direct commands and runners', () => {
  assert.deepEqual(getPackageManagerInfo('npm'), {
    pm: 'npm',
    command: 'install',
    installCommand: 'npm install',
    runner: 'npx',
  })
  assert.deepEqual(getPackageManagerInfo('pnpm'), {
    pm: 'pnpm',
    command: 'install',
    installCommand: 'pnpm install',
    runner: 'pnpm exec',
  })
  assert.deepEqual(getPackageManagerInfo('yarn'), {
    pm: 'yarn',
    command: 'install',
    installCommand: 'yarn install',
    runner: 'yarn dlx',
  })
  assert.deepEqual(getPackageManagerInfo('bun'), {
    pm: 'bun',
    command: 'install',
    installCommand: 'bun install',
    runner: 'bunx',
  })
})

t('selected package manager persists for later onboarding commands', () => {
  const original = getPMAndCommand()
  const fallback = getPackageManagerInfo('npm')

  try {
    setPMAndCommand(fallback)
    assert.deepEqual(getPMAndCommand(), fallback)
  }
  finally {
    setPMAndCommand(original)
  }
})

t('git status helper skips non-git folders', () => {
  withTempDir((root) => {
    const status = getGitRepoStatus(root)
    assert.equal(status.inRepo, false)
    assert.equal(status.clean, true)
    assert.deepEqual(status.entries, [])
  })
})

t('native platform availability honors custom Capacitor platform directories', () => {
  withTempDir((root) => {
    mkdirSync(join(root, 'native', 'android-app'), { recursive: true })
    const availability = getNativePlatformAvailability({
      ios: { path: 'native/apple-app' },
      android: { path: 'native/android-app' },
    }, root)

    assert.equal(availability.ios, false)
    assert.equal(availability.android, true)
  })
})

t('git mutation scopes canonicalize symlinked working directories and fail closed', () => {
  withTempDir((root) => {
    const repoRoot = join(root, 'repo')
    const projectDir = join(repoRoot, 'packages', 'app')
    mkdirSync(projectDir, { recursive: true })
    initializeGitRepo(repoRoot, {
      'packages/app/capacitor.config.ts': 'export default {}\n',
      'packages/app/package.json': '{"name":"app"}\n',
    })

    assert.deepEqual(createInitGitChangeScope(join(root, 'missing'), ['package.json']), {
      exactPaths: [],
      directoryPrefixes: [],
    })

    const linkedProjectDir = join(root, 'linked-app')
    if (!tryCreateTestSymlink(projectDir, linkedProjectDir))
      return

    assert.deepEqual(createInitGitChangeScope(linkedProjectDir, [
      'package.json',
      join(linkedProjectDir, 'capacitor.config.ts'),
    ], [join(linkedProjectDir, 'ios')]), {
      exactPaths: ['packages/app/package.json', 'packages/app/capacitor.config.ts'],
      directoryPrefixes: ['packages/app/ios'],
    })
    assert.deepEqual(createInitGitChangeScope(linkedProjectDir, [join(root, 'outside.txt')]), {
      exactPaths: [],
      directoryPrefixes: [],
    })
  })
})

t('git status helper detects clean and dirty repos', () => {
  withTempDir((root) => {
    execSync('git init', { cwd: root, stdio: 'ignore' })

    const cleanStatus = getGitRepoStatus(root)
    assert.equal(cleanStatus.inRepo, true)
    assert.equal(cleanStatus.clean, true)
    assert.deepEqual(cleanStatus.entries, [])

    writeFileSync(join(root, 'dirty.txt'), 'dirty\n', 'utf8')

    const dirtyStatus = getGitRepoStatus(root)
    assert.equal(dirtyStatus.inRepo, true)
    assert.equal(dirtyStatus.clean, false)
    assert.ok(dirtyStatus.entries.some(entry => entry.includes('dirty.txt')))
  })
})

t('dirty git status prompt keeps clean repo as the recommended path', () => {
  const options = getDirtyGitStatusActionOptions()

  assert.equal(options[0]?.value, 'check-again')
  assert.match(options[0]?.hint ?? '', /recommended/)
  assert.equal(options[1]?.value, 'continue-dirty')
  assert.match(options[1]?.hint ?? '', /not recommended/)
})

t('init code injection preserves framework directives before imports', () => {
  const updated = injectInitCode('src/main.tsx', `'use client'\n\nexport default function App() {}\n`)

  assert.match(updated, /^'use client'\nimport \{ CapacitorUpdater \}/)
  assert.match(updated, /CapacitorUpdater\.notifyAppReady\(\);/)
})

t('init code injection preserves directives after BOM and leading comments', () => {
  const updated = injectInitCode('src/main.tsx', `\uFEFF/* generated file */\n\n'use client'\nexport default function App() {}\n`)

  assert.match(updated, /^\uFEFF\/\* generated file \*\/\n\n'use client'\nimport \{ CapacitorUpdater \}/)
})

t('init code injection preserves directives with trailing comments', () => {
  const updated = injectInitCode('src/main.tsx', `'use client' // required by Next.js\nexport default function App() {}\n`)

  assert.match(updated, /^'use client' \/\/ required by Next\.js\nimport \{ CapacitorUpdater \}/)
})

t('init code injection uses CommonJS syntax for .cjs files without imports', () => {
  const updated = injectInitCode('scripts/start.cjs', 'console.log(\'ready\')\n')

  assert.match(updated, /^const \{ CapacitorUpdater \} = require\('@capgo\/capacitor-updater'\);/)
  assert.doesNotMatch(updated, /^import /m)
})

t('init code injection reuses an existing CommonJS updater binding', () => {
  const updated = injectInitCode('scripts/start.cjs', `const { CapacitorUpdater } = require('@capgo/capacitor-updater')\nconsole.log('ready')\n`)

  assert.equal((updated.match(/const \{ CapacitorUpdater \}/g) ?? []).length, 1)
  assert.match(updated, /CapacitorUpdater\.notifyAppReady\(\);/)
})

t('git status helper reports git status failures inside a repo', () => {
  withTempDir((root) => {
    execSync('git init', { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, '.git', 'index'), 'not-a-real-index', 'utf8')

    const status = getGitRepoStatus(root)
    assert.equal(status.inRepo, true)
    assert.equal(status.clean, false)
    assert.equal(status.entries.length, 0)
    assert.ok(status.error)
  })
})

t('init updater config always starts from native version 0.0.0', () => {
  assert.deepEqual(getInitUpdaterPluginConfig('com.example.app', false), {
    version: '0.0.0',
    appId: 'com.example.app',
    autoUpdate: 'atBackground',
  })

  assert.deepEqual(getInitUpdaterPluginConfig('com.example.app', true), {
    version: '0.0.0',
    appId: 'com.example.app',
    autoUpdate: 'always',
    autoSplashscreen: true,
  })
})

t('instant update detection supports new autoUpdate modes and legacy directUpdate', () => {
  assert.equal(usesAlwaysDirectUpdate({ autoUpdate: 'always' }), true)
  assert.equal(usesAlwaysDirectUpdate({ autoUpdate: 'atBackground', directUpdate: 'always' }), false)
  assert.equal(usesAlwaysDirectUpdate({ autoUpdate: 'onlyDownload', directUpdate: true }), false)
  assert.equal(usesAlwaysDirectUpdate({ autoUpdate: false, directUpdate: true }), false)
  assert.equal(usesAlwaysDirectUpdate({ autoUpdate: true, directUpdate: true }), true)
  assert.equal(usesAlwaysDirectUpdate({ directUpdate: 'always' }), true)
  assert.equal(usesAlwaysDirectUpdate({ directUpdate: 'onLaunch' }), false)
})

t('guided ota version suggestions stay on major zero when native baseline is pinned', () => {
  assert.equal(getInitOtaVersionBase('1.0.0'), '0.0.0')
  assert.equal(getInitSuggestedOtaVersion('1.0.0'), '0.0.1')

  assert.equal(getInitOtaVersionBase('0.2.3'), '0.2.3')
  assert.equal(getInitSuggestedOtaVersion('0.2.3'), '0.2.4')
})

t('resuming onboarding requires the current key to retain saved org and app access', () => {
  const resume = { stepDone: 4, orgId: 'org_123', orgName: 'Saved org', appId: 'com.example.app' }
  const organization = { gid: 'org_123', name: 'Saved org' }

  assert.match(getResumedOnboardingAccessError(resume, undefined, false, false), /organization.*no longer available/i)
  assert.equal(getResumedOnboardingAccessError(resume, organization, false, true), undefined)
  assert.match(getResumedOnboardingAccessError(resume, organization, true, false), /app.*no longer available/i)
  assert.equal(getResumedOnboardingAccessError(resume, organization, true, true), undefined)
  assert.match(getResumedOnboardingAccessError({ ...resume, appId: undefined }, organization, false, true), /permission to create apps/i)
  assert.match(getResumedOnboardingAccessError(resume, { ...organization, enforcing_2fa: true, '2fa_has_access': false }, true, true), /requires 2FA/i)
})

t('auto html onboarding changes can be applied and reverted', () => {
  const original = '<body>\n  <main>Hello</main>\n</body>\n'
  const applied = applyInitAutoTestChange('index.html', original)
  assert.ok(applied)
  assert.equal(applied.kind, 'html-banner')
  assert.ok(applied.content.includes('capgo-test-banner'))
  assert.equal(revertInitAutoTestChangeContent(applied.kind, applied.content), original)
})

t('auto vue onboarding changes can be applied and reverted', () => {
  const original = '<template>\n  <AppShell />\n</template>\n'
  const applied = applyInitAutoTestChange('src/App.vue', original)
  assert.ok(applied)
  assert.equal(applied.kind, 'vue-banner')
  assert.ok(applied.content.includes('capgo-test-vue'))
  assert.equal(revertInitAutoTestChangeContent(applied.kind, applied.content), original)
})

t('auto css onboarding changes can be applied and reverted', () => {
  const original = 'body { color: red; }\n'
  const applied = applyInitAutoTestChange('src/main.css', original)
  assert.ok(applied)
  assert.equal(applied.kind, 'css-background')
  assert.ok(applied.content.includes('capgo-test-background'))
  assert.equal(revertInitAutoTestChangeContent(applied.kind, applied.content), original)
})

t('auto css onboarding changes preserve leading css header rules', () => {
  const original = '@charset "UTF-8";\n@import url("./base.css");\nbody { color: red; }\n'
  const applied = applyInitAutoTestChange('src/main.css', original)
  assert.ok(applied)
  assert.equal(applied.kind, 'css-background')
  assert.ok(applied.content.startsWith('@charset "UTF-8";\n@import url("./base.css");\n/* Capgo test modification - background change */'))
  assert.equal(revertInitAutoTestChangeContent(applied.kind, applied.content), original)
})

t('resume allowlist only accepts the exact cli-managed test diff', () => {
  withTempDir((root) => {
    const original = 'body { color: red; }\n'
    initializeGitRepo(root, { 'src/main.css': original })
    const filePath = join(root, 'src', 'main.css')

    const applied = applyInitAutoTestChange(filePath, original)
    assert.ok(applied)
    writeFileSync(filePath, applied.content, 'utf8')

    const allowedStatus = getGitRepoStatus(root)
    assert.equal(isOnlyAllowedInitAutoTestChange(allowedStatus, {
      filePath,
      displayPath: 'src/main.css',
      kind: applied.kind,
    }), true)

    writeFileSync(filePath, `${applied.content}/* extra edit */\n`, 'utf8')

    const extraEditStatus = getGitRepoStatus(root)
    assert.equal(isOnlyAllowedInitAutoTestChange(extraEditStatus, {
      filePath,
      displayPath: 'src/main.css',
      kind: applied.kind,
    }), false)
  })
})

t('git fingerprints attribute only files changed during the onboarding mutation window', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'src/main.ts': 'console.log(\'initial\')\n',
      'package.json': '{"name":"example","dependencies":{}}\n',
      'package-lock.json': '{"name":"example","lockfileVersion":3}\n',
    })

    writeFileSync(join(root, 'src', 'main.ts'), 'console.log(\'user edit\')\n', 'utf8')
    const before = captureInitGitSnapshot(root)
    assert.ok(before)

    writeFileSync(join(root, 'package.json'), '{"name":"example","dependencies":{"@capgo/capacitor-updater":"latest"}}\n', 'utf8')
    writeFileSync(join(root, 'package-lock.json'), '{"name":"example","lockfileVersion":3,"packages":{"capgo":{}}}\n', 'utf8')
    const after = captureInitGitSnapshot(root)
    assert.ok(after)

    const saved = mergeInitGitChanges(undefined, before, after)
    assert.ok(saved)
    assert.deepEqual(Object.keys(saved.files).sort(), ['package-lock.json', 'package.json'])

    const classification = classifyInitGitChanges(after, saved)
    assert.deepEqual(classification.unsafePaths, ['src/main.ts'])
    assert.equal(classification.recognizedCount, 2)
    assert.deepEqual(Object.keys(classification.retained?.files ?? {}).sort(), ['package-lock.json', 'package.json'])
  })
})

t('git snapshot fingerprints a deleted regular file with null content and mode', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'deleted.txt': 'tracked\n' })

    unlinkSync(join(root, 'deleted.txt'))

    const snapshot = captureInitGitSnapshot(root)
    assert.ok(snapshot)
    assert.deepEqual(snapshot.files['deleted.txt'], {
      status: ' D',
      sha256: null,
      mode: null,
    })
  })
})

t('git snapshot handles mixed tracked, untracked, and staged-deleted paths together', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'src/tracked file.ts': 'initial\n',
      'old file ü.txt': 'delete me\n',
    })

    unlinkSync(join(root, 'old file ü.txt'))
    execSync('git add -u', { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'src', 'tracked file.ts'), 'modified\n', 'utf8')
    writeFileSync(join(root, 'new file é.txt'), 'untracked\n', 'utf8')

    const snapshot = captureInitGitSnapshot(root)
    assert.ok(snapshot)
    assert.deepEqual(Object.keys(snapshot.files).sort(), ['new file é.txt', 'old file ü.txt', 'src/tracked file.ts'])
    assert.deepEqual(snapshot.files['old file ü.txt'], { status: 'D ', sha256: null, mode: null })
    assert.equal(snapshot.files['src/tracked file.ts']?.status, ' M')
    assert.equal(typeof snapshot.files['src/tracked file.ts']?.sha256, 'string')
    assert.equal(typeof snapshot.files['src/tracked file.ts']?.mode, 'number')
    assert.equal(snapshot.files['new file é.txt']?.status, '??')
    assert.equal(typeof snapshot.files['new file é.txt']?.sha256, 'string')
    assert.equal(typeof snapshot.files['new file é.txt']?.mode, 'number')
  })
})

t('git snapshot rejects file metadata changed during hashing', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'tracked file ü.txt': 'initial\n' })
    const filePath = join(root, 'tracked file ü.txt')
    writeFileSync(filePath, 'modified\n', 'utf8')
    const statusOutput = getRawInitGitStatus(root)
    const stable = lstatSync(filePath, { bigint: true })
    const changed = {
      dev: stable.dev,
      ino: stable.ino,
      size: stable.size,
      mode: stable.mode,
      mtimeNs: stable.mtimeNs + 1n,
      ctimeNs: stable.ctimeNs,
      isFile: () => true,
    }
    let readCompleted = false

    const snapshot = captureInitGitSnapshot(root, undefined, {
      runStatus: () => statusOutput,
      lstat: () => readCompleted ? changed : stable,
      readFile: (target) => {
        const content = readFileSync(target)
        readCompleted = true
        return content
      },
    })

    assert.equal(snapshot, undefined)
  })
})

t('git snapshot rejects a changed second status result', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'tracked file ü.txt': 'initial\n' })
    writeFileSync(join(root, 'tracked file ü.txt'), 'modified\n', 'utf8')
    const statusOutput = getRawInitGitStatus(root)
    let statusCalls = 0

    const snapshot = captureInitGitSnapshot(root, undefined, {
      runStatus: () => statusCalls++ === 0
        ? statusOutput
        : Buffer.concat([statusOutput, Buffer.from('? changed after hashing.txt\0')]),
    })

    assert.equal(snapshot, undefined)
    assert.equal(statusCalls, 2)
  })
})

t('git snapshot accepts stable metadata and status for raw whitespace and Unicode paths', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'tracked file.txt': 'initial\n',
      'tracked ü.txt': 'initial\n',
    })
    writeFileSync(join(root, 'tracked file.txt'), 'modified\n', 'utf8')
    writeFileSync(join(root, 'tracked ü.txt'), 'modified\n', 'utf8')
    const statusOutput = getRawInitGitStatus(root)
    let statusCalls = 0

    const snapshot = captureInitGitSnapshot(root, undefined, {
      runStatus: () => {
        statusCalls += 1
        return statusOutput
      },
    })

    assert.ok(snapshot)
    assert.deepEqual(Object.keys(snapshot.files).sort(), ['tracked file.txt', 'tracked ü.txt'])
    assert.equal(statusCalls, 2)
  })
})

t('scoped git snapshot rejects an entry count above its hashing limit', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'native/one.txt': 'initial one\n',
      'native/two.txt': 'initial two\n',
    })
    writeFileSync(join(root, 'native', 'one.txt'), 'changed one\n', 'utf8')
    writeFileSync(join(root, 'native', 'two.txt'), 'changed two\n', 'utf8')
    let readCount = 0

    const snapshot = captureInitGitSnapshot(root, { directoryPrefixes: ['native'] }, {
      limits: { maxEntries: 1, maxTotalBytes: 1024 },
      readFile: (target) => {
        readCount += 1
        return readFileSync(target)
      },
    })

    assert.equal(snapshot, undefined)
    assert.equal(readCount, 0)
  })
})

t('scoped git snapshot rejects total file bytes above its hashing limit', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'native/one.txt': 'initial one\n',
      'native/two.txt': 'initial two\n',
    })
    writeFileSync(join(root, 'native', 'one.txt'), '1234', 'utf8')
    writeFileSync(join(root, 'native', 'two.txt'), '5678', 'utf8')

    const snapshot = captureInitGitSnapshot(root, { directoryPrefixes: ['native'] }, {
      limits: { maxEntries: 2, maxTotalBytes: 7 },
    })

    assert.equal(snapshot, undefined)
  })
})

t('scoped git snapshot fingerprints a small tree within its hashing limits', () => {
  withTempDir((root) => {
    initializeGitRepo(root, {
      'native/one.txt': 'initial one\n',
      'native/two.txt': 'initial two\n',
    })
    writeFileSync(join(root, 'native', 'one.txt'), '1234', 'utf8')
    writeFileSync(join(root, 'native', 'two.txt'), '5678', 'utf8')

    const snapshot = captureInitGitSnapshot(root, { directoryPrefixes: ['native'] }, {
      limits: { maxEntries: 2, maxTotalBytes: 8 },
    })

    assert.deepEqual(Object.keys(snapshot?.files ?? {}).sort(), ['native/one.txt', 'native/two.txt'])
  })
})

t('git snapshot declines unsupported symlinks and renames', () => {
  withTempDir((root) => {
    execSync('git init', { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'target.txt'), 'target\n', 'utf8')
    if (!tryCreateTestSymlink('target.txt', join(root, 'link.txt')))
      return

    assert.equal(captureInitGitSnapshot(root), undefined)
  })

  withTempDir((root) => {
    initializeGitRepo(root, { 'before.txt': 'tracked\n' })
    execSync('git mv before.txt after.txt', { cwd: root, stdio: 'ignore' })

    const status = getGitRepoStatus(root)
    assert.deepEqual(status.entries, ['R  before.txt -> after.txt'])
    assert.deepEqual(status.fileEntries, [{ status: 'R ', filePath: 'after.txt', display: 'R  before.txt -> after.txt' }])
    assert.equal(captureInitGitSnapshot(root), undefined)
  })
})

t('git snapshot declines a tracked symlink changed into a regular file', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'target.txt': 'target\n' })
    execSync('git config core.symlinks true', { cwd: root, stdio: 'ignore' })
    if (!tryCreateTestSymlink('target.txt', join(root, 'link.txt')))
      return
    execSync('git add link.txt', { cwd: root, stdio: 'ignore' })
    execSync('git commit -m "add symlink"', { cwd: root, stdio: 'ignore' })

    unlinkSync(join(root, 'link.txt'))
    writeFileSync(join(root, 'link.txt'), 'now regular\n', 'utf8')

    assert.equal(captureInitGitSnapshot(root), undefined)
  })
})

t('git snapshot checks tracked index mode when core.symlinks is disabled', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'target.txt': 'target\n' })
    execSync('git config core.symlinks true', { cwd: root, stdio: 'ignore' })
    const linkPath = join(root, 'link.txt')
    if (!tryCreateTestSymlink('target.txt', linkPath))
      return
    execSync('git add link.txt', { cwd: root, stdio: 'ignore' })
    execSync('git commit -m "add symlink"', { cwd: root, stdio: 'ignore' })
    execSync('git config core.symlinks false', { cwd: root, stdio: 'ignore' })
    unlinkSync(linkPath)
    execSync('git checkout -- link.txt', { cwd: root, stdio: 'ignore' })
    assert.equal(lstatSync(linkPath).isFile(), true)

    writeFileSync(linkPath, 'modified placeholder\n', 'utf8')

    assert.equal(captureInitGitSnapshot(root), undefined)
  })
})

t('git snapshot forces rename detection when repository status config disables it', () => {
  withTempDir((root) => {
    initializeGitRepo(root, { 'before.txt': 'tracked\n' })
    execSync('git config status.renames false', { cwd: root, stdio: 'ignore' })
    execSync('git mv before.txt after.txt', { cwd: root, stdio: 'ignore' })

    assert.equal(captureInitGitSnapshot(root), undefined)
  })
})

t('git fingerprint merge retains only existing fingerprints proven safe before a mutation', () => {
  const repoRoot = '/example/repo'
  const fingerprint = sha256 => ({ status: ' M', sha256, mode: 0o100644 })
  const changes = (files, root = repoRoot) => ({ version: 1, repoRoot: root, files })
  const existing = changes({ 'package.json': fingerprint('saved') })
  const cases = [
    {
      name: 'exact existing fingerprint remains retained',
      before: changes({ 'package.json': fingerprint('saved') }),
      after: changes({ 'package.json': fingerprint('saved') }),
      expected: existing,
    },
    {
      name: 'user change before the window prunes the existing fingerprint',
      before: changes({ 'package.json': fingerprint('user-edit') }),
      after: changes({ 'package.json': fingerprint('user-edit') }),
      expected: undefined,
    },
    {
      name: 'stale path changed again during the window is not re-attributed',
      before: changes({ 'package.json': fingerprint('user-edit') }),
      after: changes({ 'package.json': fingerprint('second-edit') }),
      expected: undefined,
    },
    {
      name: 'missing before snapshot retains existing state without claiming after paths',
      before: undefined,
      after: changes({
        'package.json': fingerprint('after-edit'),
        'new-file.txt': fingerprint('new-file'),
      }),
      expected: existing,
    },
    {
      name: 'missing after snapshot retains existing state without claiming before paths',
      before: changes({
        'package.json': fingerprint('saved'),
        'user-file.txt': fingerprint('user-edit'),
      }),
      after: undefined,
      expected: existing,
    },
    {
      name: 'incompatible after snapshot retains existing state without claiming paths',
      before: changes({ 'package.json': fingerprint('saved') }),
      after: changes({ 'new-file.txt': fingerprint('new-file') }, '/different/repo'),
      expected: existing,
    },
  ]

  for (const testCase of cases)
    assert.deepEqual(mergeInitGitChanges(existing, testCase.before, testCase.after), testCase.expected, testCase.name)
})

t('git fingerprint classification requires exact path, status, hash, and mode matches', () => {
  const repoRoot = '/example/repo'
  const fingerprint = (status, sha256, mode = 0o100644) => ({ status, sha256, mode })
  const changes = files => ({ version: 1, repoRoot, files })
  const cases = [
    {
      name: 'exact saved fingerprint is recognized',
      current: changes({ 'package.json': fingerprint(' M', 'saved') }),
      saved: changes({ 'package.json': fingerprint(' M', 'saved') }),
      unsafePaths: [],
      recognizedCount: 1,
      retainedPaths: ['package.json'],
    },
    {
      name: 'same path subsequently changed is unsafe',
      current: changes({ 'package.json': fingerprint(' M', 'changed') }),
      saved: changes({ 'package.json': fingerprint(' M', 'saved') }),
      unsafePaths: ['package.json'],
      recognizedCount: 0,
      retainedPaths: [],
    },
    {
      name: 'additional dirty path is unsafe',
      current: changes({
        'package.json': fingerprint(' M', 'saved'),
        'src/main.ts': fingerprint(' M', 'user-edit'),
      }),
      saved: changes({ 'package.json': fingerprint(' M', 'saved') }),
      unsafePaths: ['src/main.ts'],
      recognizedCount: 1,
      retainedPaths: ['package.json'],
    },
    {
      name: 'staged status differing from saved status is unsafe',
      current: changes({ 'package.json': fingerprint('M ', 'saved') }),
      saved: changes({ 'package.json': fingerprint(' M', 'saved') }),
      unsafePaths: ['package.json'],
      recognizedCount: 0,
      retainedPaths: [],
    },
    {
      name: 'deleted path with an exact null fingerprint is recognized',
      current: changes({ 'package.json': fingerprint(' D', null, null) }),
      saved: changes({ 'package.json': fingerprint(' D', null, null) }),
      unsafePaths: [],
      recognizedCount: 1,
      retainedPaths: ['package.json'],
    },
    {
      name: 'path deleted after a regular fingerprint was saved is unsafe',
      current: changes({ 'package.json': fingerprint(' D', null, null) }),
      saved: changes({ 'package.json': fingerprint(' M', 'saved') }),
      unsafePaths: ['package.json'],
      recognizedCount: 0,
      retainedPaths: [],
    },
    {
      name: 'mode change is unsafe',
      current: changes({ 'scripts/setup.sh': fingerprint(' M', 'saved', 0o100755) }),
      saved: changes({ 'scripts/setup.sh': fingerprint(' M', 'saved', 0o100644) }),
      unsafePaths: ['scripts/setup.sh'],
      recognizedCount: 0,
      retainedPaths: [],
    },
    {
      name: 'no saved fingerprint state leaves current dirty paths unsafe',
      current: changes({
        'package.json': fingerprint(' M', 'saved'),
        'src/main.ts': fingerprint(' M', 'user-edit'),
      }),
      saved: undefined,
      unsafePaths: ['package.json', 'src/main.ts'],
      recognizedCount: 0,
      retainedPaths: [],
    },
  ]

  for (const testCase of cases) {
    const classification = classifyInitGitChanges(testCase.current, testCase.saved)
    assert.deepEqual(classification.unsafePaths, testCase.unsafePaths, testCase.name)
    assert.equal(classification.recognizedCount, testCase.recognizedCount, testCase.name)
    assert.deepEqual(Object.keys(classification.retained?.files ?? {}).sort(), testCase.retainedPaths, testCase.name)
  }
})

t('saved init git fingerprints require a strict versioned runtime shape', () => {
  const valid = {
    version: 1,
    repoRoot: '/repo',
    files: {
      'package.json': { status: ' M', sha256: 'a'.repeat(64), mode: 0o100644 },
      'src/deleted.ts': { status: ' D', sha256: null, mode: null },
    },
  }
  const invalidCases = [
    ['undefined value', undefined],
    ['null value', null],
    ['array value', []],
    ['unsupported version', { ...valid, version: 2 }],
    ['empty repository root', { ...valid, repoRoot: '' }],
    ['relative repository root', { ...valid, repoRoot: 'repo' }],
    ['NUL repository root', { ...valid, repoRoot: '/repo\0other' }],
    ['array file map', { ...valid, files: [] }],
    ['empty file map', { ...valid, files: {} }],
    ['absolute path', { ...valid, files: { '/package.json': valid.files['package.json'] } }],
    ['Windows absolute path', { ...valid, files: { 'C:\\package.json': valid.files['package.json'] } }],
    ['Windows drive-relative path', { ...valid, files: { 'C:package.json': valid.files['package.json'] } }],
    ['escaping path', { ...valid, files: { '../package.json': valid.files['package.json'] } }],
    ['normalized escaping path', { ...valid, files: { 'src/../../package.json': valid.files['package.json'] } }],
    ['array fingerprint', { ...valid, files: { 'package.json': [] } }],
    ['short status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'M' } } }],
    ['long status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: ' M ' } } }],
    ['empty status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: '  ' } } }],
    ['garbage status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'zz' } } }],
    ['renamed status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'R ' } } }],
    ['copied status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: ' C' } } }],
    ['type-changed status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'T ' } } }],
    ['unmerged status', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'U ' } } }],
    ['unsupported added pair', { ...valid, files: { 'package.json': { ...valid.files['package.json'], status: 'AA' } } }],
    ['unsupported deleted pair', { ...valid, files: { 'package.json': { status: 'DD', sha256: null, mode: null } } }],
    ['delete with content', { ...valid, files: { 'package.json': { status: ' D', sha256: 'a'.repeat(64), mode: 0o100644 } } }],
    ['delete with hash only', { ...valid, files: { 'package.json': { status: 'D ', sha256: 'a'.repeat(64), mode: null } } }],
    ['non-delete with null content', { ...valid, files: { 'package.json': { status: ' M', sha256: null, mode: null } } }],
    ['non-delete with null mode', { ...valid, files: { 'package.json': { status: 'M ', sha256: 'a'.repeat(64), mode: null } } }],
    ['uppercase hash', { ...valid, files: { 'package.json': { ...valid.files['package.json'], sha256: 'A'.repeat(64) } } }],
    ['short hash', { ...valid, files: { 'package.json': { ...valid.files['package.json'], sha256: 'a'.repeat(63) } } }],
    ['fractional mode', { ...valid, files: { 'package.json': { ...valid.files['package.json'], mode: 0o100644 + 0.5 } } }],
    ['directory mode', { ...valid, files: { 'package.json': { ...valid.files['package.json'], mode: 0o040755 } } }],
    ['symlink mode', { ...valid, files: { 'package.json': { ...valid.files['package.json'], mode: 0o120777 } } }],
    ['unexpected top-level property', { ...valid, ignored: true }],
    ['unexpected fingerprint property', { ...valid, files: { 'package.json': { ...valid.files['package.json'], ignored: true } } }],
  ]

  assert.deepEqual(parseInitGitChanges(valid), valid)
  assert.notEqual(parseInitGitChanges(valid), valid)
  assert.notEqual(parseInitGitChanges(valid)?.files, valid.files)
  for (const [name, value] of invalidCases)
    assert.equal(parseInitGitChanges(value), undefined, name)

  const inheritedShape = Object.create(valid)
  assert.equal(parseInitGitChanges(inheritedShape), undefined)
  const inheritedFiles = Object.create({ inherited: valid.files['package.json'] })
  inheritedFiles['package.json'] = valid.files['package.json']
  assert.equal(parseInitGitChanges({ ...valid, files: inheritedFiles }), undefined)

  for (const [status, deleted] of [[' M', false], ['M ', false], ['MM', false], ['A ', false], ['??', false], [' D', true], ['D ', true]]) {
    const fingerprint = deleted
      ? { status, sha256: null, mode: null }
      : { status, sha256: 'b'.repeat(64), mode: 0o100755 }
    assert.deepEqual(parseInitGitChanges({ version: 1, repoRoot: '/repo', files: { 'file.txt': fingerprint } })?.files['file.txt'], fingerprint, status)
  }
})

async function tAsync(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await tAsync('git mutation tracker attributes only changes made inside one async operation window', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, {
      'src/main.ts': 'console.log(\'initial\')\n',
      'package.json': '{"name":"example","dependencies":{}}\n',
      'package-lock.json': '{"name":"example","lockfileVersion":3}\n',
    })
    writeFileSync(join(root, 'src/main.ts'), 'console.log(\'user edit\')\n', 'utf8')
    let calls = 0

    const tracked = await trackInitGitChanges(undefined, async () => {
      calls += 1
      await Promise.resolve()
      writeFileSync(join(root, 'package.json'), '{"name":"example","dependencies":{"@capgo/capacitor-updater":"latest"}}\n', 'utf8')
      writeFileSync(join(root, 'package-lock.json'), '{"name":"example","lockfileVersion":3,"packages":{"capgo":{}}}\n', 'utf8')
      return 'installed'
    }, { startDir: root })

    assert.equal(calls, 1)
    assert.equal(tracked.result, 'installed')
    assert.deepEqual(Object.keys(tracked.gitChanges?.files ?? {}).sort(), ['package-lock.json', 'package.json'])
  })
})

await tAsync('git mutation tracker propagates the same error without changing existing state', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"saved"}\n', 'utf8')
    const existing = captureInitGitSnapshot(root)
    const original = structuredClone(existing)
    const expectedError = new Error('mutation failed')
    let calls = 0
    let caught

    try {
      await trackInitGitChanges(existing, async () => {
        calls += 1
        writeFileSync(join(root, 'package.json'), '{"name":"partial"}\n', 'utf8')
        throw expectedError
      }, { startDir: root })
    }
    catch (error) {
      caught = error
    }

    assert.equal(calls, 1)
    assert.equal(caught, expectedError)
    assert.deepEqual(existing, original)
  })
})

await tAsync('git mutation tracker rejects partially-mutating unsuccessful results', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"saved"}\n', 'utf8')
    const existing = captureInitGitSnapshot(root)
    const original = structuredClone(existing)

    const tracked = await trackInitGitChanges(existing, () => {
      writeFileSync(join(root, 'package.json'), '{"name":"partial"}\n', 'utf8')
      return { success: false }
    }, {
      startDir: root,
      isSuccess: result => result.success,
    })

    assert.deepEqual(tracked.result, { success: false })
    assert.equal(tracked.gitChanges, existing)
    assert.deepEqual(existing, original)
  })
})

await tAsync('git mutation tracker prunes a user-changed fingerprint without re-attributing a later mutation', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    const first = await trackInitGitChanges(undefined, () => {
      writeFileSync(join(root, 'package.json'), '{"name":"capgo-first"}\n', 'utf8')
    }, { startDir: root })
    assert.deepEqual(Object.keys(first.gitChanges?.files ?? {}), ['package.json'])

    writeFileSync(join(root, 'package.json'), '{"name":"user-edit"}\n', 'utf8')
    const second = await trackInitGitChanges(first.gitChanges, () => {
      writeFileSync(join(root, 'package.json'), '{"name":"capgo-second"}\n', 'utf8')
    }, { startDir: root })

    assert.equal(second.gitChanges, undefined)
  })
})

await tAsync('git mutation tracker retains existing fingerprints when capture is unavailable', async () => {
  await withTempDirAsync(async (root) => {
    const existing = {
      version: 1,
      repoRoot: '/existing/repo',
      files: {
        'package.json': { status: ' M', sha256: 'a'.repeat(64), mode: 0o100644 },
      },
    }

    const tracked = await trackInitGitChanges(existing, () => {
      writeFileSync(join(root, 'new-file.txt'), 'not in a git repo\n', 'utf8')
      return 'done'
    }, { startDir: root })

    assert.equal(tracked.result, 'done')
    assert.deepEqual(tracked.gitChanges, existing)
    assert.deepEqual(Object.keys(tracked.gitChanges?.files ?? {}), ['package.json'])
  })
})

await tAsync('scoped git tracking ignores a large unrelated dirty tree and retains saved out-of-scope records', async () => {
  await withTempDirAsync(async (root) => {
    const files = { 'package.json': '{"name":"example"}\n' }
    for (let index = 0; index < 120; index += 1)
      files[`src/dirty-${index}.ts`] = `export const value = ${index}\n`
    initializeGitRepo(root, files)
    for (let index = 0; index < 120; index += 1)
      writeFileSync(join(root, `src/dirty-${index}.ts`), `export const userValue = ${index}\n`, 'utf8')

    const repoRoot = captureInitGitSnapshot(root, { exactPaths: [] })?.repoRoot
    assert.ok(repoRoot)
    const existing = {
      version: 1,
      repoRoot,
      files: {
        'src/dirty-0.ts': { status: ' M', sha256: 'a'.repeat(64), mode: 0o100644 },
      },
    }
    const tracked = await trackInitGitChanges(existing, () => {
      writeFileSync(join(root, 'package.json'), '{"name":"capgo"}\n', 'utf8')
      writeFileSync(join(root, 'src/dirty-1.ts'), 'export const changedAgain = true\n', 'utf8')
    }, {
      startDir: root,
      scope: { exactPaths: ['package.json'] },
    })

    assert.deepEqual(Object.keys(tracked.gitChanges?.files ?? {}).sort(), ['package.json', 'src/dirty-0.ts'])
    assert.deepEqual(tracked.gitChanges?.files['src/dirty-0.ts'], existing.files['src/dirty-0.ts'])
    assert.deepEqual(Object.keys(captureInitGitSnapshot(root, { exactPaths: ['package.json'] })?.files ?? {}), ['package.json'])
  })
})

await tAsync('unsafe git scopes fail closed without claiming paths', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    const existing = {
      version: 1,
      repoRoot: captureInitGitSnapshot(root)?.repoRoot,
      files: {
        'saved.txt': { status: '??', sha256: 'a'.repeat(64), mode: 0o100644 },
      },
    }
    const unsafeScopes = [
      { exactPaths: ['/absolute.txt'] },
      { exactPaths: ['../escaping.txt'] },
      { exactPaths: ['unsafe\0name.txt'] },
      { directoryPrefixes: ['../../outside'] },
    ]

    for (const scope of unsafeScopes) {
      assert.equal(captureInitGitSnapshot(root, scope), undefined)
      const tracked = await trackInitGitChanges(existing, () => {
        writeFileSync(join(root, 'package.json'), '{"name":"partial"}\n', 'utf8')
      }, { startDir: root, scope })
      assert.deepEqual(tracked.gitChanges, existing)
    }
  })
})

await tAsync('native reset targets configured platform directories without escaping the project', async () => {
  for (const [platformName, configuredPath] of [['ios', 'native/apple-app'], ['android', 'native/android-app']]) {
    await withTempDirAsync(async (root) => {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir)
      initializeGitRepo(projectDir, {
        'package.json': '{"name":"example"}\n',
        [`${configuredPath}/generated.txt`]: 'generated\n',
        [`${platformName}/keep.txt`]: 'keep\n',
      })
      const config = { [platformName]: { path: configuredPath } }
      const availability = getNativePlatformAvailability(config, projectDir)
      const nativePlatformDir = platformName === 'ios' ? availability.iosDir : availability.androidDir
      const resetTarget = resolveInitNativeResetTarget(projectDir, nativePlatformDir)

      assert.ok(resetTarget)
      assert.equal(resetTarget.directory, join(realpathSync(projectDir), configuredPath))
      assert.deepEqual(resetTarget.scope, { exactPaths: [], directoryPrefixes: [configuredPath] })

      const tracked = await trackInitGitChanges(undefined, () => {
        rmSync(resetTarget.directory, { recursive: true, force: true })
      }, { startDir: projectDir, scope: resetTarget.scope })

      assert.equal(existsSync(join(projectDir, configuredPath)), false)
      assert.equal(existsSync(join(projectDir, platformName, 'keep.txt')), true)
      assert.deepEqual(Object.keys(tracked.gitChanges?.files ?? {}), [`${configuredPath}/generated.txt`])

      const outsideDir = join(root, 'outside')
      mkdirSync(outsideDir)
      assert.equal(resolveInitNativeResetTarget(projectDir, '../outside'), undefined)
      assert.equal(resolveInitNativeResetTarget(projectDir, outsideDir), undefined)
      assert.equal(resolveInitNativeResetTarget(projectDir, '.'), undefined)
      if (tryCreateTestSymlink(outsideDir, join(projectDir, 'native-link')))
        assert.equal(resolveInitNativeResetTarget(projectDir, 'native-link/ios'), undefined)
    })
  }
})

await tAsync('native reset resolution canonicalizes directory ancestors and rejects ambiguous targets', async () => {
  await withTempDirAsync(async (root) => {
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    initializeGitRepo(projectDir, { 'package.json': '{"name":"example"}\n' })
    const canonicalProjectDir = realpathSync(projectDir)

    writeFileSync(join(projectDir, 'blocking-file'), 'not a directory\n', 'utf8')
    assert.equal(resolveInitNativeResetTarget(projectDir, 'blocking-file/ios'), undefined)

    const nonexistentTarget = resolveInitNativeResetTarget(projectDir, 'missing/nested/ios')
    assert.deepEqual(nonexistentTarget, {
      directory: join(canonicalProjectDir, 'missing/nested/ios'),
      scope: { exactPaths: [], directoryPrefixes: ['missing/nested/ios'] },
    })

    const internalTargetDir = join(projectDir, 'real-native')
    mkdirSync(internalTargetDir)
    if (tryCreateTestSymlink(internalTargetDir, join(projectDir, 'native-alias'))) {
      const internalTarget = resolveInitNativeResetTarget(projectDir, 'native-alias/ios')
      assert.deepEqual(internalTarget, {
        directory: join(canonicalProjectDir, 'real-native/ios'),
        scope: { exactPaths: [], directoryPrefixes: ['real-native/ios'] },
      })

      const finalTargetDir = join(projectDir, 'final-native')
      mkdirSync(finalTargetDir)
      assert.equal(tryCreateTestSymlink(finalTargetDir, join(projectDir, 'final-native-link')), true)
      assert.equal(resolveInitNativeResetTarget(projectDir, 'final-native-link'), undefined)
    }

    const danglingFinalLink = join(projectDir, 'dangling-final-link')
    if (tryCreateTestSymlink(join(projectDir, 'missing-final-target'), danglingFinalLink)) {
      assert.equal(resolveInitNativeResetTarget(projectDir, 'dangling-final-link'), undefined)
      assert.equal(lstatSync(danglingFinalLink).isSymbolicLink(), true)
    }

    const danglingAncestorLink = join(projectDir, 'dangling-ancestor-link')
    if (tryCreateTestSymlink(join(projectDir, 'missing-ancestor-target'), danglingAncestorLink)) {
      assert.equal(resolveInitNativeResetTarget(projectDir, 'dangling-ancestor-link/ios'), undefined)
      assert.equal(lstatSync(danglingAncestorLink).isSymbolicLink(), true)
    }

    const outsideDir = join(root, 'outside')
    mkdirSync(outsideDir)
    if (tryCreateTestSymlink(outsideDir, join(projectDir, 'external-alias')))
      assert.equal(resolveInitNativeResetTarget(projectDir, 'external-alias/ios'), undefined)

    assert.equal(resolveInitNativeResetTarget(projectDir, join(projectDir, 'absolute-ios')), undefined)
    assert.equal(resolveInitNativeResetTarget(projectDir, 'native/../ios'), undefined)
    assert.equal(resolveInitNativeResetTarget(projectDir, 'native\0ios'), undefined)
  })
})

await tAsync('tracked init mutation persists changed process, structured, and void successes', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, {
      'package.json': '{"name":"example"}\n',
      'capacitor.config.ts': 'export default {}\n',
      'src/main.ts': 'console.log(\'initial\')\n',
    })
    restoreInitProgressState(1, undefined)
    let persistCount = 0
    const dependencies = { persistProgress: () => { persistCount += 1 } }
    try {
      const processResult = await runTrackedInitMutation(() => {
        writeFileSync(join(root, 'package.json'), '{"name":"capgo"}\n', 'utf8')
        return { status: 0, error: undefined }
      }, {
        startDir: root,
        scope: { exactPaths: ['package.json'] },
        isSuccess: isSuccessfulInitProcessResult,
      }, dependencies)
      assert.equal(processResult.status, 0)
      assert.equal(persistCount, 1)

      const commandResult = await runTrackedInitMutation(() => {
        writeFileSync(join(root, 'capacitor.config.ts'), 'export default { appId: \'com.test.app\' }\n', 'utf8')
        return { success: true }
      }, {
        startDir: root,
        scope: { exactPaths: ['capacitor.config.ts'] },
        isSuccess: isSuccessfulInitCommandResult,
      }, dependencies)
      assert.equal(commandResult.success, true)

      await runTrackedInitMutation(() => {
        writeFileSync(join(root, 'src/main.ts'), 'console.log(\'capgo\')\n', 'utf8')
      }, {
        startDir: root,
        scope: { exactPaths: ['src/main.ts'] },
      }, dependencies)

      assert.equal(persistCount, 3)
      assert.deepEqual(Object.keys(getInitProgressStateForTesting().gitChanges?.files ?? {}).sort(), [
        'capacitor.config.ts',
        'package.json',
        'src/main.ts',
      ])
    }
    finally {
      beginFreshInitProgress()
    }
  })
})

await tAsync('tracked init mutation leaves global state and persistence unchanged on every failure mode', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"saved"}\n', 'utf8')
    const saved = captureInitGitSnapshot(root)
    assert.ok(saved)
    const original = structuredClone(saved)
    let persistCount = 0
    const dependencies = { persistProgress: () => { persistCount += 1 } }
    try {
      const operationError = new Error('operation failed')
      restoreInitProgressState(1, saved)
      await assert.rejects(
        runTrackedInitMutation(() => {
          writeFileSync(join(root, 'package.json'), '{"name":"partial-operation"}\n', 'utf8')
          throw operationError
        }, { startDir: root, scope: { exactPaths: ['package.json'] } }, dependencies),
        error => error === operationError,
      )
      assert.deepEqual(getInitProgressStateForTesting().gitChanges, original)

      restoreInitProgressState(1, saved)
      const failedResult = await runTrackedInitMutation(() => {
        writeFileSync(join(root, 'package.json'), '{"name":"partial-result"}\n', 'utf8')
        return { success: false }
      }, {
        startDir: root,
        scope: { exactPaths: ['package.json'] },
        isSuccess: isSuccessfulInitCommandResult,
      }, dependencies)
      assert.deepEqual(failedResult, { success: false })
      assert.deepEqual(getInitProgressStateForTesting().gitChanges, original)

      const predicateError = new Error('predicate failed')
      restoreInitProgressState(1, saved)
      await assert.rejects(
        runTrackedInitMutation(() => ({ success: true }), {
          startDir: root,
          scope: { exactPaths: ['package.json'] },
          isSuccess: () => { throw predicateError },
        }, dependencies),
        error => error === predicateError,
      )
      assert.deepEqual(getInitProgressStateForTesting().gitChanges, original)
      assert.equal(persistCount, 0)
    }
    finally {
      beginFreshInitProgress()
    }
  })
})

await tAsync('zero-delta tracked success keeps global state byte-equal without persisting', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, { 'package.json': '{"name":"example"}\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"saved"}\n', 'utf8')
    const saved = captureInitGitSnapshot(root)
    assert.ok(saved)
    restoreInitProgressState(1, saved)
    let persistCount = 0
    try {
      await runTrackedInitMutation(() => undefined, {
        startDir: root,
        scope: { exactPaths: ['package.json'] },
      }, { persistProgress: () => { persistCount += 1 } })

      assert.deepEqual(getInitProgressStateForTesting().gitChanges, saved)
      assert.equal(persistCount, 0)
    }
    finally {
      beginFreshInitProgress()
    }
  })
})

t('automatic onboarding mutations use narrow tracking windows and user-controlled work stays outside them', () => {
  const source = readFileSync(new URL('../src/init/command.ts', import.meta.url), 'utf8')
  const sourceBetween = (start, end) => {
    const startIndex = source.indexOf(start)
    const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length
    assert.notEqual(startIndex, -1, start)
    assert.notEqual(endIndex, -1, end ?? 'end of file')
    return source.slice(startIndex, endIndex)
  }
  const trackedCallCount = body => body.match(/\brunTrackedInitMutation\s*\(/g)?.length ?? 0
  const coverage = [
    ['updater dependency install', 'function runUpdaterInstallCommand(', 'function logUpdaterInstallStateDetails('],
    ['Capacitor package installs and init', 'async function maybeRunCapacitorInit(', 'async function runCapacitorPlatformAdd('],
    ['Capacitor platform add', 'async function runCapacitorPlatformAdd(', 'async function runCreateAppTemplate('],
    ['app-ID config update', 'async function saveAppIdToCapacitorConfig(', 'async function syncPendingAppIdToCapacitorConfig('],
    ['pending app-ID config sync', 'async function syncPendingAppIdToCapacitorConfig(', 'function logBrokenIosSync('],
    ['native reset delete/add/sync sequence', 'async function runNativeResetCommand(', 'async function waitForReadyConfirmation('],
    ['pending-app Capacitor init', 'async function ensureCapacitorProjectReady(', 'async function selectPendingOnboardingApp('],
    ['updater config update', 'async function addUpdaterStep(', 'async function addCodeStep('],
    ['source-code injection write', 'async function addCodeStep(', 'async function addEncryptionStep('],
    ['key creation and encryption sync', 'async function addEncryptionStep(', 'async function streamCommandInInitPanel('],
    ['primary automatic native sync', 'async function runBuildAndSyncLoop(', 'async function runProjectBuildAndSync('],
    ['updater test write', 'async function addCodeChangeStep(', 'function getSuggestedCleanupBundleVersion('],
    ['updater test cleanup write', 'async function maybeOfferAutoTestCleanup(', 'async function uploadStep('],
    ['self-host config update', 'export async function initApp(', undefined],
  ]

  for (const [name, start, end] of coverage) {
    const body = sourceBetween(start, end)
    assert.ok(trackedCallCount(body) >= 1, name)
    assert.match(body, /\brunTrackedInitMutation\s*\([\s\S]*?\bscope:/, `${name} scope`)
  }

  assert.equal(trackedCallCount(sourceBetween('async function waitUntilSetupIsDone(', 'async function askForAppName(')), 0, 'manual setup wait')
  assert.equal(trackedCallCount(sourceBetween('async function waitForReadyConfirmation(', 'async function waitForReadyRetry(')), 0, 'manual ready wait')
  assert.equal(trackedCallCount(sourceBetween('async function runDeviceStep(', 'async function addCodeChangeStep(')), 0, 'cap run')
  assert.equal(trackedCallCount(sourceBetween('const buildResult = await streamCommandInInitPanel({', '// Keep the completed build output visible')), 0, 'project build')
  const nativeResetBody = sourceBetween('async function runNativeResetCommand(', 'async function waitForReadyConfirmation(')
  assert.match(nativeResetBody, /rmSync\(resetTarget\.directory,/)
  assert.match(nativeResetBody, /scope: resetTarget\.scope/)
  assert.match(nativeResetBody, /path\.relative\(realpathSync\(projectDir\), resetTarget\.directory\)/)
  assert.match(nativeResetBody, /resetSpinner\.start\(`Running: \$\{resetCommand\}`\)/)
})

await tAsync('live git cleanliness gate filters trusted changes without weakening the existing prompt', async () => {
  const repoRoot = '/repo'
  const fingerprint = sha256 => ({ status: ' M', sha256, mode: 0o100644 })
  const saved = {
    version: 1,
    repoRoot,
    files: { 'package.json': fingerprint('a'.repeat(64)) },
  }
  const current = {
    version: 1,
    repoRoot,
    files: {
      ...saved.files,
      'src/user.ts': { status: '??', sha256: 'b'.repeat(64), mode: 0o100644 },
    },
  }
  const dirtyStatus = {
    inRepo: true,
    clean: false,
    repoRoot,
    entries: [' M package.json', '?? src/user.ts'],
  }

  const runGate = async ({ status, snapshot, savedValue, action = 'continue-dirty', persistSucceeds = true }) => {
    restoreInitProgressState(4, savedValue)
    const events = []
    await ensureGitRepoCleanBeforeInit(undefined, {
      getStatus: () => status,
      captureSnapshot: () => snapshot,
      isOnlyAllowedAutoTestChange: () => false,
      persistProgress: () => {
        events.push({ type: 'persist', state: getInitProgressStateForTesting() })
        return persistSucceeds
      },
      log: {
        error: message => events.push({ type: 'error', message }),
        info: message => events.push({ type: 'info', message }),
        success: message => events.push({ type: 'success', message }),
        warn: message => events.push({ type: 'warn', message }),
      },
      selectAction: async (prompt) => {
        events.push({ type: 'prompt', prompt })
        return action
      },
      cancelAction: async selectedAction => events.push({ type: 'cancel-check', action: selectedAction }),
      waitForRetry: async () => assert.fail('retry prompt was not expected'),
    })
    return { events, state: getInitProgressStateForTesting() }
  }

  try {
    const exact = await runGate({
      status: { ...dirtyStatus, entries: [' M package.json'] },
      snapshot: saved,
      savedValue: saved,
    })
    assert.equal(exact.events.some(event => event.type === 'prompt'), false)
    assert.deepEqual(exact.events.filter(event => event.type === 'info').map(event => event.message), [
      'Resuming with uncommitted changes created by the previous Capgo onboarding run.',
    ])

    const failedExact = await runGate({
      status: { ...dirtyStatus, entries: [' M package.json'] },
      snapshot: saved,
      savedValue: saved,
      persistSucceeds: false,
    })
    assert.equal(failedExact.events.some(event => event.type === 'prompt'), true)
    assert.deepEqual(
      failedExact.events.filter(event => event.type === 'warn' && event.message.startsWith('  ')).map(event => event.message),
      ['   M package.json'],
    )
    assert.equal(failedExact.events.some(event => event.type === 'info' && event.message.includes('previous Capgo onboarding run')), false)
    assert.equal(failedExact.events.findIndex(event => event.type === 'persist') < failedExact.events.findIndex(event => event.type === 'prompt'), true)

    const mixed = await runGate({ status: dirtyStatus, snapshot: current, savedValue: saved })
    const mixedPrompt = mixed.events.find(event => event.type === 'prompt')
    assert.deepEqual(mixedPrompt?.prompt, {
      message: 'How do you want to handle the dirty git status?',
      options: getDirtyGitStatusActionOptions(),
    })
    assert.deepEqual(
      mixed.events.filter(event => event.type === 'warn' && event.message.startsWith('  ')).map(event => event.message),
      ['  ?? src/user.ts'],
    )
    assert.equal(mixed.events.some(event => event.type === 'info' && event.message === '1 recognized Capgo change was omitted from this warning.'), true)
    const mixedPersistIndex = mixed.events.findIndex(event => event.type === 'persist')
    assert.equal(mixedPersistIndex < mixed.events.findIndex(event => event.type === 'prompt'), true)
    assert.deepEqual(Object.keys(mixed.events[mixedPersistIndex]?.state.gitChanges?.files ?? {}), ['package.json'])
    assert.deepEqual(Object.keys(mixed.state.gitChanges?.files ?? {}), ['package.json'])
    assert.equal(mixed.state.gitChanges?.files['src/user.ts'], undefined)
    assert.equal(mixed.events.some(event => event.type === 'warn' && event.message === 'Continuing with dirty git status. This is not recommended.'), true)

    const failedMixed = await runGate({ status: dirtyStatus, snapshot: current, savedValue: saved, persistSucceeds: false })
    assert.deepEqual(
      failedMixed.events.filter(event => event.type === 'warn' && event.message.startsWith('  ')).map(event => event.message),
      ['   M package.json', '  ?? src/user.ts'],
    )
    assert.equal(failedMixed.events.some(event => event.type === 'info' && event.message.includes('recognized Capgo')), false)
    assert.equal(failedMixed.events.findIndex(event => event.type === 'persist') < failedMixed.events.findIndex(event => event.type === 'prompt'), true)
    assert.deepEqual(Object.keys(failedMixed.state.gitChanges?.files ?? {}), ['package.json'])

    for (const [name, savedValue] of [
      ['missing fingerprints', undefined],
      ['malformed fingerprints', { ...saved, files: [] }],
    ]) {
      const fallback = await runGate({ status: dirtyStatus, snapshot: current, savedValue })
      assert.deepEqual(
        fallback.events.filter(event => event.type === 'warn' && event.message.startsWith('  ')).map(event => event.message),
        ['   M package.json', '  ?? src/user.ts'],
        name,
      )
      assert.equal(fallback.events.some(event => event.type === 'prompt'), true, name)
    }

    const clean = await runGate({
      status: { inRepo: true, clean: true, repoRoot, entries: [] },
      snapshot: undefined,
      savedValue: saved,
    })
    assert.equal(clean.events.some(event => event.type === 'prompt'), false)
    assert.deepEqual(clean.events.filter(event => event.type === 'persist').map(event => event.state.gitChanges), [undefined])
    assert.deepEqual(clean.state, { stepDone: 4, gitChanges: undefined })

    const failedClean = await runGate({
      status: { inRepo: true, clean: true, repoRoot, entries: [] },
      snapshot: undefined,
      savedValue: saved,
      persistSucceeds: false,
    })
    assert.equal(failedClean.events.some(event => event.type === 'prompt'), false)
    assert.equal(failedClean.events.some(event => event.type === 'persist'), true)
    assert.deepEqual(failedClean.state, { stepDone: 4, gitChanges: undefined })
  }
  finally {
    beginFreshInitProgress()
  }
})

await tAsync('live git cleanliness gate recognizes raw whitespace and Unicode paths', async () => {
  await withTempDirAsync(async (root) => {
    initializeGitRepo(root, {
      'trusted file.txt': 'initial\n',
      'trusted ü.txt': 'initial\n',
    })
    writeFileSync(join(root, 'trusted file.txt'), 'Capgo change\n', 'utf8')
    writeFileSync(join(root, 'trusted ü.txt'), 'Capgo change\n', 'utf8')
    const saved = captureInitGitSnapshot(root)
    assert.ok(saved)

    const runGate = async () => {
      const events = []
      await ensureGitRepoCleanBeforeInit(undefined, {
        getStatus: () => getGitRepoStatus(root),
        captureSnapshot: () => captureInitGitSnapshot(root),
        isOnlyAllowedAutoTestChange: () => false,
        persistProgress: () => true,
        log: {
          error: message => events.push({ type: 'error', message }),
          info: message => events.push({ type: 'info', message }),
          success: message => events.push({ type: 'success', message }),
          warn: message => events.push({ type: 'warn', message }),
        },
        selectAction: async (prompt) => {
          events.push({ type: 'prompt', prompt })
          return 'continue-dirty'
        },
        cancelAction: async () => {},
        waitForRetry: async () => assert.fail('retry prompt was not expected'),
      })
      return events
    }

    try {
      restoreInitProgressState(4, saved)
      const exactEvents = await runGate()
      assert.equal(exactEvents.some(event => event.type === 'prompt'), false)
      assert.deepEqual(exactEvents.filter(event => event.type === 'info').map(event => event.message), [
        'Resuming with uncommitted changes created by the previous Capgo onboarding run.',
      ])

      writeFileSync(join(root, 'unsafe ü file.txt'), 'user change\n', 'utf8')
      restoreInitProgressState(4, saved)
      const mixedEvents = await runGate()
      assert.equal(mixedEvents.some(event => event.type === 'prompt'), true)
      assert.deepEqual(
        mixedEvents.filter(event => event.type === 'warn' && event.message.startsWith('  ')).map(event => event.message),
        ['  ?? unsafe ü file.txt'],
      )
      assert.equal(mixedEvents.some(event => event.type === 'info' && event.message === '2 recognized Capgo changes were omitted from this warning.'), true)
    }
    finally {
      beginFreshInitProgress()
    }
  })
})

await tAsync('live git cleanliness gate warns for a dirty submodule without retrying', async () => {
  await withTempDirAsync(async (root) => {
    const moduleSource = join(root, 'module-source')
    const projectRoot = join(root, 'project')
    mkdirSync(moduleSource)
    mkdirSync(projectRoot)
    initializeGitRepo(moduleSource, { 'tracked.txt': 'initial\n' })
    initializeGitRepo(projectRoot, { 'README.md': 'project\n' })
    execSync(`git -c protocol.file.allow=always submodule add "${moduleSource}" vendor/module`, { cwd: projectRoot, stdio: 'ignore' })
    execSync('git commit -m "add submodule"', { cwd: projectRoot, stdio: 'ignore' })
    writeFileSync(join(projectRoot, 'vendor', 'module', 'tracked.txt'), 'dirty\n', 'utf8')

    const status = getGitRepoStatus(projectRoot)
    assert.equal(status.error, undefined)
    assert.equal(status.clean, false)
    assert.deepEqual(status.entries, [' M vendor/module'])
    assert.equal(captureInitGitSnapshot(projectRoot), undefined)

    const warnings = []
    let promptCount = 0
    try {
      beginFreshInitProgress()
      await ensureGitRepoCleanBeforeInit(undefined, {
        getStatus: () => getGitRepoStatus(projectRoot),
        captureSnapshot: () => captureInitGitSnapshot(projectRoot),
        isOnlyAllowedAutoTestChange: () => false,
        persistProgress: () => true,
        log: {
          error: message => warnings.push(`error:${message}`),
          info: () => {},
          success: () => {},
          warn: message => warnings.push(message),
        },
        selectAction: async () => {
          promptCount += 1
          return 'continue-dirty'
        },
        cancelAction: async () => {},
        waitForRetry: async () => assert.fail('dirty submodules must not enter the git-error retry path'),
      })
    }
    finally {
      beginFreshInitProgress()
    }

    assert.equal(promptCount, 1)
    assert.equal(warnings.includes('   M vendor/module'), true)
    assert.equal(warnings.some(message => message.startsWith('error:')), false)
  })
})

t('production onboarding lifecycle transitions clear resumed fingerprint state', () => {
  const saved = {
    version: 1,
    repoRoot: '/repo',
    files: { 'package.json': { status: ' M', sha256: 'a'.repeat(64), mode: 0o100644 } },
  }
  const transitions = [
    ['fresh onboarding start', beginFreshInitProgress],
    ['declined resume', () => declineInitProgressResume({ clearCodeDiff: () => {}, clearEncryptionSummary: () => {} })],
    ['discarded resumed onboarding', () => discardResumedInitProgress({ clearCodeDiff: () => {}, clearEncryptionSummary: () => {} })],
  ]

  try {
    for (const [name, transition] of transitions) {
      restoreInitProgressState(4, saved)
      transition()
      assert.deepEqual(getInitProgressStateForTesting(), { stepDone: 0, gitChanges: undefined }, name)
    }
  }
  finally {
    beginFreshInitProgress()
  }
})

await tAsync('resume fallback clears fingerprints when post-confirmation restoration throws', async () => {
  const saved = {
    version: 1,
    repoRoot: '/repo',
    files: { 'package.json': { status: ' M', sha256: 'a'.repeat(64), mode: 0o100644 } },
  }
  let stateBeforeFailure

  try {
    const resumed = await tryResumeOnboarding('test-key', {}, process.cwd(), {}, undefined, {
      readProgress: () => JSON.stringify({
        step_done: 1,
        orgId: 'org-id',
        orgName: 'Saved org',
        gitChanges: saved,
      }),
      validateAccess: async () => undefined,
      selectResume: async () => 'yes',
      afterProgressRestored: () => {
        stateBeforeFailure = getInitProgressStateForTesting()
        throw new Error('post-restore failure')
      },
      clearCodeDiff: () => {},
      clearEncryptionSummary: () => {},
      log: { error: () => {}, info: () => {}, warn: () => {} },
    })

    assert.deepEqual(stateBeforeFailure, { stepDone: 1, gitChanges: saved })
    assert.equal(resumed, undefined)
    assert.deepEqual(getInitProgressStateForTesting(), { stepDone: 0, gitChanges: undefined })
  }
  finally {
    beginFreshInitProgress()
  }
})

await tAsync('command settlement preserves ENOENT instead of close code -2', async () => {
  const child = spawn('__capgo_missing_stream_command__', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await waitForCommandResult(child)

  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'ENOENT')
  assert.match(result.error?.message ?? '', /capgo_missing_stream_command/)
})

await tAsync('command settlement handles normal zero and nonzero exits', async () => {
  const success = await waitForCommandResult(spawn(process.execPath, ['-e', 'process.exit(0)']))
  const failure = await waitForCommandResult(spawn(process.execPath, ['-e', 'process.exit(7)']))

  assert.deepEqual(success, { success: true })
  assert.equal(failure.success, false)
  assert.equal(failure.error?.message, 'Command exited with code 7')
})

await tAsync('inherited child output flows through parent streams for replay capture', async () => {
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  let capturedStdout = ''
  let capturedStderr = ''

  process.stdout.write = ((chunk, encoding, callback) => {
    capturedStdout += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk)
    if (typeof encoding === 'function')
      encoding()
    if (typeof callback === 'function')
      callback()
    return true
  })
  process.stderr.write = ((chunk, encoding, callback) => {
    capturedStderr += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk)
    if (typeof encoding === 'function')
      encoding()
    if (typeof callback === 'function')
      callback()
    return true
  })

  try {
    const result = await runInheritedCommand(process.execPath, ['-e', "process.stdout.write('child stdout'); process.stderr.write('child stderr')"])
    assert.equal(result.status, 0)
    assert.match(capturedStdout, /child stdout/)
    assert.match(capturedStderr, /child stderr/)
  }
  finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
})

if (failures > 0) {
  console.error(`\n❌ ${failures} init guardrail test(s) failed`)
  process.exit(1)
}

console.log('\n✅ init guardrail tests passed')
