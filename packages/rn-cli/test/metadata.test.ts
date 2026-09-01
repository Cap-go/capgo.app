import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import {
  dependencyDeclaresReactNativeNative,
  getReactNativeLocalDependencies,
  toNativePackages,
} from '../src/metadata.ts'

function writeJson(path: string, data: unknown) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

function writePackage(
  nodeModulesDir: string,
  name: string,
  version: string,
  options: { packageJson?: Record<string, unknown>, files?: Record<string, string> } = {},
) {
  const segments = name.split('/')
  const packageDir = join(nodeModulesDir, ...segments)
  mkdirSync(packageDir, { recursive: true })
  writeJson(join(packageDir, 'package.json'), { name, version, ...options.packageJson })
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const filePath = join(packageDir, relativePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
}

describe('react native metadata scanner', () => {
  const fixtureDir = join(tmpdir(), `capgo-rn-metadata-${process.pid}`)
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('detects @capgo/react-native-updater as a native package', async () => {
    const nodeModulesDir = join(fixtureDir, 'node_modules')
    mkdirSync(nodeModulesDir, { recursive: true })
    writeJson(join(fixtureDir, 'package.json'), {
      dependencies: {
        '@capgo/react-native-updater': '^0.1.0',
        'lodash': '^4.0.0',
      },
    })
    writePackage(nodeModulesDir, '@capgo/react-native-updater', '0.1.0', {
      files: {
        'android/build.gradle': 'apply plugin: "com.android.library"\n',
        'ios/CapgoUpdater.swift': 'final class CapgoUpdater {}\n',
        'CapgoReactNativeUpdater.podspec': 'Pod::Spec.new do |s|\nend\n',
      },
    })
    writePackage(nodeModulesDir, 'lodash', '4.17.21')

    const dependencies = await getReactNativeLocalDependencies(fixtureDir)
    const native = toNativePackages(dependencies)

    expect(native.map(pkg => pkg.name)).toEqual(['@capgo/react-native-updater'])
    expect(native[0]?.version).toBe('0.1.0')
    expect(native[0]?.ios_checksum).toBeString()
    expect(native[0]?.android_checksum).toBeString()
  })

  it('detects react-native.config.js packages', () => {
    const packageDir = join(fixtureDir, 'with-config')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'react-native.config.js'), 'module.exports = {};\n')
    assert.equal(dependencyDeclaresReactNativeNative(packageDir), true)
  })

  it('ignores pure JS dependencies', async () => {
    const nodeModulesDir = join(fixtureDir, 'js-only', 'node_modules')
    mkdirSync(nodeModulesDir, { recursive: true })
    writeJson(join(fixtureDir, 'js-only', 'package.json'), {
      dependencies: { 'is-odd': '^3.0.0' },
    })
    writePackage(nodeModulesDir, 'is-odd', '3.0.1')

    const dependencies = await getReactNativeLocalDependencies(join(fixtureDir, 'js-only'))
    expect(toNativePackages(dependencies)).toEqual([])
  })
})
