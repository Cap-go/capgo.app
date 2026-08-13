// test/prescan/checks-android-project.test.ts
import { describe, expect, it } from 'bun:test'
import {
  agp8PackageAttr,
  applicationIdPresent,
  capacitorBuildGradleApplied,
  cordovaVarsPresent,
  flavorDimensions,
  flavorExists,
  googleServicesFile,
  gradlePropsHeuristics,
  gradleWrapperPresent,
  localPropertiesCommitted,
  minSdkCapacitor,
  minSdkDependencies,
  playSaJson,
  sdkFloors,
  targetSdkPlay,
  versionFields,
} from '../../src/build/prescan/checks/android-project'
import { makeCtx, makeProject } from './helpers'

const aCtx = (dir: string, extra: object = {}) => makeCtx({ projectDir: dir, platform: 'android', ...extra })

describe('android/cordova-vars-present', () => {
  it('errors when cordova plugins exist but variables file is missing', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { 'cordova-plugin-device': '2.0.0' } }),
      'android/app/build.gradle': '',
    })
    const f = await cordovaVarsPresent.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.fix).toContain('cap sync')
  })
  it('passes when the file exists', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { 'cordova-plugin-device': '2.0.0' } }),
      'android/capacitor-cordova-android-plugins/cordova.variables.gradle': 'ext {}',
    })
    expect(await cordovaVarsPresent.run(aCtx(dir))).toEqual([])
  })
  it('does not apply without cordova plugins', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ dependencies: {} }) })
    expect(cordovaVarsPresent.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/gradle-props-heuristics', () => {
  const settings = Array.from({ length: 40 }, (_, i) => `include ':plugin-${i}'`).join('\n')
  it('warns: many modules + parallel off', async () => {
    const dir = makeProject({
      'android/capacitor.settings.gradle': settings,
      'android/gradle.properties': 'org.gradle.jvmargs=-Xmx4096m',
    })
    const f = await gradlePropsHeuristics.run(aCtx(dir))
    expect(f.some(x => x.title.includes('parallel'))).toBe(true)
  })
  it('warns: workers.max=1 neutering parallel', async () => {
    const dir = makeProject({
      'android/capacitor.settings.gradle': settings,
      'android/gradle.properties': 'org.gradle.parallel=true\norg.gradle.workers.max=1',
    })
    const f = await gradlePropsHeuristics.run(aCtx(dir))
    expect(f.some(x => x.title.includes('workers.max'))).toBe(true)
  })
  it('warns: low heap with many modules', async () => {
    const dir = makeProject({
      'android/capacitor.settings.gradle': settings,
      'android/gradle.properties': 'org.gradle.parallel=true\norg.gradle.jvmargs=-Xmx1536m',
    })
    const f = await gradlePropsHeuristics.run(aCtx(dir))
    expect(f.some(x => x.title.includes('heap') || x.title.includes('Xmx'))).toBe(true)
  })
  it('silent on a small, tuned project', async () => {
    const dir = makeProject({
      'android/capacitor.settings.gradle': `include ':capacitor-android'`,
      'android/gradle.properties': 'org.gradle.jvmargs=-Xmx1536m',
    })
    expect(await gradlePropsHeuristics.run(aCtx(dir))).toEqual([])
  })
})

describe('android/play-sa-json', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64')
  it('errors on non-service-account json', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: b64({ type: 'authorized_user' }) } })
    expect((await playSaJson.run(ctx))[0]?.severity).toBe('error')
  })
  it('errors on missing private_key', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: b64({ type: 'service_account', client_email: 'a@b.iam' }) } })
    expect((await playSaJson.run(ctx))[0]?.detail).toContain('private_key')
  })
  it('passes a complete service account', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: b64({ type: 'service_account', client_email: 'a@b.iam', private_key: '-----BEGIN PRIVATE KEY-----' }) } })
    expect(await playSaJson.run(ctx)).toEqual([])
  })
  it('errors (not crashes) when the payload is not decodable JSON', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: Buffer.from('not json at all').toString('base64') } })
    const f = await playSaJson.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('valid JSON')
  })
  it('errors (not crashes) when the payload decodes to JSON null', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: Buffer.from('null').toString('base64') } })
    const f = await playSaJson.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('valid JSON')
  })
  it('errors (not crashes) when the payload decodes to a JSON array', async () => {
    const ctx = aCtx(makeProject({}), { credentials: { PLAY_CONFIG_JSON: b64([{ type: 'service_account' }]) } })
    const f = await playSaJson.run(ctx)
    expect(f[0]?.severity).toBe('error')
  })
})

describe('android/flavor-exists', () => {
  // realistic multi-line layout: buildTypes AFTER productFlavors — a greedy regex
  // would swallow buildTypes/release/dependencies into the flavor list
  const GROOVY_GRADLE = `apply plugin: 'com.android.application'

android {
    namespace "com.demo.app"
    flavorDimensions "env"
    productFlavors {
        dev {
            dimension "env"
            applicationIdSuffix ".dev"
        }
        prod {
            dimension "env"
        }
    }
    buildTypes {
        release {
            minifyEnabled true
        }
        debug {
            minifyEnabled false
        }
    }
}

dependencies {
    implementation project(':capacitor-android')
}
`
  const KTS_GRADLE = `plugins { id("com.android.application") }

android {
    namespace = "com.demo.app"
    flavorDimensions += "env"
    productFlavors {
        create("demo") {
            dimension = "env"
        }
        register("prod") {
            dimension = "env"
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`
  it('errors on unknown flavor, listing ALL declared flavors (and nothing else)', async () => {
    const ctx = aCtx(makeProject({ 'android/app/build.gradle': GROOVY_GRADLE }), { androidFlavor: 'staging' })
    const f = await flavorExists.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toBe('declared flavors: dev, prod')
  })
  it('passes the FIRST declared flavor', async () => {
    const ctx = aCtx(makeProject({ 'android/app/build.gradle': GROOVY_GRADLE }), { androidFlavor: 'dev' })
    expect(await flavorExists.run(ctx)).toEqual([])
  })
  it('passes the SECOND declared flavor', async () => {
    const ctx = aCtx(makeProject({ 'android/app/build.gradle': GROOVY_GRADLE }), { androidFlavor: 'prod' })
    expect(await flavorExists.run(ctx)).toEqual([])
  })
  it('errors when a buildType name is passed as a flavor (the classic user mistake)', async () => {
    const ctx = aCtx(makeProject({ 'android/app/build.gradle': GROOVY_GRADLE }), { androidFlavor: 'release' })
    const f = await flavorExists.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).not.toContain('release')
    expect(f[0]?.detail).not.toContain('buildTypes')
  })
  it('parses Kotlin DSL create()/register() flavor declarations', async () => {
    const dir = makeProject({ 'android/app/build.gradle.kts': KTS_GRADLE })
    expect(await flavorExists.run(aCtx(dir, { androidFlavor: 'demo' }))).toEqual([])
    expect(await flavorExists.run(aCtx(dir, { androidFlavor: 'prod' }))).toEqual([])
    const f = await flavorExists.run(aCtx(dir, { androidFlavor: 'release' }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toBe('declared flavors: demo, prod')
  })
  it('errors when no productFlavors block is declared at all', async () => {
    const ctx = aCtx(makeProject({ 'android/app/build.gradle': `android { buildTypes { release {} } }` }), { androidFlavor: 'dev' })
    const f = await flavorExists.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('declares no productFlavors')
  })
  it('also handles the single-line gradle fixture', async () => {
    const gradle = `android { productFlavors { dev { dimension "env" } prod { dimension "env" } } }`
    const dir = makeProject({ 'android/app/build.gradle': gradle })
    expect(await flavorExists.run(aCtx(dir, { androidFlavor: 'prod' }))).toEqual([])
    const f = await flavorExists.run(aCtx(dir, { androidFlavor: 'staging' }))
    expect(f[0]?.detail).toBe('declared flavors: dev, prod')
  })
})

describe('android/agp8-package-attr', () => {
  it('errors when manifest has package= and gradle has namespace', async () => {
    const dir = makeProject({
      'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.demo.app"><application/></manifest>`,
      'android/app/build.gradle': `android { namespace "com.demo.app" }`,
    })
    expect((await agp8PackageAttr.run(aCtx(dir)))[0]?.severity).toBe('error')
  })
  it('passes a namespace-only project', async () => {
    const dir = makeProject({
      'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>`,
      'android/app/build.gradle': `android { namespace "com.demo.app" }`,
    })
    expect(await agp8PackageAttr.run(aCtx(dir))).toEqual([])
  })
  // Regression: a commented-out `<manifest ... package="…">` migration leftover
  // (a common shape during AGP 8 / namespace migration) must NOT block the
  // build — AGP ignores comments. The scan is comment-stripped like every
  // sibling manifest check.
  it('does NOT block on a commented-out package= attribute (no live package attr)', async () => {
    const dir = makeProject({
      'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <!-- Migrated to namespace in build.gradle; was: <manifest package="com.old.app"> -->
  <application/>
</manifest>`,
      'android/app/build.gradle': `android { namespace "com.demo.app" }`,
    })
    expect(await agp8PackageAttr.run(aCtx(dir))).toEqual([])
  })
  it('does NOT block on a multi-line commented-out <manifest …> opening tag', async () => {
    const dir = makeProject({
      'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <!--
    Legacy reference:
    <manifest xmlns:android="http://schemas.android.com/apk/res/android"
      package="com.legacy.app">
  -->
  <application/>
</manifest>`,
      'android/app/build.gradle': `android { namespace "com.demo.app" }`,
    })
    expect(await agp8PackageAttr.run(aCtx(dir))).toEqual([])
  })
  it('still blocks when a LIVE package= and namespace coexist (comment elsewhere)', async () => {
    const dir = makeProject({
      'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.demo.app">
  <!-- this comment is unrelated -->
  <application/>
</manifest>`,
      'android/app/build.gradle': `android { namespace "com.demo.app" }`,
    })
    expect((await agp8PackageAttr.run(aCtx(dir)))[0]?.severity).toBe('error')
  })
})

describe('android/applicationid-present', () => {
  it('passes when defaultConfig declares a live applicationId', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    applicationId "com.demo.app"
  }
}`,
    })
    expect(await applicationIdPresent.run(aCtx(dir))).toEqual([])
  })
  it('passes the Kotlin DSL form applicationId = "x"', async () => {
    const dir = makeProject({
      'android/app/build.gradle.kts': `android {
  defaultConfig {
    applicationId = "com.demo.app"
  }
}`,
    })
    expect(await applicationIdPresent.run(aCtx(dir))).toEqual([])
  })
  it('passes when only a flavor provides applicationIdSuffix', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig { }
  productFlavors {
    dev {
      applicationIdSuffix ".dev"
    }
  }
}`,
    })
    expect(await applicationIdPresent.run(aCtx(dir))).toEqual([])
  })
  it('errors when no applicationId is declared anywhere', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig { }
}`,
    })
    const f = await applicationIdPresent.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.fix).toContain('applicationId')
  })
  it('does NOT count a commented-out applicationId', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    // applicationId "com.ghost.commented"
  }
}`,
    })
    const f = await applicationIdPresent.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
  })
  it('does not apply without an app/build.gradle', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(applicationIdPresent.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/capacitor-build-gradle-applied', () => {
  it('passes when apply present and capacitor.build.gradle exists', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `apply from: "capacitor.build.gradle"\nandroid { }`,
      'android/app/capacitor.build.gradle': 'android { }',
    })
    expect(await capacitorBuildGradleApplied.run(aCtx(dir))).toEqual([])
  })
  it('errors when apply present but capacitor.build.gradle missing', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `apply from: 'capacitor.build.gradle'\nandroid { }`,
    })
    const f = await capacitorBuildGradleApplied.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.fix).toContain('cap sync')
  })
  it('errors when the apply line is absent', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { }`,
      'android/app/capacitor.build.gradle': 'android { }',
    })
    const f = await capacitorBuildGradleApplied.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
  })
  it('does not count a commented-out apply line', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `// apply from: 'capacitor.build.gradle'\nandroid { }`,
      'android/app/capacitor.build.gradle': 'android { }',
    })
    const f = await capacitorBuildGradleApplied.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
  })
})

describe('android/gradle-wrapper-present', () => {
  it('passes when wrapper properties declare a distributionUrl', async () => {
    const dir = makeProject({
      'android/app/build.gradle': 'android { }',
      'android/gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-all.zip',
    })
    expect(await gradleWrapperPresent.run(aCtx(dir))).toEqual([])
  })
  it('errors when gradle-wrapper.properties is missing', async () => {
    const dir = makeProject({ 'android/app/build.gradle': 'android { }' })
    const f = await gradleWrapperPresent.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.fix).toContain('cap sync')
  })
  it('errors when distributionUrl is absent from the wrapper', async () => {
    const dir = makeProject({
      'android/app/build.gradle': 'android { }',
      'android/gradle/wrapper/gradle-wrapper.properties': 'zipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists',
    })
    const f = await gradleWrapperPresent.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('distributionUrl')
  })
  it('does not apply without an android directory', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(gradleWrapperPresent.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/flavor-dimensions', () => {
  it('errors when a flavor lacks dimension and no top-level flavorDimensions', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  productFlavors {
    dev { }
    prod { dimension "env" }
  }
}`,
    })
    const f = await flavorDimensions.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toContain('dev')
    expect(f[0]?.detail).not.toContain('prod')
  })
  it('passes when a top-level flavorDimensions is declared', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  flavorDimensions "env"
  productFlavors {
    dev { }
    prod { }
  }
}`,
    })
    expect(await flavorDimensions.run(aCtx(dir))).toEqual([])
  })
  it('passes when every flavor declares a dimension', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  productFlavors {
    dev { dimension "env" }
    prod { dimension "env" }
  }
}`,
    })
    expect(await flavorDimensions.run(aCtx(dir))).toEqual([])
  })
  it('does not apply when no productFlavors block parses a flavor', () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { buildTypes { release { } } }`,
    })
    expect(flavorDimensions.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/google-services-file', () => {
  const APPLY = `apply plugin: 'com.google.gms.google-services'`
  it('errors on an unguarded gms apply with no google-services.json', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { }\n${APPLY}`,
    })
    const f = await googleServicesFile.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.fix).toContain('google-services.json')
  })
  it('does not apply when the gms apply is guarded inside try/if', () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { }
try {
  def servicesJSON = file('google-services.json')
  if (servicesJSON.text) {
    ${APPLY}
  }
} catch (Exception e) { }`,
    })
    expect(googleServicesFile.appliesTo!(aCtx(dir))).toBe(false)
  })
  it('passes when unguarded apply but google-services.json is present', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { }\n${APPLY}`,
      'android/app/google-services.json': '{}',
    })
    expect(await googleServicesFile.run(aCtx(dir))).toEqual([])
  })
  it('does not apply when no gms apply is detected', () => {
    const dir = makeProject({ 'android/app/build.gradle': 'android { }' })
    expect(googleServicesFile.appliesTo!(aCtx(dir))).toBe(false)
  })
  it('does not apply when the gms apply is commented out', () => {
    const dir = makeProject({ 'android/app/build.gradle': `android { }\n// ${APPLY}` })
    expect(googleServicesFile.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/local-properties-committed', () => {
  it('warns on an absolute sdk.dir and NEVER echoes the path', async () => {
    const dir = makeProject({
      'android/local.properties': 'sdk.dir=/Users/secret/Library/Android/sdk',
    })
    const f = await localPropertiesCommitted.run(aCtx(dir))
    expect(f[0]?.severity).toBe('warning')
    expect(f[0]?.detail).toContain('sdk.dir')
    expect(f[0]?.detail).not.toContain('/Users/secret')
    expect(f[0]?.title).not.toContain('/Users/secret')
    expect(f[0]?.fix).not.toContain('/Users/secret')
  })
  it('warns on a Windows absolute ndk.dir without echoing the path', async () => {
    const dir = makeProject({
      'android/local.properties': 'ndk.dir=C:\\\\Users\\\\secret\\\\AppData\\\\ndk',
    })
    const f = await localPropertiesCommitted.run(aCtx(dir))
    expect(f[0]?.severity).toBe('warning')
    expect(f[0]?.detail).toContain('ndk.dir')
    expect(f[0]?.detail).not.toContain('secret')
  })
  it('is silent when local.properties has no absolute dir', async () => {
    const dir = makeProject({
      'android/local.properties': 'some.key=value',
    })
    expect(await localPropertiesCommitted.run(aCtx(dir))).toEqual([])
  })
  it('does not apply when local.properties is absent', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(localPropertiesCommitted.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/sdk-floors', () => {
  it('warns once per violated floor', async () => {
    const dir = makeProject({
      'android/variables.gradle': `ext {
  minSdkVersion = 21
  compileSdkVersion = 33
  targetSdkVersion = 33
}`,
    })
    const f = await sdkFloors.run(aCtx(dir))
    expect(f.every(x => x.severity === 'warning')).toBe(true)
    expect(f.some(x => x.title.includes('compileSdk'))).toBe(true)
    expect(f.some(x => x.title.includes('targetSdk'))).toBe(true)
    expect(f.some(x => x.title.includes('minSdk'))).toBe(true)
  })
  it('is silent when all floors are satisfied', async () => {
    const dir = makeProject({
      'android/variables.gradle': `ext {
  minSdkVersion = 23
  compileSdkVersion = 34
  targetSdkVersion = 35
}`,
    })
    expect(await sdkFloors.run(aCtx(dir))).toEqual([])
  })
  it('skips an unresolved dimension silently', async () => {
    const dir = makeProject({
      'android/variables.gradle': `ext { targetSdkVersion = 30 }`,
    })
    const f = await sdkFloors.run(aCtx(dir))
    expect(f.length).toBe(1)
    expect(f[0]?.title).toContain('targetSdk')
  })
  it('does not apply when no SDK dimension resolves', () => {
    const dir = makeProject({ 'android/app/build.gradle': 'android { }' })
    expect(sdkFloors.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/target-sdk-play', () => {
  it('errors when targetSdk < 34 (cannot publish)', async () => {
    const dir = makeProject({ 'android/variables.gradle': 'ext { targetSdkVersion = 33 }' })
    const f = await targetSdkPlay.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
  })
  it('errors when 34<=target<35 AND uploading to Play', async () => {
    const dir = makeProject({ 'android/variables.gradle': 'ext { targetSdkVersion = 34 }' })
    const b64 = Buffer.from(JSON.stringify({ type: 'service_account' })).toString('base64')
    const f = await targetSdkPlay.run(aCtx(dir, { credentials: { PLAY_CONFIG_JSON: b64 } }))
    expect(f[0]?.severity).toBe('error')
  })
  it('warns when 34<=target<35 and NOT uploading to Play', async () => {
    const dir = makeProject({ 'android/variables.gradle': 'ext { targetSdkVersion = 34 }' })
    const f = await targetSdkPlay.run(aCtx(dir))
    expect(f[0]?.severity).toBe('warning')
  })
  it('passes when target>=35', async () => {
    const dir = makeProject({ 'android/variables.gradle': 'ext { targetSdkVersion = 35 }' })
    expect(await targetSdkPlay.run(aCtx(dir))).toEqual([])
  })
  it('does not apply when targetSdk is unresolved', () => {
    const dir = makeProject({ 'android/app/build.gradle': 'android { }' })
    expect(targetSdkPlay.appliesTo!(aCtx(dir))).toBe(false)
  })
  // Regression: a low per-flavor targetSdk literal must not produce a false
  // blocking error when defaultConfig (via variables.gradle) targets a
  // Play-acceptable SDK. The active build targets 35, so no finding.
  it('does NOT block on a low per-flavor targetSdk when defaultConfig targets 35', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: {} }),
      'android/app/build.gradle': `android {
  productFlavors {
    old {
      targetSdkVersion 28
    }
  }
  defaultConfig {
    targetSdkVersion rootProject.ext.targetSdkVersion
  }
}`,
      'android/variables.gradle': 'ext { targetSdkVersion = 35 }',
    })
    const b64 = Buffer.from(JSON.stringify({ type: 'service_account' })).toString('base64')
    expect(await targetSdkPlay.run(aCtx(dir, { credentials: { PLAY_CONFIG_JSON: b64 } }))).toEqual([])
  })
})

describe('android/min-sdk-capacitor', () => {
  const pkg = (capVersion: string) => JSON.stringify({ dependencies: { '@capacitor/core': capVersion } })
  it('errors when minSdk is below the Capacitor 7 floor (23)', async () => {
    const dir = makeProject({
      'package.json': pkg('^7.0.0'),
      'android/variables.gradle': 'ext { minSdkVersion = 22 }',
    })
    const f = await minSdkCapacitor.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toContain('23')
  })
  it('passes when minSdk meets the Capacitor 7 floor', async () => {
    const dir = makeProject({
      'package.json': pkg('7.2.0'),
      'android/variables.gradle': 'ext { minSdkVersion = 23 }',
    })
    expect(await minSdkCapacitor.run(aCtx(dir))).toEqual([])
  })
  it('uses the Cap6 floor (22)', async () => {
    const dir = makeProject({
      'package.json': pkg('^6.1.0'),
      'android/variables.gradle': 'ext { minSdkVersion = 22 }',
    })
    expect(await minSdkCapacitor.run(aCtx(dir))).toEqual([])
  })
  it('does not apply when Capacitor major is unresolvable', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: {} }),
      'android/variables.gradle': 'ext { minSdkVersion = 22 }',
    })
    expect(minSdkCapacitor.appliesTo!(aCtx(dir))).toBe(false)
  })
  it('does not apply when minSdk is unresolvable', () => {
    const dir = makeProject({ 'package.json': pkg('^7.0.0') })
    expect(minSdkCapacitor.appliesTo!(aCtx(dir))).toBe(false)
  })
  // Regression: a low per-flavor minSdk literal must not drive a false blocking
  // error when defaultConfig (via variables.gradle) meets the Capacitor floor.
  it('does NOT block on a low per-flavor minSdk when defaultConfig meets the Cap6 floor', async () => {
    const dir = makeProject({
      'package.json': pkg('^6.0.0'),
      'android/app/build.gradle': `android {
  productFlavors {
    legacy {
      minSdkVersion 19
    }
  }
  defaultConfig {
    minSdkVersion rootProject.ext.minSdkVersion
  }
}`,
      'android/variables.gradle': 'ext { minSdkVersion = 24 }',
    })
    expect(await minSdkCapacitor.run(aCtx(dir))).toEqual([])
  })
})

describe('android/min-sdk-dependencies', () => {
  const settings = `include ':capgo-capacitor-llm'
project(':capgo-capacitor-llm').projectDir = new File('../plugins/capgo-capacitor-llm/android')`

  it('errors when a synced plugin depends on a library with a higher minSdk floor', async () => {
    const dir = makeProject({
      'android/variables.gradle': 'ext { minSdkVersion = 24 }',
      'android/capacitor.settings.gradle': settings,
      'plugins/capgo-capacitor-llm/android/build.gradle': `dependencies {
  implementation 'com.google.mlkit:genai-prompt:1.0.0-beta2'
}`,
    })
    const f = await minSdkDependencies.run(aCtx(dir))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('26')
    expect(f[0]?.detail).toContain('genai-prompt')
  })

  it('passes when minSdk meets the plugin dependency floor', async () => {
    const dir = makeProject({
      'android/variables.gradle': 'ext { minSdkVersion = 26 }',
      'android/capacitor.settings.gradle': settings,
      'plugins/capgo-capacitor-llm/android/build.gradle': `dependencies {
  implementation 'com.google.mlkit:genai-prompt:1.0.0-beta2'
}`,
    })
    expect(await minSdkDependencies.run(aCtx(dir))).toEqual([])
  })

  it('does not apply when minSdk is unresolvable', () => {
    const dir = makeProject({ 'android/capacitor.settings.gradle': settings })
    expect(minSdkDependencies.appliesTo!(aCtx(dir))).toBe(false)
  })
})

describe('android/version-fields', () => {
  it('passes when versionCode and versionName are in defaultConfig', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    versionCode 1
    versionName "1.0"
  }
}`,
    })
    expect(await versionFields.run(aCtx(dir))).toEqual([])
  })
  it('accepts a gradle variable/function as a present versionCode', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    versionCode getVersionCode()
    versionName project.versionName
  }
}`,
    })
    expect(await versionFields.run(aCtx(dir))).toEqual([])
  })
  it('warns when versionCode is missing and NOT uploading', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    versionName "1.0"
  }
}`,
    })
    const f = await versionFields.run(aCtx(dir))
    expect(f.some(x => x.severity === 'warning' && x.title.includes('versionCode'))).toBe(true)
  })
  it('escalates the missing versionCode to error when uploading to Play', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    versionName "1.0"
  }
}`,
    })
    const b64 = Buffer.from(JSON.stringify({ type: 'service_account' })).toString('base64')
    const f = await versionFields.run(aCtx(dir, { credentials: { PLAY_CONFIG_JSON: b64 } }))
    expect(f.some(x => x.severity === 'error' && x.title.includes('versionCode'))).toBe(true)
  })
  it('falls back to the manifest for versionCode/versionName', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { defaultConfig { } }`,
      'android/app/src/main/AndroidManifest.xml': `<manifest android:versionCode="3" android:versionName="1.2"><application/></manifest>`,
    })
    expect(await versionFields.run(aCtx(dir))).toEqual([])
  })
  it('warns on a missing versionName', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android {
  defaultConfig {
    versionCode 1
  }
}`,
    })
    const f = await versionFields.run(aCtx(dir))
    expect(f.some(x => x.title.includes('versionName'))).toBe(true)
  })
  it('does not apply without an app/build.gradle', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(versionFields.appliesTo!(aCtx(dir))).toBe(false)
  })
  it('recognizes the Kotlin-DSL assignment form (versionName = "1.0") in build.gradle.kts', async () => {
    const dir = makeProject({
      'android/app/build.gradle.kts': `android {
  defaultConfig {
    versionCode = 1
    versionName = "1.0"
  }
}`,
    })
    expect(await versionFields.run(aCtx(dir))).toEqual([])
  })
  it('accepts a KTS variable/function as a present versionName (no quote)', async () => {
    const dir = makeProject({
      'android/app/build.gradle.kts': `android {
  defaultConfig {
    versionCode = computeVersionCode()
    versionName = libVersion
  }
}`,
    })
    expect(await versionFields.run(aCtx(dir))).toEqual([])
  })
})
