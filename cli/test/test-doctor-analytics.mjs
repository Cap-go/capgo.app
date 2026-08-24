#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  buildOutdatedInstallCommand,
  computeDoctorAnalyticsTags,
  getPMAndCommandForDir,
  listOutdatedDependencies,
  packagesForDoctorUpdateChoice,
  partitionOutdatedDependencies,
  resolveDoctorProjectRoot,
} from '../src/app/info.ts'

console.log('🧪 Testing doctor analytics tags...\n')

const tags = computeDoctorAnalyticsTags(
  { '@capgo/capacitor-updater': '6.0.0', '@capacitor/core': '6.1.0' },
  { '@capgo/capacitor-updater': '6.2.0', '@capacitor/core': '6.1.0' },
)
assert.equal(tags.is_outdated, true, 'updater behind latest => outdated')
assert.equal(tags.dependency_count, 2)
assert.equal(tags.outdated_count, 1)

const fresh = computeDoctorAnalyticsTags(
  { '@capgo/capacitor-updater': '6.2.0' },
  { '@capgo/capacitor-updater': '6.2.0' },
)
assert.equal(fresh.is_outdated, false)
assert.equal(fresh.dependency_count, 1)
assert.equal(fresh.outdated_count, 0)

// edge cases
const empty = computeDoctorAnalyticsTags({}, {})
assert.equal(empty.is_outdated, false)
assert.equal(empty.dependency_count, 0)
assert.equal(empty.outdated_count, 0)

const allOutdated = computeDoctorAnalyticsTags({ a: '1.0.0', b: '2.0.0' }, { a: '1.1.0', b: '2.1.0' })
assert.equal(allOutdated.is_outdated, true)
assert.equal(allOutdated.dependency_count, 2)
assert.equal(allOutdated.outdated_count, 2)

// stringify mismatch / missing latest key is NOT outdated
const missingLatest = listOutdatedDependencies(
  { '@capgo/cli': '1.0.0', '@capgo/capacitor-updater': '6.0.0' },
  { '@capgo/capacitor-updater': '6.2.0' },
)
assert.deepEqual(missingLatest, [
  { name: '@capgo/capacitor-updater', installed: '6.0.0', latest: '6.2.0' },
])
assert.equal(computeDoctorAnalyticsTags(
  { '@capgo/cli': '1.0.0', '@capgo/capacitor-updater': '6.0.0' },
  { '@capgo/capacitor-updater': '6.2.0' },
).is_outdated, true)
assert.equal(computeDoctorAnalyticsTags(
  { '@capgo/cli': '1.0.0', '@capgo/capacitor-updater': '6.0.0' },
  { '@capgo/capacitor-updater': '6.2.0' },
).outdated_count, 1)

const extraLatestKeys = listOutdatedDependencies(
  { '@capgo/cli': '1.0.0' },
  { '@capgo/cli': '1.0.0', '@capgo/capacitor-updater': '6.2.0' },
)
assert.deepEqual(extraLatestKeys, [])
assert.equal(computeDoctorAnalyticsTags(
  { '@capgo/cli': '1.0.0' },
  { '@capgo/cli': '1.0.0', '@capgo/capacitor-updater': '6.2.0' },
).is_outdated, false)

// mixed outdated vs up-to-date counts
const mixed = listOutdatedDependencies(
  {
    '@capgo/capacitor-updater': '6.0.0',
    '@capacitor/core': '6.1.0',
    '@capawesome/capacitor-app': '6.0.0',
  },
  {
    '@capgo/capacitor-updater': '6.2.0',
    '@capacitor/core': '6.1.0',
    '@capawesome/capacitor-app': '6.1.0',
  },
)
assert.deepEqual(mixed, [
  { name: '@capgo/capacitor-updater', installed: '6.0.0', latest: '6.2.0' },
  { name: '@capawesome/capacitor-app', installed: '6.0.0', latest: '6.1.0' },
])
assert.equal(computeDoctorAnalyticsTags(
  {
    '@capgo/capacitor-updater': '6.0.0',
    '@capacitor/core': '6.1.0',
    '@capawesome/capacitor-app': '6.0.0',
  },
  {
    '@capgo/capacitor-updater': '6.2.0',
    '@capacitor/core': '6.1.0',
    '@capawesome/capacitor-app': '6.1.0',
  },
).outdated_count, 2)

// recovery partitioning and install command helpers
const outdatedSample = [
  { name: '@capgo/capacitor-updater', installed: '6.0.0', latest: '6.2.0' },
  { name: '@capacitor/core', installed: '6.0.0', latest: '6.1.0' },
]
const partitioned = partitionOutdatedDependencies(outdatedSample)
assert.equal(partitioned.capgo.length, 1)
assert.equal(partitioned.other.length, 1)

assert.equal(
  packagesForDoctorUpdateChoice('capgo-only', partitioned.capgo, partitioned.other).length,
  1,
)
assert.equal(
  packagesForDoctorUpdateChoice('all', partitioned.capgo, partitioned.other).length,
  2,
)
assert.equal(
  packagesForDoctorUpdateChoice('skip', partitioned.capgo, partitioned.other).length,
  0,
)

const installCommand = buildOutdatedInstallCommand(
  { pm: 'npm', command: 'install', installCommand: 'npm install', runner: 'npx' },
  outdatedSample,
)
assert.equal(
  installCommand,
  'npm install @capgo/capacitor-updater@latest @capacitor/core@latest',
)

assert.equal(resolveDoctorProjectRoot('/apps/mobile/package.json'), '/apps/mobile')
assert.equal(
  resolveDoctorProjectRoot('/apps/mobile/package.json,/apps/shared/package.json'),
  '/apps/mobile',
)
assert.equal(getPMAndCommandForDir('/tmp/project').installCommand.includes('install'), true)

console.log('✅ doctor analytics tags tests passed')
