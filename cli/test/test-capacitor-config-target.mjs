import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { getConfigWriteTarget, loadConfigForWrite, resolveCapacitorConfigTargetPath, setConfigWriteTarget } from '../src/config/index.ts'
import { createKeyInternal } from '../src/key.ts'
import { getConfig } from '../src/utils.ts'
import { CapgoSDK } from '../src/sdk.ts'

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(cliRoot, '.capgo-config-target-'))
const outsideRoot = mkdtempSync(join(tmpdir(), 'capgo-config-outside-'))
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  promise.then(
    value => { clearTimeout(timer); resolve(value) },
    error => { clearTimeout(timer); reject(error) },
  )
})

let transport
let mcpStderr = ''
try {
  const configDir = join(root, 'env-configs')
  const directoryTarget = join(root, 'directory-target')
  const rootConfig = join(root, 'capacitor.config.json')
  const configTarget = join(configDir, 'capacitor.config.qr-code-reader.ts')
  const alternateConfigTarget = join(configDir, 'capacitor.config.stripe-phone-app.ts')
  const multiPartConfigTarget = join(configDir, 'capacitor.config.qr-code-reader.production.ts')
  const jsonConfigTarget = join(configDir, 'capacitor.config.json-target.json')
  const javascriptConfigTarget = join(configDir, 'capacitor.config.javascript.js')
  const factoryConfigTarget = join(configDir, 'capacitor.config.factory.ts')
  const outsideConfigTarget = join(outsideRoot, 'capacitor.config.escape.ts')
  const rootConfigSource = JSON.stringify({
    appId: 'com.example.root',
    appName: 'Root app',
    webDir: 'root-www',
    server: {
      url: 'https://root.example',
    },
    plugins: {
      RootOnlyPlugin: {
        enabled: true,
      },
      CapacitorUpdater: {
        appId: 'com.example.root',
      },
    },
  }, null, 2)
  const configTargetSource = `export default {
  appId: 'com.example.target',
  appName: 'Target app',
  webDir: 'target-www',
  server: {
    url: 'https://target.example',
  },
  plugins: {
    TargetOnlyPlugin: {
      enabled: true,
    },
    CapacitorUpdater: {
      appId: 'com.example.target',
      targetOnly: true,
    },
  },
}
`
  const factoryConfigSource = `export default async () => ({
  appId: 'com.example.factory',
  appName: 'Factory app',
  webDir: 'factory-www',
})
`
  const javascriptConfigSource = `/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.example.javascript',
  appName: 'JavaScript app',
  webDir: 'javascript-www',
  plugins: {
    JsOnlyPlugin: {
      enabled: true,
    },
    CapacitorUpdater: {
      appId: 'com.example.javascript',
      jsOnly: true,
    },
  },
}

module.exports = config
`
  const appDir = join(root, 'apps', 'qr-code-reader')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(directoryTarget)
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(rootConfig, rootConfigSource)
  writeFileSync(alternateConfigTarget, 'export default {}\n')
  writeFileSync(multiPartConfigTarget, 'export default {}\n')
  writeFileSync(configTarget, configTargetSource)
  writeFileSync(jsonConfigTarget, JSON.stringify({ appId: 'com.example.json', appName: 'JSON app', webDir: 'json-www' }))
  writeFileSync(javascriptConfigTarget, javascriptConfigSource)
  writeFileSync(factoryConfigTarget, factoryConfigSource)
  writeFileSync(join(configDir, 'not-a-capacitor-config.ts'), 'export default {}\n')
  writeFileSync(join(configDir, 'capacitor.config.esm.mjs'), 'export default {}\n')
  writeFileSync(outsideConfigTarget, 'export default {}\n')
  assert.equal(resolveCapacitorConfigTargetPath('./env-configs/capacitor.config.qr-code-reader.production.ts', root), multiPartConfigTarget)
  assert.equal(resolveCapacitorConfigTargetPath('./env-configs/capacitor.config.qr-code-reader.ts', root), configTarget)
  assert.equal(resolveCapacitorConfigTargetPath('./env-configs/capacitor.config.json-target.json', root), jsonConfigTarget)
  assert.equal(resolveCapacitorConfigTargetPath('./env-configs/capacitor.config.javascript.js', root), javascriptConfigTarget)
  assert.throws(() => resolveCapacitorConfigTargetPath('./env-configs/capacitor.config.esm.mjs', root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.match(error.message, /\.ts, capacitor\.config\.\*\.js, or capacitor\.config\.\*\.json/)
    assert.equal(error.context?.path, join(configDir, 'capacitor.config.esm.mjs'))
    return true
  })
  assert.throws(() => resolveCapacitorConfigTargetPath(relative(root, outsideConfigTarget), root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path must stay within the current working directory')
    return true
  })
  assert.throws(() => resolveCapacitorConfigTargetPath(outsideConfigTarget, root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path must stay within the current working directory')
    return true
  })
  const outsideLink = join(root, 'outside-link')
  symlinkSync(outsideRoot, outsideLink, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolveCapacitorConfigTargetPath(join('outside-link', 'capacitor.config.escape.ts'), root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path must stay within the current working directory')
    return true
  })
  assert.throws(() => resolveCapacitorConfigTargetPath('./missing.ts', root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path does not exist')
    assert.equal(error.context?.path, join(root, 'missing.ts'))
    return true
  })
  assert.throws(() => resolveCapacitorConfigTargetPath('./directory-target', root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path does not exist')
    return true
  })
  assert.throws(() => resolveCapacitorConfigTargetPath('', root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, 'Capacitor config path must not be empty')
    return true
  })
  const previousCwd = process.cwd()
  const previousConfigWriteTarget = getConfigWriteTarget()
  try {
    process.chdir(root)
    setConfigWriteTarget(factoryConfigTarget)
    const factoryConfigWriteSnapshot = await loadConfigForWrite()
    assert.equal(factoryConfigWriteSnapshot.config.appId, 'com.example.factory')
    assert.equal(factoryConfigWriteSnapshot.config.webDir, 'factory-www')
    setConfigWriteTarget(javascriptConfigTarget)
    const javascriptConfigWriteSnapshot = await loadConfigForWrite()
    assert.equal(javascriptConfigWriteSnapshot.config.appId, 'com.example.javascript')
    assert.equal(javascriptConfigWriteSnapshot.config.webDir, 'javascript-www')
    assert.equal(javascriptConfigWriteSnapshot.config.plugins.CapacitorUpdater.jsOnly, true)
    setConfigWriteTarget(jsonConfigTarget)
    const jsonConfigSnapshot = await getConfig()
    assert.equal(jsonConfigSnapshot.config.appId, 'com.example.root')
    assert.equal(jsonConfigSnapshot.path, jsonConfigTarget)
    const jsonConfigWriteSnapshot = await loadConfigForWrite()
    assert.equal(jsonConfigWriteSnapshot.config.appId, 'com.example.json')

    setConfigWriteTarget(configTarget)
    const configSnapshot = await getConfig()
    assert.equal(configSnapshot.config.appId, 'com.example.root')
    assert.equal(configSnapshot.path, configTarget)
    assert.ok(configSnapshot.config.plugins.RootOnlyPlugin)
    const configWriteSnapshot = await loadConfigForWrite()
    assert.equal(configWriteSnapshot.config.appId, 'com.example.target')
    const createKeyPromise = createKeyInternal({ force: true, keyDir: appDir, setupChannel: false }, true, configWriteSnapshot)
    assert.equal(process.cwd(), root)
    await createKeyPromise
    assert.equal(process.cwd(), root)
  }
  finally {
    process.chdir(previousCwd)
    setConfigWriteTarget(previousConfigWriteTarget)
  }
  const createdTargetConfig = readFileSync(configTarget, 'utf8')
  assert.match(createdTargetConfig, /publicKey/)
  assert.match(createdTargetConfig, /appId:\s*'com\.example\.target'/)
  assert.match(createdTargetConfig, /TargetOnlyPlugin/)
  assert.match(createdTargetConfig, /targetOnly:\s*true/)
  assert.doesNotMatch(createdTargetConfig, /RootOnlyPlugin/)
  assert.ok(existsSync(join(appDir, '.capgo_key_v2')))
  assert.ok(existsSync(join(appDir, '.capgo_key_v2.pub')))
  assert.match(readFileSync(configTarget, 'utf8'), /publicKey/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)
  assert.ok(!existsSync(join(root, '.capgo_key_v2')))
  assert.throws(() => resolveCapacitorConfigTargetPath('./env-configs/not-a-capacitor-config.ts', root), (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.match(error.message, /must point to a capacitor\.config/)
    return true
  })

  const sdkCwd = process.cwd()
  const sdkConfigWriteTarget = getConfigWriteTarget()
  try {
    process.chdir(root)
    const result = await new CapgoSDK().saveEncryptionKey({
      capacitorConfig: configTarget,
      keyData: '-----BEGIN RSA PUBLIC KEY-----\nsdk-public-key\n-----END RSA PUBLIC KEY-----',
    })
    assert.equal(result.success, true, result.error)
    assert.equal(getConfigWriteTarget(), sdkConfigWriteTarget)
  }
  finally {
    process.chdir(sdkCwd)
    setConfigWriteTarget(sdkConfigWriteTarget)
  }
  assert.match(readFileSync(configTarget, 'utf8'), /sdk-public-key/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)

  const command = spawnSync('node', [
    join(cliRoot, 'dist/index.js'),
    'app',
    'setting',
    'plugins.CapacitorUpdater.autoUpdate',
    '--bool',
    'false',
    '--capacitor-config',
    configTarget,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: 'true' },
  })

  assert.equal(command.status, 0, `${command.stdout}\n${command.stderr}`)
  const writtenTargetConfig = readFileSync(configTarget, 'utf8')
  assert.match(writtenTargetConfig, /appId:\s*'com\.example\.target'/)
  assert.match(writtenTargetConfig, /appName:\s*'Target app'/)
  assert.match(writtenTargetConfig, /webDir:\s*'target-www'/)
  assert.match(writtenTargetConfig, /https:\/\/target\.example/)
  assert.match(writtenTargetConfig, /TargetOnlyPlugin/)
  assert.match(writtenTargetConfig, /targetOnly:\s*true/)
  assert.match(writtenTargetConfig, /autoUpdate:\s*false/)
  assert.doesNotMatch(writtenTargetConfig, /RootOnlyPlugin/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)

  // Capacitor's own writeConfig silently no-ops on `.js`, so exercise a real write
  // through the CLI and confirm the `capacitor.config.js` target is actually updated.
  const javascriptCommand = spawnSync('node', [
    join(cliRoot, 'dist/index.js'),
    'app',
    'setting',
    'plugins.CapacitorUpdater.autoUpdate',
    '--bool',
    'false',
    '--capacitor-config',
    javascriptConfigTarget,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: 'true' },
  })

  assert.equal(javascriptCommand.status, 0, `${javascriptCommand.stdout}\n${javascriptCommand.stderr}`)
  const writtenJavascriptConfig = readFileSync(javascriptConfigTarget, 'utf8')
  assert.match(writtenJavascriptConfig, /module\.exports = config/)
  assert.match(writtenJavascriptConfig, /appId:\s*'com\.example\.javascript'/)
  assert.match(writtenJavascriptConfig, /webDir:\s*'javascript-www'/)
  assert.match(writtenJavascriptConfig, /JsOnlyPlugin/)
  assert.match(writtenJavascriptConfig, /jsOnly:\s*true/)
  assert.match(writtenJavascriptConfig, /autoUpdate:\s*false/)
  assert.doesNotMatch(writtenJavascriptConfig, /RootOnlyPlugin/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)

  const notificationHelper = join(root, 'src', 'capgo-notifications.ts')
  const notificationsCommand = spawnSync('node', [
    join(cliRoot, 'dist/index.js'),
    'notifications',
    'setup',
    'com.example.app',
    '--no-install',
    '--no-sync',
    '--file',
    './src/capgo-notifications.ts',
    '--capacitor-config',
    configTarget,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: 'true' },
  })

  assert.equal(notificationsCommand.status, 0, `${notificationsCommand.stdout}\n${notificationsCommand.stderr}`)
  assert.ok(existsSync(notificationHelper))
  assert.match(readFileSync(configTarget, 'utf8'), /CapgoNotifications/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)

  const mcpHelp = spawnSync('node', [join(cliRoot, 'dist/index.js'), 'mcp', '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: 'true' },
  })
  assert.equal(mcpHelp.status, 0, `${mcpHelp.stdout}\n${mcpHelp.stderr}`)
  assert.match(mcpHelp.stdout, /--capacitor-config <path>/)

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(cliRoot, 'dist/index.js'), 'mcp', '--capacitor-config', configTarget],
    cwd: root,
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: 'true' },
    stderr: 'pipe',
  })
  if (transport.stderr)
    transport.stderr.on('data', chunk => { mcpStderr += chunk.toString() })

  const client = new Client({ name: 'capgo-config-target-test', version: '0.0.0' })
  await withTimeout(client.connect(transport), 10000, 'MCP connect')
  const tools = await withTimeout(client.listTools(), 10000, 'MCP tool listing')
  const generateEncryptionKeys = tools.tools.find(tool => tool.name === 'capgo_generate_encryption_keys')
  assert.ok(generateEncryptionKeys?.inputSchema?.properties?.capacitorConfig)
  const uploadBundle = tools.tools.find(tool => tool.name === 'capgo_upload_bundle')
  assert.ok(uploadBundle?.inputSchema?.properties?.capacitorConfig)
  assert.ok(uploadBundle?.inputSchema?.properties?.autoSetBundle)

  const defaultResult = await withTimeout(client.callTool({ name: 'capgo_generate_encryption_keys', arguments: { force: true } }), 30000, 'MCP default encryption key generation')
  assert.equal(defaultResult.isError, undefined, JSON.stringify(defaultResult))
  assert.match(readFileSync(configTarget, 'utf8'), /publicKey/)

  const overrideResult = await withTimeout(client.callTool({ name: 'capgo_generate_encryption_keys', arguments: { force: true, capacitorConfig: alternateConfigTarget } }), 30000, 'MCP override encryption key generation')
  assert.equal(overrideResult.isError, undefined, JSON.stringify(overrideResult))
  assert.match(readFileSync(alternateConfigTarget, 'utf8'), /publicKey/)
  assert.equal(readFileSync(rootConfig, 'utf8'), rootConfigSource)
  console.log('✅ capacitor config target tests passed')
}
finally {
  try {
    await transport?.close()
  }
  catch {
    // The process may already be closed after an MCP failure.
  }
  if (mcpStderr)
    console.error(mcpStderr.trim())
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}
