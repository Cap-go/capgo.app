import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { getBuilderAppId } from '../src/build/app-id.ts'
import { loadConfig, writeConfigUpdater } from '../src/config/index.ts'
import { getAppId } from '../src/utils.ts'
import { flushAnalytics, isBuilderInvocation, resolveTrackingContext, trackCommandInvoked } from '../src/analytics/track.ts'
import { buildDeps } from '../src/build/onboarding/mcp/onboarding-tools.ts'
import { buildScanContext } from '../src/build/prescan/context.ts'
import { generateWorkflow } from '../src/build/onboarding/workflow-generator.ts'

const require = createRequire(import.meta.url)
const { loadConfig: loadCapacitorConfig } = require('@capacitor/cli/dist/config')
const { syncCommand } = require('@capacitor/cli/dist/tasks/sync')
const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(cliRoot, '.builder-app-id-config-'))
const nativeId = 'com.example.native'
const updaterId = 'com.example.ota'
const builderId = 'com.example.builder'

function configFor(builderValue = builderId) {
  return {
    appId: nativeId,
    appName: 'Builder config proof',
    webDir: 'www',
    plugins: {
      CapacitorUpdater: { appId: updaterId },
      CapgoBuilder: { capgoBuilderAppId: builderValue },
    },
  }
}

function errorsFor(path) {
  const program = ts.createProgram([path], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })
  return ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
}

try {
  assert.equal(getBuilderAppId(undefined, configFor()), builderId)
  assert.equal(getBuilderAppId('com.example.explicit', configFor()), 'com.example.explicit')
  assert.equal(getBuilderAppId(undefined, { ...configFor(), plugins: { CapacitorUpdater: { appId: updaterId } } }), updaterId)
  assert.equal(getBuilderAppId(undefined, { ...configFor(), plugins: { CapacitorUpdater: { appId: updaterId } } }, 'native'), nativeId)
  assert.equal(getBuilderAppId(undefined, configFor(), 'native'), builderId)
  assert.equal(getBuilderAppId('', { ...configFor(), plugins: {} }, 'native', 'defined'), '', 'prescan keeps its nullish explicit-ID fallback')
  assert.equal(getAppId(undefined, configFor()), updaterId, 'OTA resolution must ignore the Builder field')
  const workflow = generateWorkflow({
    appId: getBuilderAppId(undefined, configFor()),
    defaultPlatform: 'ios',
    packageManager: 'npm',
    buildScript: { type: 'skip' },
    secretKeys: [],
  })
  assert.match(workflow.content, /@capgo\/cli@latest build request com\.example\.builder/)
  assert.doesNotMatch(workflow.content, /build request com\.example\.native/)
  for (const value of ['', '   ', 42, null, undefined]) {
    const invalid = configFor()
    invalid.plugins.CapgoBuilder.capgoBuilderAppId = value
    assert.throws(() => getBuilderAppId(undefined, invalid), /plugins\.CapgoBuilder\.capgoBuilderAppId must be a non-empty string/)
    assert.equal(getBuilderAppId('com.example.explicit', invalid), 'com.example.explicit', 'explicit app IDs bypass invalid Builder config')
  }
  assert.equal(isBuilderInvocation('build request'), true)
  assert.equal(isBuilderInvocation('build credentials save'), true)
  assert.equal(isBuilderInvocation('mcp:start_capgo_build'), true)
  assert.equal(isBuilderInvocation('mcp:capgo_builder_onboarding_next_step'), true)
  assert.equal(isBuilderInvocation('app list'), false)
  assert.equal(isBuilderInvocation('bundle upload'), false)
  assert.equal(isBuilderInvocation('mcp:capgo_init_next_step'), false)

  // An ordinary CapacitorConfig object literal rejects the proposed root field.
  // Its documented plugins map accepts the Builder namespace without augmentation.
  const rootAttempt = join(root, 'root-attempt.ts')
  writeFileSync(rootAttempt, `import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = { appId: '${nativeId}', appName: 'Proof', webDir: 'www', capgoBuilderAppId: '${builderId}' }
export default config
`)
  assert.ok(errorsFor(rootAttempt).some(error => error.code === 2353 && ts.flattenDiagnosticMessageText(error.messageText, ' ').includes('capgoBuilderAppId')))

  for (const extension of ['ts', 'json', 'js']) {
    const project = join(root, extension)
    mkdirSync(join(project, 'www'), { recursive: true })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: `builder-proof-${extension}`, version: '1.0.0', private: true }))
    writeFileSync(join(project, 'www', 'index.html'), '<!doctype html><title>proof</title>')
    const path = join(project, `capacitor.config.${extension}`)
    const config = configFor()
    if (extension === 'ts') {
      writeFileSync(path, `import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = ${JSON.stringify(config, null, 2)}
export default config
`)
      assert.deepEqual(errorsFor(path), [], 'the plugins field must typecheck as an ordinary CapacitorConfig')
    }
    else if (extension === 'js') {
      writeFileSync(path, `/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = ${JSON.stringify(config, null, 2)}
module.exports = config
`)
    }
    else {
      writeFileSync(path, JSON.stringify(config, null, 2))
    }

    const previousCwd = process.cwd()
    try {
      process.chdir(project)
      assert.equal(process.cwd(), project)
      const capacitor = await loadCapacitorConfig()
      assert.equal(capacitor.app.appId, nativeId)
      assert.equal(capacitor.app.extConfig.plugins.CapgoBuilder.capgoBuilderAppId, builderId)
      await syncCommand(capacitor, 'web')
      assert.equal((await loadCapacitorConfig()).app.extConfig.plugins.CapgoBuilder.capgoBuilderAppId, builderId)

      const capgo = await loadConfig()
      assert.equal(getBuilderAppId(undefined, capgo.config), builderId)
      if (extension === 'ts') {
        const aborted = new AbortController()
        aborted.abort()
        assert.equal((await resolveTrackingContext('builder-config-proof', aborted.signal, true)).appId, builderId)
        assert.equal((await resolveTrackingContext('builder-config-proof', aborted.signal, false)).appId, updaterId, 'non-Builder telemetry stays on OTA resolution')
        const originalFetch = globalThis.fetch
        const events = []
        globalThis.fetch = async (url, init) => {
          if (String(url).endsWith('/private/events'))
            events.push(JSON.parse(init.body))
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        try {
          const commandContext = { flags: [], positional_arg_count: 0 }
          trackCommandInvoked('build request', commandContext, 'builder-config-proof')
          await flushAnalytics()
          assert.equal(events.at(-1)?.tags.app_id, builderId)
          trackCommandInvoked('app list', commandContext, 'builder-config-proof')
          await flushAnalytics()
          assert.equal(events.at(-1)?.tags.app_id, updaterId, 'app list telemetry must ignore the Builder field')
        }
        finally {
          globalThis.fetch = originalFetch
        }
      }
      const scan = await buildScanContext({ platform: 'android', projectDir: project, credentials: {} })
      assert.equal(scan.appId, builderId, 'prescan Capgo checks use the Builder key')
      assert.equal(scan.nativeAppId, nativeId, 'prescan local iOS checks use the native ID')
      assert.equal(scan.config.appId, nativeId, 'prescan native checks keep the Capacitor ID')
      const explicitScan = await buildScanContext({ appId: 'com.example.explicit', platform: 'android', projectDir: project, credentials: {} })
      assert.equal(explicitScan.appId, 'com.example.explicit')
      assert.equal(explicitScan.nativeAppId, nativeId, 'an explicit Capgo ID does not replace the native ID')
      if (extension === 'ts') {
        const deps = buildDeps(() => ({}))
        assert.equal(await deps.getAppId(), builderId, 'MCP Capgo operations use the Builder key')
        assert.equal(await deps.getNativeAppId(), nativeId, 'MCP native operations keep the Capacitor ID')
        for (let attempt = 0; attempt < 20 && deps.iosEffectDeps.detectBundleIds().capacitor.value !== nativeId; attempt++)
          await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(deps.iosEffectDeps.detectBundleIds().capacitor.value, nativeId, 'iOS bundle detection stays native')
      }
      await writeConfigUpdater({
        path,
        config: { ...capgo.config, plugins: { ...capgo.config.plugins, CapacitorUpdater: { appId: 'com.example.new-ota' } } },
      })
      const updated = await loadConfig()
      assert.equal(updated.config.appId, nativeId)
      assert.equal(updated.config.plugins.CapgoBuilder.capgoBuilderAppId, builderId)
      assert.equal(getAppId(undefined, updated.config), 'com.example.new-ota')
      updated.config.plugins.CapacitorUpdater.appId = 'com.example.raw-ota'
      await writeConfigUpdater(updated, true)
      const rawUpdated = await loadConfig()
      assert.equal(rawUpdated.config.plugins.CapgoBuilder.capgoBuilderAppId, builderId, 'raw updater writes must retain the Builder field')
      assert.equal(getAppId(undefined, rawUpdated.config), 'com.example.raw-ota')
      assert.equal((await loadCapacitorConfig()).app.extConfig.plugins.CapgoBuilder.capgoBuilderAppId, builderId)
      if (extension === 'ts')
        assert.deepEqual(errorsFor(path), [], 'Capgo updater writes must keep the TypeScript config valid')
      if (extension === 'js')
        assert.match(readFileSync(path, 'utf8'), /capgoBuilderAppId/)
    }
    finally {
      process.chdir(previousCwd)
    }
  }

  const invalidProject = join(root, 'invalid-explicit')
  mkdirSync(join(invalidProject, 'www'), { recursive: true })
  writeFileSync(join(invalidProject, 'capacitor.config.json'), JSON.stringify(configFor('')))
  const overriddenScan = await buildScanContext({ appId: 'com.example.explicit', platform: 'ios', projectDir: invalidProject, credentials: {} })
  assert.equal(overriddenScan.appId, 'com.example.explicit', 'explicit IDs bypass invalid Builder config during prescan')
  assert.equal(overriddenScan.nativeAppId, nativeId, 'prescan still uses the native ID for local checks')
}
finally {
  if (existsSync(root))
    rmSync(root, { recursive: true, force: true })
}
