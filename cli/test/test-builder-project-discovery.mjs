#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as builderOnboardingCommand from '../src/build/onboarding/command.ts'
import {
  discoverCapacitorProjects,
  hasCapacitorConfig,
} from '../src/build/onboarding/project-discovery.ts'
import { projectCandidateLabel, selectCapacitorProject } from '../src/build/onboarding/project-selection.ts'
import {
  builderProjectNotFoundMessage,
  shouldDiscoverBuilderProject,
} from '../src/build/onboarding/command.ts'
import { loadConfigTarget } from '../src/config/index.ts'

const fixtureRoots = []
let failures = 0

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `capgo-builder-${name}-`))
  fixtureRoots.push(root)
  return root
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function addPackage(root, relativeDir, name) {
  const dir = join(root, relativeDir)
  writeJson(join(dir, 'package.json'), { name, version: '1.0.0' })
  return dir
}

function addCapacitorApp(root, relativeDir, name, appId) {
  const dir = addPackage(root, relativeDir, name)
  writeText(join(dir, 'capacitor.config.ts'), `export default { appId: '${appId}' }\n`)
  return dir
}

async function test(name, run) {
  try {
    await run()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(error)
  }
}

try {
  await test('accepts a Capacitor app in the invocation directory without requiring package.json', async () => {
    const root = fixture('current-app')
    writeText(join(root, 'capacitor.config.json'), '{"appId":"com.example.current"}\n')

    assert.equal(hasCapacitorConfig(root), true)
    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, undefined)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['.'])
    assert.equal(result.candidates[0].appId, 'com.example.current')
  })

  await test('does not search when the invocation directory has no package.json', async () => {
    const root = fixture('no-package-json')
    addCapacitorApp(root, 'nested/mobile', '@example/mobile', 'com.example.mobile')

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, 'missing-package-json')
    assert.deepEqual(result.candidates, [])
  })

  await test('discovers generic array-form workspaces without requiring a lockfile', async () => {
    const root = fixture('generic')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    addPackage(root, 'apps/web', '@example/web')
    addCapacitorApp(root, 'apps/mobile', '@example/mobile', 'com.example.mobile')

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, undefined)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
    assert.equal(result.candidates[0].packageName, '@example/mobile')
    assert.equal(result.candidates[0].appId, 'com.example.mobile')
  })

  await test('reads appId from a JavaScript config without project TypeScript', async () => {
    const root = fixture('javascript-config')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    const appDir = addPackage(root, 'apps/mobile', '@example/mobile')
    writeText(join(appDir, 'capacitor.config.js'), "module.exports = { appId: 'com.example.javascript' }\n")

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, undefined)
    assert.equal(result.candidates[0].appId, 'com.example.javascript')
  })

  await test('falls back to the CLI compiler when a resolved TypeScript module is unusable', async () => {
    const root = fixture('invalid-project-typescript')
    const configPath = join(root, 'capacitor.config.ts')
    writeText(configPath, "export default { appId: 'com.example.fallback' }\n")
    writeJson(join(root, 'node_modules/typescript/package.json'), { name: 'typescript', version: '0.0.0', main: 'index.js' })
    writeText(join(root, 'node_modules/typescript/index.js'), "module.exports = { version: '0.0.0' }\n")

    const config = await loadConfigTarget(configPath)
    assert.equal(config.appId, 'com.example.fallback')
  })

  await test('sorts multiple Capacitor apps by relative workspace path', async () => {
    const root = fixture('multiple')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    addCapacitorApp(root, 'apps/mobile', '@example/mobile', 'com.example.mobile')
    addCapacitorApp(root, 'apps/admin', '@example/admin', 'com.example.admin')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/admin', 'apps/mobile'])
  })

  await test('discovers Yarn object-form workspaces', async () => {
    const root = fixture('yarn')
    writeJson(join(root, 'package.json'), {
      private: true,
      packageManager: 'yarn@1.22.22',
      workspaces: { packages: ['packages/*'] },
    })
    addCapacitorApp(root, 'packages/mobile', '@example/yarn-mobile', 'com.example.yarn')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['packages/mobile'])
  })

  await test('discovers pnpm-workspace.yaml packages', async () => {
    const root = fixture('pnpm')
    writeJson(join(root, 'package.json'), { private: true, packageManager: 'pnpm@10.0.0' })
    writeText(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    addCapacitorApp(root, 'apps/mobile', '@example/pnpm-mobile', 'com.example.pnpm')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
  })

  await test('discovers Bun workspaces from package-manager metadata', async () => {
    const root = fixture('bun')
    writeJson(join(root, 'package.json'), {
      private: true,
      packageManager: 'bun@1.3.0',
      workspaces: ['apps/*'],
    })
    addCapacitorApp(root, 'apps/mobile', '@example/bun-mobile', 'com.example.bun')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
  })

  await test('discovers Lerna package globs', async () => {
    const root = fixture('lerna')
    writeJson(join(root, 'package.json'), { private: true })
    writeJson(join(root, 'lerna.json'), { packages: ['products/*'] })
    addCapacitorApp(root, 'products/mobile', '@example/lerna-mobile', 'com.example.lerna')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['products/mobile'])
  })

  await test('prefers root npm workspaces when lerna.json omits package globs', async () => {
    const root = fixture('lerna-workspaces')
    writeJson(join(root, 'package.json'), {
      private: true,
      packageManager: 'npm@10.9.2',
      workspaces: ['apps/*', 'packages/*'],
    })
    writeJson(join(root, 'lerna.json'), { version: 'independent', npmClient: 'npm' })
    addCapacitorApp(root, 'apps/mobile', '@example/lerna-mobile', 'com.example.lerna')
    addPackage(root, 'packages/shared', '@example/shared')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
  })

  await test('discovers Rush project folders', async () => {
    const root = fixture('rush')
    writeJson(join(root, 'package.json'), { private: true })
    writeJson(join(root, 'rush.json'), {
      projects: [{ packageName: '@example/rush-mobile', projectFolder: 'apps/mobile' }],
    })
    addCapacitorApp(root, 'apps/mobile', '@example/rush-mobile', 'com.example.rush')

    const result = await discoverCapacitorProjects(root)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
  })

  await test('reports Nx-only repositories as unsupported', async () => {
    const root = fixture('nx-only')
    writeJson(join(root, 'package.json'), { private: true })
    writeJson(join(root, 'nx.json'), {})
    writeJson(join(root, 'apps/mobile/project.json'), { name: 'mobile', root: 'apps/mobile' })
    writeText(join(root, 'apps/mobile/capacitor.config.ts'), "export default { appId: 'com.example.nx' }\n")

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, 'unsupported-workspace')
    assert.equal(result.nxDetected, true)
    assert.deepEqual(result.candidates, [])
  })

  await test('supports Nx repositories that also declare package workspaces', async () => {
    const root = fixture('nx-workspaces')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    writeJson(join(root, 'nx.json'), {})
    addCapacitorApp(root, 'apps/mobile', '@example/nx-mobile', 'com.example.nx')

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.nxDetected, true)
    assert.deepEqual(result.candidates.map(candidate => candidate.relativeDir), ['apps/mobile'])
  })

  await test('rejects workspace package symlinks that escape the invocation root', async () => {
    const root = fixture('symlink-root')
    const outside = fixture('symlink-outside')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    addCapacitorApp(outside, '.', '@example/outside', 'com.example.outside')
    mkdirSync(join(root, 'apps'), { recursive: true })
    symlinkSync(outside, join(root, 'apps', 'outside'), 'dir')

    const result = await discoverCapacitorProjects(root)
    assert.equal(result.reason, 'no-capacitor-app')
    assert.deepEqual(result.candidates, [])
  })

  await test('asks for confirmation when one app is discovered', async () => {
    const only = { dir: '/workspace/apps/mobile', relativeDir: 'apps/mobile', packageName: '@example/mobile' }
    let selectCalled = false
    const selected = await selectCapacitorProject([only], {
      confirm: async candidate => candidate.dir === only.dir,
      select: async () => {
        selectCalled = true
        return Symbol('cancel')
      },
    })

    assert.equal(selected?.dir, only.dir)
    assert.equal(selectCalled, false)
  })

  await test('returns no app when the single candidate is rejected', async () => {
    const only = { dir: '/workspace/apps/mobile', relativeDir: 'apps/mobile' }
    const selected = await selectCapacitorProject([only], {
      confirm: async () => false,
      select: async () => assert.fail('select must not run'),
    })

    assert.equal(selected, undefined)
  })

  await test('selects among multiple apps and handles prompt cancellation', async () => {
    const candidates = [
      { dir: '/workspace/apps/admin', relativeDir: 'apps/admin' },
      { dir: '/workspace/apps/mobile', relativeDir: 'apps/mobile' },
    ]
    const selected = await selectCapacitorProject(candidates, {
      confirm: async () => assert.fail('confirm must not run'),
      select: async options => options[1].dir,
    })
    const cancelled = await selectCapacitorProject(candidates, {
      confirm: async () => assert.fail('confirm must not run'),
      select: async () => Symbol('cancel'),
    })

    assert.equal(selected?.dir, candidates[1].dir)
    assert.equal(cancelled, undefined)
  })

  await test('labels project choices with path and Capacitor appId when available', () => {
    assert.equal(
      projectCandidateLabel({
        dir: '/workspace/apps/mobile',
        relativeDir: 'apps/mobile',
        packageName: '@example/mobile',
        appId: 'com.example.mobile',
      }),
      'apps/mobile — appId: com.example.mobile',
    )
    assert.equal(
      projectCandidateLabel({
        dir: '/workspace/apps/admin',
        relativeDir: 'apps/admin',
        packageName: '@example/admin',
      }),
      '@example/admin — apps/admin',
    )
  })

  await test('changes into the selected app and keeps the invocation root on cancellation', async () => {
    assert.equal(typeof builderOnboardingCommand.discoverBuilderProjectFromInvocationRoot, 'function')
    const root = fixture('command-handoff')
    writeJson(join(root, 'package.json'), { private: true, workspaces: ['apps/*'] })
    const appDir = addCapacitorApp(root, 'apps/mobile', '@example/mobile', 'com.example.mobile')
    const previousCwd = process.cwd()

    try {
      process.chdir(root)
      const selected = await builderOnboardingCommand.discoverBuilderProjectFromInvocationRoot(
        { enableProjectDiscovery: true },
        {
          confirm: async () => true,
          select: async () => assert.fail('select must not run'),
        },
      )
      assert.equal(selected, 'ready')
      assert.equal(realpathSync(process.cwd()), realpathSync(appDir))

      process.chdir(root)
      const cancelled = await builderOnboardingCommand.discoverBuilderProjectFromInvocationRoot(
        { enableProjectDiscovery: true },
        {
          confirm: async () => false,
          select: async () => assert.fail('select must not run'),
        },
      )
      assert.equal(cancelled, 'cancelled')
      assert.equal(realpathSync(process.cwd()), realpathSync(root))
    }
    finally {
      process.chdir(previousCwd)
    }
  })

  await test('enables workspace discovery only for the direct build init entrypoint', () => {
    assert.equal(shouldDiscoverBuilderProject({ enableProjectDiscovery: true }), true)
    assert.equal(shouldDiscoverBuilderProject({}), false)
  })

  await test('provides actionable generic and Nx-specific failure messages', () => {
    const generic = builderProjectNotFoundMessage(false)
    const nx = builderProjectNotFoundMessage(true)

    assert.match(generic, /npx @capgo\/cli@latest build init/)
    assert.doesNotMatch(generic, /Nx repositories/)
    assert.match(nx, /Nx repositories.*not currently supported/s)
  })
}
finally {
  for (const root of fixtureRoots)
    rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} builder project discovery test(s) failed`)
  process.exit(1)
}

console.log('\nBuilder project discovery tests passed')
