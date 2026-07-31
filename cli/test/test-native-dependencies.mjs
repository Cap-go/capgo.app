#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
