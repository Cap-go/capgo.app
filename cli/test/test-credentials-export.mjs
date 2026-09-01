#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canDecodeCredentialBase64, decodeCredentialBase64 } from '../src/build/credentials-base64.ts'
const {
  isCredentialsExportInvocation,
  resolveCredentialsExport,
  resolveCredentialsFileValue,
  writeCredentialsExportFile,
} = await import('../src/build/credentials-export-command.ts')

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = join(cliDir, 'dist/index.js')
const tempRoots = []

function runCli(args, fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-credentials-export-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  tempRoots.push(root)
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  const localPath = join(cwd, '.capgo-credentials.json')
  if (fixture.localDirectory)
    mkdirSync(localPath)
  else if (fixture.local !== undefined)
    writeFileSync(localPath, JSON.stringify(fixture.local))
  else if (fixture.localContents !== undefined)
    writeFileSync(localPath, fixture.localContents)
  if (fixture.global !== undefined || fixture.globalContents !== undefined || fixture.globalDirectory) {
    const credentialsDir = join(home, '.capgo-credentials')
    const globalPath = join(credentialsDir, 'credentials.json')
    mkdirSync(credentialsDir, { recursive: true })
    if (fixture.globalDirectory)
      mkdirSync(globalPath)
    else if (fixture.global !== undefined)
      writeFileSync(globalPath, JSON.stringify(fixture.global))
    else if (fixture.globalContents !== undefined)
      writeFileSync(globalPath, fixture.globalContents)
  }
  if (fixture.existingDestination !== undefined) {
    const destination = join(cwd, fixture.existingDestination)
    if (fixture.existingDestination === 'link.txt') {
      const target = join(cwd, 'link-target.txt')
      writeFileSync(target, 'unchanged')
      symlinkSync(target, destination)
    }
    else {
      writeFileSync(destination, 'unchanged')
    }
  }

  const result = spawnSync(process.execPath, [cliEntry, ...(fixture.prefixArgs ?? []), 'build', 'credentials', 'export', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ...fixture.env,
      HOME: home,
      USERPROFILE: home,
      CI: '1',
      NO_COLOR: '1',
      CAPGO_DISABLE_TELEMETRY: '1',
    },
  })
  return { ...result, cwd, home }
}

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ PASSED: ${name}`)
    testsPassed++
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    console.error(`   Error: ${error.message}`)
    testsFailed++
  }
}

await test('known Base64 credential fields are decode-eligible, including short certificates', () => {
  assert.equal(canDecodeCredentialBase64('BUILD_CERTIFICATE_BASE64', 'short'), true)
  assert.equal(canDecodeCredentialBase64('APPLE_KEY_CONTENT', 'short'), true)
  assert.equal(canDecodeCredentialBase64('ANDROID_KEYSTORE_FILE', 'short'), true)
  assert.equal(canDecodeCredentialBase64('PLAY_CONFIG_JSON', 'short'), true)
})

await test('provisioning profile maps are never decode-eligible', () => {
  assert.equal(canDecodeCredentialBase64('CAPGO_IOS_PROVISIONING_MAP', 'A'.repeat(64)), false)
})

await test('future Base64 fields use the long-value heuristic without treating plain text as encoded', () => {
  assert.equal(canDecodeCredentialBase64('FUTURE_CREDENTIAL', 'A'.repeat(32)), true)
  assert.equal(canDecodeCredentialBase64('FUTURE_CREDENTIAL', 'A'.repeat(31)), false)
  assert.equal(canDecodeCredentialBase64('FUTURE_CREDENTIAL', 'this plain text is definitely not base64!'), false)
})

await test('strict decoding accepts padded, unpadded, whitespace-containing, and empty input', () => {
  assert.deepEqual(decodeCredentialBase64('YQ=='), Buffer.from('a'))
  assert.deepEqual(decodeCredentialBase64('c2VjcmV0'), Buffer.from('secret'))
  assert.deepEqual(decodeCredentialBase64('\tY\v Q\f=\r =\n'), Buffer.from('a'))
  assert.deepEqual(decodeCredentialBase64(''), Buffer.alloc(0))
})

await test('strict decoding rejects invalid characters, impossible length, malformed padding, and noncanonical pad bits', () => {
  for (const value of ['YQ$=', 'A', 'Y=Q=', 'YR==', 'YWJ=']) {
    assert.throws(
      () => decodeCredentialBase64(value),
      error => error instanceof Error && error.message === 'The stored value is not valid Base64',
    )
  }
})

const appId = 'com.example.app'
const localIos = { ios: { BUILD_CERTIFICATE_BASE64: 'local-cert', P12_PASSWORD: '' } }
const globalAndroid = { android: { ANDROID_KEYSTORE_FILE: 'global-store' } }

await test('automatically chooses a local-only configured source and platform', () => {
  assert.deepEqual(
    resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId }, { local: localIos, global: null }),
    { value: 'local-cert', source: 'local', platforms: ['ios'] },
  )
})

await test('automatically chooses a global-only configured source and platform', () => {
  assert.deepEqual(
    resolveCredentialsExport('ANDROID_KEYSTORE_FILE', { appId }, { local: null, global: globalAndroid }),
    { value: 'global-store', source: 'global', platforms: ['android'] },
  )
})

await test('requires a source flag whenever both stores configure the app', () => {
  assert.throws(
    () => resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId }, { local: localIos, global: localIos }),
    /--local.*--global/,
  )
})

await test('explicit local source succeeds without falling back', () => {
  assert.deepEqual(
    resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId, local: true }, { local: localIos, global: globalAndroid }),
    { value: 'local-cert', source: 'local', platforms: ['ios'] },
  )
})

await test('explicit global source succeeds without falling back', () => {
  assert.deepEqual(
    resolveCredentialsExport('ANDROID_KEYSTORE_FILE', { appId, global: true }, { local: localIos, global: globalAndroid }),
    { value: 'global-store', source: 'global', platforms: ['android'] },
  )
})

await test('an explicit source never falls back to the other store', () => {
  assert.throws(
    () => resolveCredentialsExport('ANDROID_KEYSTORE_FILE', { appId, local: true }, { local: localIos, global: globalAndroid }),
    /ANDROID_KEYSTORE_FILE.*local/i,
  )
  assert.throws(
    () => resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId, global: true }, { local: localIos, global: globalAndroid }),
    /BUILD_CERTIFICATE_BASE64.*global/i,
  )
})

await test('rejects selecting local and global together', () => {
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, local: true, global: true }, { local: localIos, global: null }),
    /cannot use --local and --global together/i,
  )
})

await test('automatically chooses the only configured platform', () => {
  assert.deepEqual(
    resolveCredentialsExport('P12_PASSWORD', { appId }, { local: localIos, global: null }),
    { value: '', source: 'local', platforms: ['ios'] },
  )
})

await test('exports equal values shared by two configured platforms', () => {
  const shared = { ios: { SHARED: 'same' }, android: { SHARED: 'same' } }
  assert.deepEqual(
    resolveCredentialsExport('SHARED', { appId }, { local: shared, global: null }),
    { value: 'same', source: 'local', platforms: ['ios', 'android'] },
  )
})

await test('requires --platform for different cross-platform values', () => {
  const split = { ios: { SHARED: 'ios' }, android: { SHARED: 'android' } }
  assert.throws(
    () => resolveCredentialsExport('SHARED', { appId }, { local: split, global: null }),
    /--platform/,
  )
})

await test('requires --platform when both platforms are configured but only one has the field', () => {
  const split = { ios: { P12_PASSWORD: '' }, android: { ANDROID_KEYSTORE_FILE: 'store' } }
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId }, { local: split, global: null }),
    /--platform/,
  )
})

await test('explicit platform succeeds and never falls back to another platform', () => {
  const credentials = { ios: { IOS_ONLY: 'ios-value' }, android: { ANDROID_ONLY: 'android-value' } }
  assert.deepEqual(
    resolveCredentialsExport('ANDROID_ONLY', { appId, platform: 'android' }, { local: credentials, global: null }),
    { value: 'android-value', source: 'local', platforms: ['android'] },
  )
  assert.throws(
    () => resolveCredentialsExport('IOS_ONLY', { appId, platform: 'android' }, { local: credentials, global: null }),
    /IOS_ONLY.*android/i,
  )
})

await test('validates invalid and unconfigured explicit platforms', () => {
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, platform: 'web' }, { local: localIos, global: null }),
    /ios or android/,
  )
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, platform: 'android' }, { local: localIos, global: null }),
    /android.*not configured/i,
  )
})

await test('rejects absent variables and absent app configuration', () => {
  assert.throws(
    () => resolveCredentialsExport('MISSING', { appId }, { local: localIos, global: null }),
    /MISSING.*ios/i,
  )
  assert.throws(
    () => resolveCredentialsExport('MISSING', { appId }, { local: null, global: null }),
    /No saved Builder credentials/,
  )
})

await test('empty string fields count as configuration and remain exportable', () => {
  const credentials = { ios: { EMPTY: '' } }
  assert.deepEqual(
    resolveCredentialsExport('EMPTY', { appId }, { local: credentials, global: null }),
    { value: '', source: 'local', platforms: ['ios'] },
  )
})

await test('error messages never contain fixture secret values', () => {
  const localSecret = 'local-fixture-secret'
  const globalSecret = 'global-fixture-secret'
  const stores = {
    local: { ios: { SECRET: localSecret } },
    global: { ios: { SECRET: globalSecret } },
  }
  assert.throws(
    () => resolveCredentialsExport('SECRET', { appId }, stores),
    error => !error.message.includes(localSecret) && !error.message.includes(globalSecret),
  )
})

await test('recognizes only the exact build credentials export invocation', () => {
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'build', 'credentials', 'export']), true)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', '--bad', 'build', 'credentials', 'export']), true)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', '--capacitor-config', 'capacitor.config.ts', 'build', 'credentials', 'export']), true)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', '--capacitor-config=capacitor.config.ts', 'build', 'credentials', 'export']), true)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'build', 'credentials', 'list']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'build', 'export']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'build', 'credentials']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'build', 'other', 'credentials', 'export']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', 'credentials', 'build', 'export']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', '--bad', 'star-all', 'build', 'credentials', 'export']), false)
  assert.equal(isCredentialsExportInvocation(['node', 'cli', '--capacitor-config', 'build', 'credentials', 'export']), false)
})

await test('ignores null, string, and array platform shapes in untrusted stores', () => {
  for (const malformed of [null, 'not-an-object', ['not-an-object']]) {
    assert.throws(
      () => resolveCredentialsExport('SECRET', { appId }, { local: { ios: malformed }, global: null }),
      /No saved Builder credentials/,
    )
  }
})

await test('ignores inherited platform sections and requested variables', () => {
  const inheritedPlatform = Object.create({ ios: { SECRET: 'inherited-platform-secret' } })
  assert.throws(
    () => resolveCredentialsExport('SECRET', { appId }, { local: inheritedPlatform, global: null }),
    /No saved Builder credentials/,
  )

  const inheritedVariablePlatform = Object.create({ INHERITED: 'inherited-secret' })
  inheritedVariablePlatform.OWN = 'configured'
  assert.throws(
    () => resolveCredentialsExport('INHERITED', { appId }, { local: { ios: inheritedVariablePlatform }, global: null }),
    /INHERITED.*ios/i,
  )
})

await test('ignores prototype-polluted variables and cleans up the prototype in finally', () => {
  const key = 'POLLUTED_CREDENTIAL'
  try {
    Object.prototype[key] = 'prototype-secret'
    assert.throws(
      () => resolveCredentialsExport(key, { appId }, { local: { ios: { OWN: 'configured' } }, global: null }),
      /POLLUTED_CREDENTIAL.*ios/i,
    )
  }
  finally {
    delete Object.prototype[key]
  }
  assert.equal(Object.prototype[key], undefined)
})

await test('exports an own __proto__ value from JSON data', () => {
  const credentials = JSON.parse('{"ios":{"__proto__":"own-secret"}}')
  assert.deepEqual(
    resolveCredentialsExport('__proto__', { appId }, { local: credentials, global: null }),
    { value: 'own-secret', source: 'local', platforms: ['ios'] },
  )
})

await test('escapes control characters in appId and variable diagnostics', () => {
  const unsafeAppId = 'app\n\u001b[31mforged'
  const unsafeVariable = 'MISSING\r\n\u001b[31mforged'
  assert.throws(
    () => resolveCredentialsExport('MISSING', { appId: unsafeAppId }, { local: null, global: null }),
    error => error.message.includes(JSON.stringify(unsafeAppId)) && !/[\r\n\u001b]/.test(error.message),
  )
  assert.throws(
    () => resolveCredentialsExport(unsafeVariable, { appId }, { local: { ios: { OWN: 'configured' } }, global: null }),
    error => error.message.includes(JSON.stringify(unsafeVariable)) && !/[\r\n\u001b]/.test(error.message),
  )
})

await test('file value resolution handles explicit decode and non-Base64 literals', async () => {
  const decoded = await resolveCredentialsFileValue('FUTURE_VALUE', 'c2VjcmV0', {
    decodeBase64: true,
    interactive: false,
    promptDecode: async () => false,
  })
  assert.deepEqual(decoded, { data: Buffer.from('secret'), decoded: true, warnLiteral: false })

  const literal = await resolveCredentialsFileValue('FUTURE_VALUE', 'not Base64!', {
    interactive: false,
    promptDecode: async () => false,
  })
  assert.deepEqual(literal, { data: 'not Base64!', decoded: false, warnLiteral: false })
})

await test('file value resolution warns for noninteractive Base64 and decodes only when accepted interactively', async () => {
  const noninteractive = await resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
    interactive: false,
    promptDecode: async () => false,
  })
  assert.deepEqual(noninteractive, { data: 'c2VjcmV0', decoded: false, warnLiteral: true })

  const accepted = await resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
    interactive: true,
    promptDecode: async () => true,
  })
  assert.deepEqual(accepted, { data: Buffer.from('secret'), decoded: true, warnLiteral: false })

  const declined = await resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
    interactive: true,
    promptDecode: async () => false,
  })
  assert.deepEqual(declined, { data: 'c2VjcmV0', decoded: false, warnLiteral: true })
})

await test('canceling an interactive decode prompt rejects', async () => {
  await assert.rejects(
    () => resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
      interactive: true,
      promptDecode: async () => Symbol('cancel'),
    }),
    /canceled/i,
  )
})

await test('staged writer never publishes write, chmod, or close failures and cleans its temp directory', async () => {
  for (const failure of ['writeFile', 'chmod', 'close']) {
    const calls = []
    const handle = {
      writeFile: async () => {
        calls.push('write')
        if (failure === 'writeFile')
          throw new Error('write-secret')
      },
      chmod: async () => {
        calls.push('chmod')
        if (failure === 'chmod')
          throw new Error('chmod-secret')
      },
      close: async () => {
        calls.push('close')
        if (failure === 'close')
          throw new Error('close-secret')
      },
    }
    await assert.rejects(
      () => writeCredentialsExportFile('/tmp/export.bin', 'data', {
        mkdtemp: async prefix => { calls.push(`mkdtemp:${prefix}`); return '/tmp/private-export' },
        open: async path => { calls.push(`open:${path}`); return handle },
        link: async () => { calls.push('link') },
        unlink: async path => { calls.push(`unlink:${path}`) },
        rmdir: async path => { calls.push(`rmdir:${path}`) },
        rm: async path => { calls.push(`rm:${path}`) },
      }),
      error => !error.message.includes('secret') && (failure === 'close'
        ? /Cannot safely clean up temporary credential export directory/.test(error.message)
        : /Cannot write credential export file/.test(error.message)),
    )
    assert.equal(calls.includes('link'), false)
    assert.equal(calls.includes('rm:/tmp/private-export'), false)
    assert.deepEqual(calls.slice(-2), ['unlink:/tmp/private-export/credential', 'rmdir:/tmp/private-export'])
    assert.equal(calls[1], 'open:/tmp/private-export/credential')
  }
})

await test('staged writer retains a failed close handle for cleanup retry and exact temp cleanup', async () => {
  const calls = []
  let closeAttempts = 0
  await assert.rejects(
    () => writeCredentialsExportFile('/tmp/export.bin', 'data', {
      mkdtemp: async () => '/tmp/private-export',
      open: async () => ({
        writeFile: async () => { calls.push('write') },
        chmod: async () => { calls.push('chmod') },
        close: async () => {
          calls.push('close')
          if (++closeAttempts === 1)
            throw new Error('close-secret')
        },
      }),
      link: async () => { calls.push('link') },
      unlink: async path => { calls.push(`unlink:${path}`) },
      rmdir: async path => { calls.push(`rmdir:${path}`) },
      rm: async () => { calls.push('rm') },
    }),
    error => !error.message.includes('close-secret') && /Cannot write credential export file/.test(error.message),
  )
  assert.deepEqual(calls, ['write', 'chmod', 'close', 'close', 'unlink:/tmp/private-export/credential', 'rmdir:/tmp/private-export'])
})

await test('staged writer publishes only after close and cleans exact generated paths', async () => {
  const calls = []
  await writeCredentialsExportFile('/tmp/export.bin', 'data', {
    mkdtemp: async () => { calls.push('mkdtemp'); return '/tmp/private-export' },
    open: async path => ({
      writeFile: async () => { calls.push(`write:${path}`) },
      chmod: async () => { calls.push('chmod') },
      close: async () => { calls.push('close') },
    }),
    link: async (source, destination) => { calls.push(`link:${source}:${destination}`) },
    unlink: async path => { calls.push(`unlink:${path}`) },
    rmdir: async path => { calls.push(`rmdir:${path}`) },
    rm: async () => { calls.push('rm') },
  })
  assert.deepEqual(calls, [
    'mkdtemp',
    'write:/tmp/private-export/credential',
    'chmod',
    'close',
    'link:/tmp/private-export/credential:/tmp/export.bin',
    'unlink:/tmp/private-export/credential',
    'rmdir:/tmp/private-export',
  ])
})

await test('staged writer prioritizes terminal-safe temp cleanup errors over destination conflicts', async () => {
  const calls = []
  const exists = Object.assign(new Error('already exists'), { code: 'EEXIST' })
  const tempDir = '/tmp/private\n\u001b[31m-export'
  await assert.rejects(
    () => writeCredentialsExportFile('/tmp/export.bin', 'data', {
      mkdtemp: async () => tempDir,
      open: async () => ({
        writeFile: async () => {},
        chmod: async () => {},
        close: async () => {},
      }),
      link: async () => { calls.push('link'); throw exists },
      unlink: async path => { calls.push(`unlink:${path}`); throw new Error('cleanup-secret') },
      rmdir: async () => { calls.push('rmdir') },
      rm: async () => { calls.push('rm') },
    }),
    error => !error.message.includes('cleanup-secret')
      && !error.message.includes('\n\u001b[31m')
      && error.message.includes('"/tmp/private\\n\\u001b[31m-export"')
      && /Destination was not replaced or created/.test(error.message),
  )
  assert.deepEqual(calls, [`link`, `unlink:${tempDir}/credential`])
})

await test('export help requires a positional variable', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /export \[options\] <variable>/)
  assert.doesNotMatch(result.stdout, /export \[options\] \[variable\]/)
})

await test('raw mode prints the exact saved value, uses --app-id, and ignores the environment', () => {
  const result = runCli(['BUILD_CERTIFICATE_BASE64', '--app-id', appId, '--raw'], {
    local: { [appId]: { ios: { BUILD_CERTIFICATE_BASE64: 'exact-value' } } },
    env: { BUILD_CERTIFICATE_BASE64: 'environment-value' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'exact-value')
  assert.equal(result.stderr, '')
})

await test('raw mode accepts --appId and preserves an empty saved value', () => {
  const result = runCli(['P12_PASSWORD', '--appId', appId, '--raw'], {
    local: { [appId]: { ios: { P12_PASSWORD: '' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

await test('public source selection requires a selector for two stores and never falls back explicitly', () => {
  const stores = {
    local: { [appId]: { ios: { LOCAL: 'local-value' } } },
    global: { [appId]: { android: { GLOBAL: 'global-value' } } },
  }
  const ambiguous = runCli(['LOCAL', '--app-id', appId, '--raw'], stores)
  assert.equal(ambiguous.status, 1)
  assert.equal(ambiguous.stdout, '')
  assert.match(ambiguous.stderr, /--local.*--global/i)

  const local = runCli(['LOCAL', '--app-id', appId, '--local', '--raw'], stores)
  assert.equal(local.status, 0)
  assert.equal(local.stdout, 'local-value')

  const global = runCli(['GLOBAL', '--app-id', appId, '--global', '--raw'], stores)
  assert.equal(global.status, 0)
  assert.equal(global.stdout, 'global-value')

  const noFallback = runCli(['GLOBAL', '--app-id', appId, '--local', '--raw'], stores)
  assert.equal(noFallback.status, 1)
  assert.equal(noFallback.stdout, '')
  assert.doesNotMatch(noFallback.stderr, /global-value/)
})

await test('public platform selection succeeds and ambiguity never leaks values', () => {
  const fixture = { local: { [appId]: { ios: { SHARED: 'ios-secret' }, android: { SHARED: 'android-secret' } } } }
  const explicit = runCli(['SHARED', '--app-id', appId, '--platform', 'android', '--raw'], fixture)
  assert.equal(explicit.status, 0)
  assert.equal(explicit.stdout, 'android-secret')

  const ambiguous = runCli(['SHARED', '--app-id', appId, '--raw'], fixture)
  assert.equal(ambiguous.status, 1)
  assert.equal(ambiguous.stdout, '')
  assert.match(ambiguous.stderr, /--platform/)
  assert.doesNotMatch(ambiguous.stderr, /ios-secret|android-secret/)
})

await test('invalid export inputs always fail on stderr without stdout', () => {
  const fixture = { local: { [appId]: { ios: { P12_PASSWORD: '' } } } }
  for (const args of [
    ['MISSING', '--app-id', appId, '--raw'],
    ['P12_PASSWORD', '--raw'],
    ['--app-id', appId, '--raw'],
    ['P12_PASSWORD', '--app-id', appId],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--file', 'x'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--decode-base64'],
    ['P12_PASSWORD', '--app-id', appId, '--file', '-'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--local', '--global'],
    ['P12_PASSWORD', '--app-id', appId, '--platform', 'web', '--raw'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--unknown-option'],
  ]) {
    const result = runCli(args, fixture)
    assert.equal(result.status, 1, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
    assert.notEqual(result.stderr, '', args.join(' '))
  }
})

await test('option validation runs before any credentials file reads', () => {
  for (const args of [
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--local', '--global'],
    ['P12_PASSWORD', '--app-id', appId, '--platform', 'web', '--raw'],
  ]) {
    const result = runCli(args, { localDirectory: true })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, args.includes('--platform') ? /--platform must be ios or android/ : /Cannot use --local and --global together/)
    assert.doesNotMatch(result.stderr, /Cannot read saved credentials file/)
  }
})

await test('empty file paths are present but rejected explicitly', () => {
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--file', ''], {
    local: { [appId]: { ios: { P12_PASSWORD: '' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--file <PATH> must not be empty/)
})

await test('large diagnostics flush completely before exit', () => {
  const marker = 'COMPLETE_DIAGNOSTIC_MARKER'
  const largeAppId = `${'x'.repeat(64 * 1024)}${marker}`
  const result = runCli(['P12_PASSWORD', '--app-id', largeAppId, '--raw'])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.endsWith(`${marker}\"\n`))
})

await test('large export parser diagnostics flush completely before exit', () => {
  const marker = 'COMPLETE_PARSER_DIAGNOSTIC_MARKER'
  const unknownOption = `--${'x'.repeat(64 * 1024)}${marker}`
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--raw'], { prefixArgs: [unknownOption] })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.endsWith(`${marker}'\n`))
})

await test('export parser diagnostics escape terminal controls', () => {
  const unsafeOption = '--bad\n\u001b]8;;forged\u0007\u0085\u2028\u2029\u202e\u2066'
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--raw'], { prefixArgs: [unsafeOption] })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes(unsafeOption), false)
  for (const escaped of ['\\u000a', '\\u001b', '\\u0085', '\\u2028', '\\u2029', '\\u202e', '\\u2066'])
    assert.match(result.stderr, new RegExp(escaped.replaceAll('\\', '\\\\')))
})

await test('success logs quote terminal-unsafe user paths and variable names', () => {
  const unsafe = 'line\n\u001b]8;;forged\u0007\u0085\u2028\u2029\u202e\u2066'
  const destination = `${unsafe}.txt`
  const result = runCli([unsafe, '--app-id', appId, '--file', destination], {
    local: { [appId]: { ios: { [unsafe]: 'literal-value' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.includes(unsafe), false)
  assert.match(result.stdout, /Exported "line\\n/)
  for (const escaped of ['\\n', '\\u001b', '\\u0085', '\\u2028', '\\u2029', '\\u202e', '\\u2066'])
    assert.match(result.stdout, new RegExp(escaped.replaceAll('\\', '\\\\')))
  assert.match(result.stdout, /to ".*line\\n.*\.txt"/)
})

await test('global parser errors before export tokens still use export stderr-only handling', () => {
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--raw'], {
    prefixArgs: ['--bad'],
    local: { [appId]: { ios: { P12_PASSWORD: 'saved-value' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /unknown option '--bad'/)
  assert.doesNotMatch(result.stderr, /saved-value/)
})

await test('parser errors for another command preserve normal stdout handling', () => {
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--raw'], {
    prefixArgs: ['--bad', 'star-all'],
    local: { [appId]: { ios: { P12_PASSWORD: 'saved-value' } } },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /unknown option '--bad'/)
  assert.equal(result.stderr, '')
  assert.doesNotMatch(result.stdout, /saved-value/)
})

await test('malformed local saved JSON fails without falling back or leaking global values', () => {
  const result = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--raw'], {
    localContents: '{invalid-json',
    global: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'global-secret' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /global-secret/)
})

await test('explicit source ignores malformed or unreadable opposite stores', () => {
  const local = runCli(['LOCAL', '--app-id', appId, '--local', '--raw'], {
    local: { [appId]: { ios: { LOCAL: 'local-value' } } },
    globalContents: '{invalid-json',
  })
  assert.equal(local.status, 0)
  assert.equal(local.stdout, 'local-value')
  assert.equal(local.stderr, '')

  const global = runCli(['GLOBAL', '--app-id', appId, '--global', '--raw'], {
    localDirectory: true,
    global: { [appId]: { android: { GLOBAL: 'global-value' } } },
  })
  assert.equal(global.status, 0)
  assert.equal(global.stdout, 'global-value')
  assert.equal(global.stderr, '')
})

await test('strict export rejects invalid saved-file structures and never falls back', () => {
  const invalidContents = [
    '[]',
    '"not-an-object"',
    JSON.stringify({ [appId]: null }),
    JSON.stringify({ [appId]: { ios: null } }),
    JSON.stringify({ [appId]: { ios: 'not-an-object' } }),
    JSON.stringify({ [appId]: { ios: [] } }),
    JSON.stringify({ [appId]: { ios: { FUTURE_FIELD: 42 } } }),
  ]
  for (const localContents of invalidContents) {
    const result = runCli(['GLOBAL_SECRET', '--app-id', appId, '--raw'], {
      localContents,
      global: { [appId]: { android: { GLOBAL_SECRET: 'global-secret' } } },
    })
    assert.equal(result.status, 1, localContents)
    assert.equal(result.stdout, '', localContents)
    assert.match(result.stderr, /Invalid saved credentials structure/, localContents)
    assert.doesNotMatch(result.stderr, /global-secret/, localContents)
  }

  const malformed = runCli(['GLOBAL_SECRET', '--app-id', appId, '--raw'], {
    localContents: '{invalid-json',
    global: { [appId]: { android: { GLOBAL_SECRET: 'global-secret' } } },
  })
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /Cannot parse saved credentials file/)
  assert.doesNotMatch(malformed.stderr, /Invalid saved credentials structure/)

  const directory = runCli(['GLOBAL_SECRET', '--app-id', appId, '--raw'], {
    localDirectory: true,
    global: { [appId]: { android: { GLOBAL_SECRET: 'global-secret' } } },
  })
  assert.equal(directory.status, 1)
  assert.equal(directory.stdout, '')
  assert.match(directory.stderr, /Cannot read saved credentials file/)
  assert.doesNotMatch(directory.stderr, /global-secret/)
})

await test('file mode preserves Base64 literally with safe permissions and a CI warning', () => {
  const result = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--file', 'keystore.txt'], {
    local: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'c2VjcmV0' } } },
  })
  const destination = join(result.cwd, 'keystore.txt')
  assert.equal(result.status, 0)
  assert.equal(readFileSync(destination, 'utf8'), 'c2VjcmV0')
  assert.equal(statSync(destination).mode & 0o777, 0o600)
  assert.match(result.stdout, /not decoded|--decode-base64/i)
  assert.match(result.stdout, /exported/i)
  assert.match(result.stdout, /stored text/i)
})

await test('decode-base64 writes decoded bytes and rejects invalid input before creation', () => {
  const decoded = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--file', 'keystore.bin', '--decode-base64'], {
    local: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'c2VjcmV0' } } },
  })
  assert.equal(decoded.status, 0)
  assert.equal(readFileSync(join(decoded.cwd, 'keystore.bin'), 'utf8'), 'secret')
  assert.match(decoded.stdout, /decoded bytes/i)

  const invalid = runCli(['FUTURE_VALUE', '--app-id', appId, '--file', 'bad.bin', '--decode-base64'], {
    local: { [appId]: { ios: { FUTURE_VALUE: 'not base64!' } } },
  })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.notEqual(invalid.stderr, '')
  assert.equal(existsSync(join(invalid.cwd, 'bad.bin')), false)
})

await test('file mode refuses existing regular files and symlinks without changing them', () => {
  for (const destination of ['existing.txt', 'link.txt']) {
    const result = runCli(['P12_PASSWORD', '--app-id', appId, '--file', destination], {
      local: { [appId]: { ios: { P12_PASSWORD: '' } } },
      existingDestination: destination,
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /already exists/i)
    if (destination === 'link.txt')
      assert.equal(readFileSync(join(result.cwd, 'link-target.txt'), 'utf8'), 'unchanged')
    else
      assert.equal(readFileSync(join(result.cwd, destination), 'utf8'), 'unchanged')
  }
})

await test('export help documents the raw stdout and failure contract', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--app-id/)
  assert.match(result.stdout, /exact stored value/i)
  assert.match(result.stdout, /no trailing newline/i)
  assert.match(result.stdout, /stderr/i)
  assert.match(result.stdout, /status 1/i)
})

for (const root of tempRoots)
  rmSync(root, { recursive: true, force: true })

if (testsFailed > 0) {
  console.error(`\n❌ ${testsFailed} test(s) failed`)
  process.exit(1)
}

console.log(`\n✅ credentials Base64 tests passed (${testsPassed})`)
