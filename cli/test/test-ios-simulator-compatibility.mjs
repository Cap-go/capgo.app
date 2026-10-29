import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { checkIosSimulatorCompatibility, formatIosSimulatorGuidance } from '../src/run/ios-compatibility.ts'

// Keep fixtures outside the checkout so missing dependencies cannot resolve from this repo in CI.
const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'capgo-ios-compatibility-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let fixtureId = 0

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function installNativeRun(packageDir, version, source = 'open(`${xCodePath}/Applications/Simulator.app`)') {
  write(join(packageDir, 'package.json'), JSON.stringify({ name: 'native-run', version }))
  if (source !== null)
    write(join(packageDir, 'dist/ios/utils/simulator.js'), source)
}

function fixture({ nativeRunVersion = '2.0.3', source, legacySimulator = false, deviceHub = true } = {}) {
  const dir = join(root, String(fixtureId++))
  const projectDir = join(dir, 'workspace', 'apps', 'mobile')
  const cliDir = join(dir, 'workspace', 'node_modules', '@capacitor', 'cli')
  const developerDir = join(dir, 'Xcode Beta.app', 'Contents', 'Developer')
  write(join(projectDir, 'package.json'), JSON.stringify({ dependencies: { '@capacitor/cli': '^8.0.0' } }))
  write(join(cliDir, 'package.json'), JSON.stringify({ name: '@capacitor/cli', version: '8.6.0' }))
  installNativeRun(join(cliDir, 'node_modules', 'native-run'), nativeRunVersion, source)
  if (deviceHub)
    mkdirSync(join(developerDir, '..', 'Applications', 'DeviceHub.app'), { recursive: true })
  if (legacySimulator)
    mkdirSync(join(developerDir, 'Applications', 'Simulator.app'), { recursive: true })
  return {
    projectDir,
    cliDir,
    developerDir,
    check: () => checkIosSimulatorCompatibility(projectDir, { hostPlatform: 'darwin', developerDir }),
  }
}

test('detects the incompatible installed transitive version in a hoisted monorepo', () => {
  const app = fixture()
  // A separate top-level install must not hide Capacitor's older nested dependency.
  installNativeRun(join(app.projectDir, 'node_modules', 'native-run'), '9.0.0', 'open("devices://device/open?id=...")')
  expect(app.check()).toEqual({ kind: 'unsupported', capacitorCliVersion: '8.6.0', nativeRunVersion: '2.0.3' })
})

test.each(['1.7.4', '2.0.0', '2.0.2', '2.0.3'])('flags native-run %s on Device Hub Xcode', (nativeRunVersion) => {
  expect(fixture({ nativeRunVersion }).check().kind).toBe('unsupported')
})

test('accepts the upstream Device Hub patch even when the package version stays 2.0.3', () => {
  expect(fixture({ source: 'open(`devices://device/open?id=${udid}`)' }).check().kind).toBe('supported')
})

test('does not invent a fixed version for an unverified newer release', () => {
  expect(fixture({ nativeRunVersion: '99.0.0', source: null }).check().kind).toBe('unknown')
})

test('still detects a known broken version when its implementation cannot be read', () => {
  expect(fixture({ source: null }).check().kind).toBe('unsupported')
})

test('does not flag older Xcode, non-macOS hosts, or missing Device Hub installations', () => {
  expect(fixture({ legacySimulator: true }).check().kind).toBe('unaffected')
  expect(fixture({ deviceHub: false }).check().kind).toBe('unaffected')
  const app = fixture()
  expect(checkIosSimulatorCompatibility(app.projectDir, { hostPlatform: 'linux', developerDir: app.developerDir }).kind).toBe('unaffected')
})

test('accepts DEVELOPER_DIR pointing to the Xcode app bundle', () => {
  const app = fixture()
  expect(checkIosSimulatorCompatibility(app.projectDir, {
    hostPlatform: 'darwin',
    developerDir: `${dirname(dirname(app.developerDir))}/`,
  }).kind).toBe('unsupported')
})

test('follows a symlinked Capacitor install to resolve its own native-run', () => {
  const app = fixture()
  const storeDir = join(dirname(app.projectDir), 'package-store', 'cli')
  mkdirSync(dirname(storeDir), { recursive: true })
  // Move the install into a package-manager store, then expose it through a symlink.
  renameSync(app.cliDir, storeDir)
  symlinkSync(storeDir, app.cliDir, 'dir')
  expect(app.check().nativeRunVersion).toBe('2.0.3')
  expect(app.check().kind).toBe('unsupported')
})

test('missing or invalid dependency metadata leaves compatibility unverified', () => {
  const app = fixture()
  rmSync(app.cliDir, { recursive: true, force: true })
  expect(app.check().kind).toBe('unknown')
  write(join(app.cliDir, 'package.json'), '{invalid json')
  expect(app.check().kind).toBe('unknown')
})

test('gives a manual baseline launch and explains why updating Capacitor alone is insufficient', () => {
  const result = fixture().check()
  const guidance = formatIosSimulatorGuidance(result)
  expect(guidance).toContain('npx cap open ios')
  expect(guidance).toContain('Product > Run')
  expect(guidance).toContain('no released minimum Capacitor version')
  expect(guidance).toContain('lockfile')
  expect(guidance).toContain('same major')
  expect(guidance).toContain('npx @capgo/cli@latest doctor')
})

test.skipIf(process.platform !== 'darwin')('MCP resolves the manual Xcode command from the selected app', async () => {
  const app = fixture()
  const previousDeveloperDir = process.env.DEVELOPER_DIR
  process.env.DEVELOPER_DIR = app.developerDir
  try {
    const { getRunDeviceCommandForPlatform } = await import('../src/init/mcp/live-update-tools.ts')
    const result = getRunDeviceCommandForPlatform('ios', app.projectDir, root)
    expect(result.command).toContain('cap open ios')
    expect(result.cwd).toBe(app.projectDir)
    expect(result.iosSimulatorCompatibility.kind).toBe('unsupported')
    expect(result.manualInstructions).toContain('Product > Run')
    expect(getRunDeviceCommandForPlatform('android', app.projectDir, root).command).toContain('cap run android')
  }
  finally {
    if (previousDeveloperDir === undefined)
      delete process.env.DEVELOPER_DIR
    else
      process.env.DEVELOPER_DIR = previousDeveloperDir
  }
})

test.skipIf(process.platform !== 'darwin')('the built CLI reports a manual launch instead of a known failing command', () => {
  const app = fixture()
  const result = spawnSync(process.execPath, [join(import.meta.dir, '..', 'dist', 'index.js'), 'run', 'device', 'ios', '--no-launch'], {
    cwd: app.projectDir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, DEVELOPER_DIR: app.developerDir, CAPGO_DISABLE_TELEMETRY: '1' },
  })
  const output = `${result.stdout}\n${result.stderr}`
  expect(result.status).toBe(0)
  expect(output).toContain('Manual iOS launch required')
  expect(output).toContain('cap open ios')
  expect(output).toContain('Product > Run')
  expect(output).not.toContain('Resolved run command:')
})

test.skipIf(process.platform !== 'darwin')('the built doctor fails with actionable compatibility guidance before dependency update checks', () => {
  const app = fixture()
  mkdirSync(join(app.projectDir, 'ios'), { recursive: true })
  write(join(app.projectDir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.compatibility', appName: 'Example', webDir: 'www' }))
  const result = spawnSync(process.execPath, [join(import.meta.dir, '..', 'dist', 'index.js'), 'doctor', '--package-json', join(app.projectDir, 'package.json')], {
    cwd: app.projectDir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, DEVELOPER_DIR: app.developerDir, CAPGO_DISABLE_TELEMETRY: '1' },
  })
  const output = `${result.stdout}\n${result.stderr}`
  expect(result.status).toBe(1)
  expect(output).toContain('native-run 2.0.3 cannot launch simulators')
  expect(output).toContain('no released minimum Capacitor version')
  expect(output).toContain('cap open ios')
  expect(output).not.toContain('All dependencies are up to date')
})
