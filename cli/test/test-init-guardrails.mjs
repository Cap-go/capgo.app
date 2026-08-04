#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyInitAutoTestChange,
  getDirtyGitStatusActionOptions,
  getGitRepoStatus,
  getInitOtaVersionBase,
  getInitSuggestedOtaVersion,
  getInitUpdaterPluginConfig,
  injectInitCode,
  isOnlyAllowedInitAutoTestChange,
  revertInitAutoTestChangeContent,
  runInheritedCommand,
} from '../src/init/command.ts'
import { usesAlwaysDirectUpdate } from '../src/updaterConfig.ts'

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

t('git status helper skips non-git folders', () => {
  withTempDir((root) => {
    const status = getGitRepoStatus(root)
    assert.equal(status.inRepo, false)
    assert.equal(status.clean, true)
    assert.deepEqual(status.entries, [])
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

t('init code injection uses CommonJS syntax for .cjs files without imports', () => {
  const updated = injectInitCode('scripts/start.cjs', 'console.log(\'ready\')\n')

  assert.match(updated, /^const \{ CapacitorUpdater \} = require\('@capgo\/capacitor-updater'\);/)
  assert.doesNotMatch(updated, /^import /m)
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
    execSync('git init', { cwd: root, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' })
    execSync('git config user.name "Test User"', { cwd: root, stdio: 'ignore' })
    // Hermetic against host gitconfig: a global commit.gpgsign=true would make
    // the temp-repo commit below fail (no pinentry in non-interactive runs).
    execSync('git config commit.gpgsign false', { cwd: root, stdio: 'ignore' })

    mkdirSync(join(root, 'src'), { recursive: true })
    const filePath = join(root, 'src', 'main.css')
    const original = 'body { color: red; }\n'
    writeFileSync(filePath, original, 'utf8')
    execSync('git add src/main.css', { cwd: root, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' })

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
