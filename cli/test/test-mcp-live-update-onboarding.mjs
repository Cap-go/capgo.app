#!/usr/bin/env node
/** Headless tests for the MCP-conducted Capgo live-update onboarding engine. */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

console.log('🧪 Testing MCP live-update onboarding...\n')

const { renderResult, LIVE_UPDATE_RULES } = await import('../src/init/mcp/contract.ts')
const { clearAllSessions, getSession, mergeSession } = await import('../src/init/mcp/session-state.ts')
const { clearLiveUpdateProgress, loadLiveUpdateProgress, saveLiveUpdateProgress } = await import('../src/init/mcp/progress.ts')
let pass = 0
let fail = 0
async function test(name, fn) {
  clearAllSessions()
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }
const realConfigPath = filePath => realpathSync(filePath)

await test('LIVE_UPDATE_RULES mentions explain tool and login', async () => {
  const joined = LIVE_UPDATE_RULES.join('\n')
  ok(/capgo_live_update_onboarding_explain/.test(joined))
  ok(/npx @capgo\/cli@latest login/.test(joined))
  ok(/paste/i.test(joined) && /never/i.test(joined))
})

await test('renderResult leads with directive and embeds JSON', async () => {
  const result = {
    onboarding: 'capgo-live-update', phase: 'prepare', state: 'add-app', progress: 8,
    kind: 'auto', summary: 'Registering app…',
    next: { tool: 'capgo_live_update_onboarding_next_step', instruction: 'Wait.', call: 'capgo_live_update_onboarding_next_step({})' },
  }
  const text = renderResult(result)
  ok(text.includes('DO THIS NEXT'))
  ok(text.includes('"onboarding": "capgo-live-update"'))
})

const { decideStart, decideAdvance, gatherFacts, runStart } = await import('../src/init/mcp/engine.ts')

const facts = (o = {}) => ({
  capacitorProject: true,
  appId: 'com.acme.app',
  platformsDetected: ['ios', 'android'],
  authenticated: true,
  appRegistered: true,
  progress: null,
  ...o,
})

function fakeDeps(o = {}) {
  let progress = null
  return {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['ios', 'android'],
    isAppRegistered: async () => true,
    loadProgress: () => progress,
    saveProgress: (data) => { progress = data },
    clearProgress: () => { progress = null },
    registerApp: async () => ({ ok: true }),
    ensureChannel: async () => ({ ok: true }),
    installUpdater: async () => ({ ok: true, delta: false, currentVersion: '1.0.0' }),
    addIntegrationCode: async () => ({ ok: true }),
    setupEncryption: async (_a, enable) => ({ ok: true, enabled: enable }),
    buildProject: async () => ({ ok: true }),
    applyTestChange: async () => ({ ok: true, version: '1.0.1' }),
    uploadBundle: async () => ({ ok: true }),
    getRunDeviceCommand: () => ({ command: 'npx cap run ios' }),
    getGitStatus: () => ({ inRepo: true, clean: true, entries: [] }),
    ...o,
  }
}

await test('decideStart: no capacitor project → error', async () => {
  const r = await decideStart(facts({ capacitorProject: false, appId: undefined }), fakeDeps())
  eq(r.kind, 'error')
  eq(r.state, 'no-capacitor-project')
})

await test('decideStart: not authenticated → login human_gate', async () => {
  const r = await decideStart(facts({ authenticated: false }), fakeDeps())
  eq(r.kind, 'human_gate')
  eq(r.state, 'login-required')
})

await test('decideStart: saved progress → resume-prompt', async () => {
  const r = await decideStart(facts({ progress: { step_done: 3, appId: 'com.acme.app' } }), fakeDeps())
  eq(r.kind, 'choice')
  eq(r.state, 'resume-prompt')
})

await test('decideAdvance: encryption choice at step 5', async () => {
  const deps = fakeDeps()
  deps.saveProgress({ step_done: 4, appId: 'com.acme.app' })
  const r = await decideAdvance(facts({ progress: { step_done: 4, appId: 'com.acme.app' } }), deps, { encryptionChoice: 'skip' })
  ok(r.state === 'setup-encryption' || r.state === 'select-platform' || r.kind === 'auto')
})

await test('decideAdvance: platform choice at step 6', async () => {
  const deps = fakeDeps()
  deps.saveProgress({ step_done: 5, appId: 'com.acme.app', encryptionEnabled: false })
  const r = await decideAdvance(facts({ progress: deps.loadProgress() }), deps, { platform: 'ios' })
  ok(r.platform === 'ios' || r.state === 'select-platform' || r.kind === 'auto')
})

await test('gatherFacts maps deps', async () => {
  const f = await gatherFacts(fakeDeps())
  eq(f.appId, 'com.acme.app')
  eq(f.authenticated, true)
})

await test('gatherFacts ignores progress from another app', async () => {
  const deps = fakeDeps({
    loadProgress: () => ({ step_done: 10, appId: 'com.other.app' }),
  })
  const f = await gatherFacts(deps)
  eq(f.progress, null)
})

await test('runStart does not re-prompt a new onboarding', async () => {
  const r = await runStart(fakeDeps())
  ok(r.state !== 'resume-prompt')
  ok(r.onboarding === 'capgo-live-update')
})

await test('runStart re-prompts after a previous resume decision', async () => {
  const deps = fakeDeps()
  deps.saveProgress({ step_done: 4, appId: 'com.acme.app' })
  mergeSession('com.acme.app', { resumeResolved: true })

  const r = await runStart(deps)
  eq(r.state, 'resume-prompt')
})

const { buildDeps, registerLiveUpdateTools, resolveLiveUpdateProjectTarget } = await import('../src/init/mcp/live-update-tools.ts')
const { liveUpdateNextStepSchema, liveUpdateStartSchema, liveUpdateExplainInputSchema } = await import('../src/schemas/live-update-onboarding.ts')
const { safeParseSchema } = await import('../src/schemas/schema_validation.ts')

function fakeServer() {
  const tools = {}
  return {
    tools,
    registerTool(name, config, handler) { tools[name] = { inputSchema: config.inputSchema, handler } },
    registerPrompt() {},
  }
}

await test('registerLiveUpdateTools registers spine + explain', async () => {
  const server = fakeServer()
  registerLiveUpdateTools(server, null, fakeDeps())
  ok(server.tools.start_capgo_live_update_onboarding)
  ok(server.tools.start_capgo_live_update_onboarding.inputSchema)
  ok(server.tools.capgo_live_update_onboarding_next_step)
  ok(server.tools.capgo_live_update_onboarding_explain)
  ok(server.tools.capgo_live_update_onboarding_next_step.inputSchema)
  ok(server.tools.capgo_live_update_onboarding_explain.inputSchema)
  eq(safeParseSchema(liveUpdateExplainInputSchema, { capacitorConfig: '' }).success, false)
  eq(safeParseSchema(liveUpdateExplainInputSchema, { capacitorConfig: './env-configs/capacitor.config.qr-code-reader.ts' }).success, true)
})

await test('registerLiveUpdateTools: start returns rendered text', async () => {
  const server = fakeServer()
  registerLiveUpdateTools(server, null, fakeDeps())
  const res = await server.tools.start_capgo_live_update_onboarding.handler({})
  ok(res.content[0].text.includes('Capgo live-update onboarding'))
})

const { getConfigWriteTarget, setConfigWriteTarget, withConfigWriteTarget } = await import('../src/config/index.ts')
await test('live-update onboarding validates Capacitor config target input', async () => {
  eq(safeParseSchema(liveUpdateStartSchema, { capacitorConfig: '' }).success, false)
  eq(safeParseSchema(liveUpdateNextStepSchema, { capacitorConfig: '' }).success, false)
  eq(safeParseSchema(liveUpdateNextStepSchema, { capacitorConfig: './env-configs/capacitor.config.qr-code-reader.ts' }).success, true)
  eq(safeParseSchema(liveUpdateStartSchema, {}).success, true)
})

await test('MCP monorepo targets keep project work scoped to the selected app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-monorepo-'))
  const configDir = join(root, 'env-configs')
  const configTarget = join(configDir, 'capacitor.config.reader.ts')
  const appDir = join(root, 'projects', 'reader')
  const packageJsonPath = join(appDir, 'package.json')
  const mainFilePath = join(appDir, 'src', 'main.ts')
  const rootMainFilePath = join(root, 'main.ts')
  const invalidMainFilePath = join(appDir, 'src', 'main.txt')
  const previousCwd = process.cwd()
  const previousTarget = getConfigWriteTarget()
  try {
    mkdirSync(join(appDir, 'src'), { recursive: true })
    mkdirSync(join(appDir, 'ios'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workspace-root', version: '1.0.0' }))
    writeFileSync(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.acme.reader', appName: 'Reader', webDir: 'www' }))
    writeFileSync(configTarget, 'export default {}\n')
    writeFileSync(packageJsonPath, JSON.stringify({ name: 'reader', version: '2.0.0' }))
    writeFileSync(mainFilePath, 'export {}\n')
    writeFileSync(rootMainFilePath, 'export const rootOnly = true\n')
    writeFileSync(invalidMainFilePath, 'export {}\n')

    const projectTarget = resolveLiveUpdateProjectTarget({
      packageJson: './projects/reader/package.json',
      mainFile: './projects/reader/src/main.ts',
    }, root)
    eq(projectTarget.packageJsonPath, packageJsonPath)
    eq(projectTarget.mainFilePath, mainFilePath)
    let invalidPackageError
    try {
      resolveLiveUpdateProjectTarget({ packageJson: './projects/reader/src/main.ts' }, root)
    }
    catch (error) {
      invalidPackageError = error
    }
    ok(String(invalidPackageError).includes('must point to package.json'))
    let invalidMainError
    try {
      resolveLiveUpdateProjectTarget({ mainFile: './projects/reader/src/main.txt' }, root)
    }
    catch (error) {
      invalidMainError = error
    }
    ok(String(invalidMainError).includes('JavaScript or TypeScript'))
    eq(safeParseSchema(liveUpdateStartSchema, { packageJson: './projects/reader/package.json', mainFile: './projects/reader/src/main.ts' }).success, true)
    eq(safeParseSchema(liveUpdateNextStepSchema, { packageJson: './projects/reader/package.json', mainFile: './projects/reader/src/main.ts' }).success, true)

    process.chdir(root)
    setConfigWriteTarget(undefined)
    const deps = buildDeps({}, root, () => projectTarget)
    eq(JSON.stringify(await deps.detectPlatforms()), JSON.stringify(['ios']))
    const runCommand = deps.getRunDeviceCommand('ios')
    eq(runCommand.cwd, appDir)
    ok(!runCommand.command.includes(appDir))
    const unsafeProjectDir = join(root, 'projects', 'reader-$(touch injected)')
    const unsafeRunCommand = buildDeps({}, root, () => ({ packageJsonPath: join(unsafeProjectDir, 'package.json') })).getRunDeviceCommand('ios')
    eq(unsafeRunCommand.cwd, unsafeProjectDir)
    ok(!unsafeRunCommand.command.includes('$('))
    const integration = await deps.addIntegrationCode('com.acme.reader')
    eq(integration.ok, true)
    ok(readFileSync(mainFilePath, 'utf8').includes('CapacitorUpdater.notifyAppReady()'))
    ok(!readFileSync(rootMainFilePath, 'utf8').includes('CapacitorUpdater.notifyAppReady()'))

    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({ cwd: root }))
    const started = await server.tools.start_capgo_live_update_onboarding.handler({
      capacitorConfig: './env-configs/capacitor.config.reader.ts',
      packageJson: './projects/reader/package.json',
      mainFile: './projects/reader/src/main.ts',
    })
    ok(started.content[0].text.includes(realConfigPath(configTarget)))
    ok(started.content[0].text.includes(packageJsonPath))
    ok(started.content[0].text.includes(mainFilePath))
    let conflictingTargetError
    try {
      await server.tools.start_capgo_live_update_onboarding.handler({
        capacitorConfig: './env-configs/capacitor.config.reader.ts',
        mainFile: './main.ts',
      })
    }
    catch (error) {
      conflictingTargetError = error
    }
    ok(String(conflictingTargetError).includes('already has packageJson or mainFile targets'))
  }
  finally {
    process.chdir(previousCwd)
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})
const { startMcpServer } = await import('../src/mcp/server.ts')

await test('MCP startup restores the prior config target after failure', async () => {
  const originalTarget = getConfigWriteTarget()
  const originalStdinOn = process.stdin.on
  const originalStdoutWrite = process.stdout.write
  const priorTarget = '/tmp/capgo-prior-config.ts'
  try {
    setConfigWriteTarget(priorTarget)
    process.stdin.on = () => { throw new Error('forced MCP startup failure') }

    let failure
    try {
      await startMcpServer('/tmp/capgo-new-config.ts')
    }
    catch (error) {
      failure = error
    }

    ok(String(failure).includes('forced MCP startup failure'))
    eq(getConfigWriteTarget(), priorTarget)
  }
  finally {
    process.stdin.on = originalStdinOn
    process.stdout.write = originalStdoutWrite
    setConfigWriteTarget(originalTarget)
  }
})

await test('registerLiveUpdateTools keeps a request-local start config target for later steps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-config-'))
  const target = join(root, 'capacitor.config.qr-code-reader.ts')
  const previousTarget = getConfigWriteTarget()
  const serverTarget = '/tmp/capgo-server-config.ts'
  const observedTargets = []
  try {
    writeFileSync(target, 'export default {}\n')
    setConfigWriteTarget(serverTarget)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      setupEncryption: async (_appId, enable) => {
        observedTargets.push(getConfigWriteTarget())
        return { ok: true, enabled: enable }
      },
    }))
    const started = await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.qr-code-reader.ts' })
    ok(started.content[0].text.includes(realConfigPath(target)))
    eq(getConfigWriteTarget(), serverTarget)
    await server.tools.capgo_live_update_onboarding_next_step.handler({ resumeChoice: 'continue', encryptionChoice: 'enable' })
    eq(observedTargets[0], realConfigPath(target))
    eq(getConfigWriteTarget(), serverTarget)

    let missingError
    try {
      await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './missing.ts' })
    }
    catch (error) {
      missingError = error
    }
    ok(String(missingError).includes('Capacitor config path does not exist'))
  }
  finally {
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('routing config does not bypass the saved-progress resume choice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-resume-config-'))
  const target = join(root, 'capacitor.config.qr-code-reader.ts')
  const progress = { step_done: 4, appId: 'com.acme.app' }
  try {
    writeFileSync(target, 'export default {}\n')
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      loadProgress: () => progress,
      saveProgress: () => {},
      clearProgress: () => {},
    }))

    const started = await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.qr-code-reader.ts' })
    ok(started.content[0].text.includes('"state": "resume-prompt"'))

    const continued = await server.tools.capgo_live_update_onboarding_next_step.handler({ capacitorConfig: './capacitor.config.qr-code-reader.ts' })
    ok(continued.content[0].text.includes('"state": "resume-prompt"'))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
await test('scopes onboarding session and progress by Capacitor config source', async () => {
  const firstTarget = '/tmp/capgo-live-update-first.ts'
  const secondTarget = '/tmp/capgo-live-update-second.ts'
  try {
    withConfigWriteTarget(firstTarget, () => {
      mergeSession('com.acme.shared', { encryptionChoice: 'enable' })
      saveLiveUpdateProgress({ step_done: 4, appId: 'com.acme.shared' })
    })
    withConfigWriteTarget(secondTarget, () => {
      mergeSession('com.acme.shared', { encryptionChoice: 'skip' })
      saveLiveUpdateProgress({ step_done: 7, appId: 'com.acme.shared' })
    })

    withConfigWriteTarget(firstTarget, () => {
      eq(getSession('com.acme.shared').encryptionChoice, 'enable')
      eq(loadLiveUpdateProgress()?.step_done, 4)
    })
    withConfigWriteTarget(secondTarget, () => {
      eq(getSession('com.acme.shared').encryptionChoice, 'skip')
      eq(loadLiveUpdateProgress()?.step_done, 7)
    })
  }
  finally {
    withConfigWriteTarget(firstTarget, clearLiveUpdateProgress)
    withConfigWriteTarget(secondTarget, clearLiveUpdateProgress)
  }
})

await test('root onboarding migrates legacy progress to its resolved config source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-legacy-progress-'))
  const rootConfig = join(root, 'capacitor.config.json')
  const previousCwd = process.cwd()
  const previousTarget = getConfigWriteTarget()
  const progressByTarget = new Map([[undefined, { step_done: 4, appId: 'com.acme.shared' }]])
  try {
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(rootConfig, JSON.stringify({ appId: 'com.acme.shared', appName: 'Shared', webDir: 'www' }))
    process.chdir(root)
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
    }))

    const started = await server.tools.start_capgo_live_update_onboarding.handler({})
    ok(started.content[0].text.includes('"state": "resume-prompt"'))
    const resolvedTarget = [...progressByTarget.keys()].find(target => target !== undefined)
    eq(progressByTarget.get(resolvedTarget)?.step_done, 4)
    eq(progressByTarget.has(undefined), false)
  }
  finally {
    process.chdir(previousCwd)
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('explicit config target migrates legacy progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-explicit-legacy-progress-'))
  const target = join(root, 'capacitor.config.qr-code-reader.ts')
  const previousTarget = getConfigWriteTarget()
  const progressByTarget = new Map([[undefined, { step_done: 4, appId: 'com.acme.shared' }]])
  try {
    writeFileSync(target, 'export default {}\n')
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
    }))

    const started = await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.qr-code-reader.ts' })
    ok(started.content[0].text.includes('"state": "resume-prompt"'))
    eq(progressByTarget.get(realConfigPath(target))?.step_done, 4)
    eq(progressByTarget.has(undefined), false)
  }
  finally {
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('registerLiveUpdateTools returns a concrete root config source for ambiguous continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-root-config-'))
  const rootConfig = join(root, 'capacitor.config.json')
  const customConfig = join(root, 'capacitor.config.qr-code-reader.ts')
  const previousCwd = process.cwd()
  const previousTarget = getConfigWriteTarget()
  const observedTargets = []
  const progressByTarget = new Map()
  try {
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(rootConfig, JSON.stringify({ appId: 'com.acme.shared', appName: 'Shared', webDir: 'www' }))
    writeFileSync(customConfig, 'export default {}\n')
    process.chdir(root)
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
      setupEncryption: async (_appId, enable) => {
        observedTargets.push(getConfigWriteTarget())
        return { ok: true, enabled: enable }
      },
    }))

    const rootStarted = await server.tools.start_capgo_live_update_onboarding.handler({})
    ok(rootStarted.content[0].text.includes(rootConfig))
    await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.qr-code-reader.ts' })

    let ambiguousError
    try {
      await server.tools.capgo_live_update_onboarding_next_step.handler({ encryptionChoice: 'enable' })
    }
    catch (error) {
      ambiguousError = error
    }
    ok(String(ambiguousError).includes('Multiple Capacitor config sources'))

    await server.tools.capgo_live_update_onboarding_next_step.handler({ capacitorConfig: rootConfig, resumeChoice: 'continue', encryptionChoice: 'enable' })
    eq(observedTargets[0], realConfigPath(rootConfig))
  }
  finally {
    process.chdir(previousCwd)
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('registerLiveUpdateTools drops completed config sources from pathless routing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-complete-config-'))
  const firstTarget = join(root, 'capacitor.config.first.ts')
  const secondTarget = join(root, 'capacitor.config.second.ts')
  const previousTarget = getConfigWriteTarget()
  const progressByTarget = new Map()
  const observedTargets = []
  try {
    writeFileSync(firstTarget, 'export default {}\n')
    writeFileSync(secondTarget, 'export default {}\n')
    progressByTarget.set(realConfigPath(firstTarget), { step_done: 4, appId: 'com.acme.shared' })
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
      setupEncryption: async (_appId, enable) => {
        observedTargets.push(getConfigWriteTarget())
        return { ok: true, enabled: enable }
      },
    }))

    const firstStarted = await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.first.ts' })
    ok(firstStarted.content[0].text.includes('"state": "resume-prompt"'))

    progressByTarget.set(realConfigPath(firstTarget), { step_done: 12, appId: 'com.acme.shared' })
    withConfigWriteTarget(realConfigPath(firstTarget), () => mergeSession('com.acme.shared', { resumeResolved: true }))
    const completed = await server.tools.capgo_live_update_onboarding_next_step.handler({ capacitorConfig: './capacitor.config.first.ts' })
    ok(completed.content[0].text.includes('"state": "completion"'))
    await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.second.ts' })
    await server.tools.capgo_live_update_onboarding_next_step.handler({ resumeChoice: 'continue', encryptionChoice: 'enable' })
    eq(observedTargets[0], realConfigPath(secondTarget))
  }
  finally {
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('registerLiveUpdateTools retains a failed source for a pathless retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-retry-config-'))
  const target = join(root, 'capacitor.config.retry.ts')
  const previousTarget = getConfigWriteTarget()
  const progressByTarget = new Map()
  const installTargets = []
  let installAttempts = 0
  try {
    writeFileSync(target, 'export default {}\n')
    withConfigWriteTarget(realConfigPath(target), () => mergeSession('com.acme.shared', { resumeResolved: true }))
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
      installUpdater: async () => {
        installTargets.push(getConfigWriteTarget())
        installAttempts++
        return installAttempts === 1
          ? { ok: false, error: 'temporary install failure' }
          : { ok: true, delta: false, currentVersion: '1.0.0' }
      },
    }))

    const failed = await server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.retry.ts' })
    ok(failed.content[0].text.includes('temporary install failure'))

    await server.tools.capgo_live_update_onboarding_next_step.handler({})
    eq(installTargets[0], realConfigPath(target))
    eq(installTargets[1], realConfigPath(target))
  }
  finally {
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

await test('registerLiveUpdateTools isolates concurrent same-app config writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-live-update-concurrent-config-'))
  const firstTarget = join(root, 'capacitor.config.first.ts')
  const secondTarget = join(root, 'capacitor.config.second.ts')
  const previousTarget = getConfigWriteTarget()
  const progressByTarget = new Map()
  const observedTargets = []
  const installTargets = []
  let writersReady = 0
  let releaseWriters = () => {}
  const writersStarted = new Promise((resolve) => {
    releaseWriters = resolve
  })
  try {
    writeFileSync(firstTarget, 'export default {}\n')
    writeFileSync(secondTarget, 'export default {}\n')
    withConfigWriteTarget(realConfigPath(firstTarget), () => mergeSession('com.acme.shared', { resumeResolved: true }))
    withConfigWriteTarget(realConfigPath(secondTarget), () => mergeSession('com.acme.shared', { resumeResolved: true }))
    setConfigWriteTarget(undefined)
    const server = fakeServer()
    registerLiveUpdateTools(server, null, fakeDeps({
      cwd: root,
      getAppId: async () => 'com.acme.shared',
      loadProgress: () => progressByTarget.get(getConfigWriteTarget()) ?? null,
      saveProgress: data => progressByTarget.set(getConfigWriteTarget(), data),
      clearProgress: () => progressByTarget.delete(getConfigWriteTarget()),
      installUpdater: async () => {
        writersReady++
        if (writersReady === 2)
          releaseWriters()
        await writersStarted
        const target = getConfigWriteTarget()
        installTargets.push(target)
        writeFileSync(target, target === realConfigPath(firstTarget) ? 'first\n' : 'second\n')
        return { ok: true, delta: false, currentVersion: '1.0.0' }
      },
      setupEncryption: async (_appId, enable) => {
        observedTargets.push(getConfigWriteTarget())
        return { ok: true, enabled: enable }
      },
    }))

    const startResults = await Promise.all([
      server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.first.ts' }),
      server.tools.start_capgo_live_update_onboarding.handler({ capacitorConfig: './capacitor.config.second.ts' }),
    ])
    const startStates = startResults.map(result => result.content[0].text.match(/"state": "([^"]+)"/)?.[1])
    ok(installTargets.includes(realConfigPath(firstTarget)), `missing first config target: ${JSON.stringify(installTargets)}; states: ${JSON.stringify(startStates)}`)
    ok(installTargets.includes(realConfigPath(secondTarget)), `missing second config target: ${JSON.stringify(installTargets)}; states: ${JSON.stringify(startStates)}`)

    eq(readFileSync(firstTarget, 'utf8'), 'first\n')
    eq(readFileSync(secondTarget, 'utf8'), 'second\n')

    let ambiguousError
    try {
      await server.tools.capgo_live_update_onboarding_next_step.handler({ encryptionChoice: 'enable' })
    }
    catch (error) {
      ambiguousError = error
    }
    ok(String(ambiguousError).includes('Multiple Capacitor config sources'))

    await server.tools.capgo_live_update_onboarding_next_step.handler({ capacitorConfig: './capacitor.config.first.ts', resumeChoice: 'continue', encryptionChoice: 'enable' })
    await server.tools.capgo_live_update_onboarding_next_step.handler({ capacitorConfig: './capacitor.config.second.ts', resumeChoice: 'continue', encryptionChoice: 'enable' })
    eq(observedTargets[0], realConfigPath(firstTarget))
    eq(observedTargets[1], realConfigPath(secondTarget))
    eq(getConfigWriteTarget(), undefined)
  }
  finally {
    setConfigWriteTarget(previousTarget)
    rmSync(root, { recursive: true, force: true })
  }
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)
