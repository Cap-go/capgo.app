#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncAndroidVersion } from '../src/build/android-version.ts'

function createFixture(buildGradle, packageVersion = '13.0.0') {
  const projectDir = mkdtempSync(join(tmpdir(), 'capgo-android-version-'))
  mkdirSync(join(projectDir, 'android/app'), { recursive: true })
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ version: packageVersion }))
  writeFileSync(join(projectDir, 'android/app/build.gradle'), buildGradle)
  return projectDir
}

const buildGradle = `android {
  defaultConfig {
    // versionName "old-commented-version"
    versionName projectVersion
  }
}
`
const projectDir = createFixture(buildGradle)

try {
  assert.throws(
    () => syncAndroidVersion({ path: projectDir }),
    /versionName.*quoted string/i,
  )
  assert.equal(readFileSync(join(projectDir, 'android/app/build.gradle'), 'utf8'), buildGradle)
}
finally {
  rmSync(projectDir, { recursive: true, force: true })
}

const literalBuildGradle = `android {
  defaultConfig {
    // versionName "leave-this-comment-alone"
    versionName = '1.2.3'
  }
}
`
const literalProjectDir = createFixture(literalBuildGradle)

try {
  const result = syncAndroidVersion({ path: literalProjectDir })
  const updated = readFileSync(join(literalProjectDir, 'android/app/build.gradle'), 'utf8')

  assert.equal(result.changed, true)
  assert.match(updated, /\/\/ versionName "leave-this-comment-alone"/)
  assert.match(updated, /versionName = '13\.0\.0'/)
}
finally {
  rmSync(literalProjectDir, { recursive: true, force: true })
}

const unicodeBuildGradle = `android {
  // Release train 🚀
  defaultConfig {
    versionName "1.2.3"
  }
}
`
const unicodeProjectDir = createFixture(unicodeBuildGradle)

try {
  syncAndroidVersion({ path: unicodeProjectDir })
  const updated = readFileSync(join(unicodeProjectDir, 'android/app/build.gradle'), 'utf8')

  assert.equal(updated, unicodeBuildGradle.replace('versionName "1.2.3"', 'versionName "13.0.0"'))
}
finally {
  rmSync(unicodeProjectDir, { recursive: true, force: true })
}

const stringContentBuildGradle = `def settingName = "versionName"
android {
  defaultConfig {
    versionName "1.2.3"
  }
}
`
const stringContentProjectDir = createFixture(stringContentBuildGradle)

try {
  syncAndroidVersion({ path: stringContentProjectDir })
  const updated = readFileSync(join(stringContentProjectDir, 'android/app/build.gradle'), 'utf8')

  assert.equal(updated, stringContentBuildGradle.replace('versionName "1.2.3"', 'versionName "13.0.0"'))
}
finally {
  rmSync(stringContentProjectDir, { recursive: true, force: true })
}

const mixedBuildGradle = `android {
  defaultConfig {
    versionName "1.2.3"
  }
  productFlavors {
    production {
      versionName computedVersion()
    }
  }
}
`
const mixedProjectDir = createFixture(mixedBuildGradle)

try {
  assert.throws(
    () => syncAndroidVersion({ path: mixedProjectDir }),
    /versionName.*quoted string/i,
  )
  assert.equal(readFileSync(join(mixedProjectDir, 'android/app/build.gradle'), 'utf8'), mixedBuildGradle)
}
finally {
  rmSync(mixedProjectDir, { recursive: true, force: true })
}

const currentProjectDir = createFixture(`android {
  defaultConfig {
    versionName "13.0.0"
  }
}
`)

try {
  const result = syncAndroidVersion({ path: currentProjectDir })
  assert.equal(result.changed, false)
  assert.equal(result.replacements, 1)
}
finally {
  rmSync(currentProjectDir, { recursive: true, force: true })
}

const missingVersionProjectDir = createFixture(`android {
  defaultConfig {
    applicationId "com.demo.app"
  }
}
`)

try {
  assert.throws(
    () => syncAndroidVersion({ path: missingVersionProjectDir }),
    /versionName.*quoted string/i,
  )
}
finally {
  rmSync(missingVersionProjectDir, { recursive: true, force: true })
}

const kotlinOnlyProjectDir = mkdtempSync(join(tmpdir(), 'capgo-android-version-kts-'))
mkdirSync(join(kotlinOnlyProjectDir, 'android/app'), { recursive: true })
writeFileSync(join(kotlinOnlyProjectDir, 'package.json'), JSON.stringify({ version: '13.0.0' }))
writeFileSync(join(kotlinOnlyProjectDir, 'android/app/build.gradle.kts'), 'android { defaultConfig { versionName = "1.2.3" } }')

try {
  assert.throws(
    () => syncAndroidVersion({ path: kotlinOnlyProjectDir }),
    /Android build\.gradle not found/i,
  )
}
finally {
  rmSync(kotlinOnlyProjectDir, { recursive: true, force: true })
}
