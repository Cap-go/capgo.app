#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chdir, cwd } from 'node:process'
import { getLocalDependencies } from '../src/utils.ts'

const fixtureDir = join(tmpdir(), `capgo-native-dependencies-${process.pid}`)
const nodeModulesDir = join(fixtureDir, 'node_modules')

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

function writePackage(name, version, options = {}) {
  const { packageJson = {}, files = {} } = options
  const packageDir = join(nodeModulesDir, ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeJson(join(packageDir, 'package.json'), { name, version, ...packageJson })

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(packageDir, relativePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
}

try {
  mkdirSync(nodeModulesDir, { recursive: true })
  writeJson(join(fixtureDir, 'package.json'), {
    dependencies: {
      '@capgo/capacitor-updater': '^8.0.0',
      '@capgo/cli': 'workspace:*',
    },
    devDependencies: {},
  })

  writePackage('@capgo/capacitor-updater', '8.3.0', {
    packageJson: {
      capacitor: {
        ios: { src: 'ios' },
      },
    },
    files: {
      'ios/UpdaterPlugin.swift': 'final class UpdaterPlugin {}\n',
    },
  })
  writePackage('@capgo/cli', '8.21.0', {
    files: {
      'src/build/MacSigning.swift': 'final class MacSigning {}\n',
    },
  })

  const dependencies = await getLocalDependencies(join(fixtureDir, 'package.json'), nodeModulesDir)

  const nativeDependencies = dependencies.filter(dep => dep.native)
  const cliDependency = dependencies.find(dep => dep.name === '@capgo/cli')

  assert.equal(cliDependency?.native, false)
  assert.deepEqual(
    nativeDependencies.map(dep => dep.name),
    ['@capgo/capacitor-updater'],
  )
  assert.equal(nativeDependencies[0].version, '8.3.0')
  assert.equal(nativeDependencies[0].requested_version, '^8.0.0')

  console.log('unrelated native-looking packages are excluded from native compatibility metadata')
}
finally {
  rmSync(fixtureDir, { recursive: true, force: true })
}

// Monorepo hoisting: dependencies installed at the workspace root node_modules
// must be discovered when no explicit --node-modules path is given, by walking
// up parent directories from the app package.
const monorepoDir = join(tmpdir(), `capgo-native-dependencies-hoist-${process.pid}`)
const appDir = join(monorepoDir, 'packages', 'app')
const rootNodeModules = join(monorepoDir, 'node_modules')
const originalCwd = cwd()

try {
  mkdirSync(appDir, { recursive: true })
  mkdirSync(rootNodeModules, { recursive: true })

  writeJson(join(appDir, 'package.json'), {
    name: 'app',
    dependencies: {
      '@capgo/capacitor-updater': '^8.0.0',
    },
  })

  // Hoisted to the workspace root, not the app-local node_modules.
  const hoistedPackageDir = join(rootNodeModules, '@capgo', 'capacitor-updater')
  mkdirSync(join(hoistedPackageDir, 'ios'), { recursive: true })
  writeJson(join(hoistedPackageDir, 'package.json'), {
    name: '@capgo/capacitor-updater',
    version: '8.3.0',
    capacitor: { ios: { src: 'ios' } },
  })
  writeFileSync(join(hoistedPackageDir, 'ios', 'UpdaterPlugin.swift'), 'final class UpdaterPlugin {}\n')

  // Run from the app directory so the default node_modules resolution has to
  // walk up to the workspace root.
  chdir(appDir)
  const dependencies = await getLocalDependencies(join(appDir, 'package.json'), undefined)
  const updater = dependencies.find(dep => dep.name === '@capgo/capacitor-updater')

  assert.equal(updater?.version, '8.3.0')
  assert.equal(updater?.native, true)

  console.log('hoisted monorepo dependencies are resolved via the parent-directory walk')
}
finally {
  chdir(originalCwd)
  rmSync(monorepoDir, { recursive: true, force: true })
}
