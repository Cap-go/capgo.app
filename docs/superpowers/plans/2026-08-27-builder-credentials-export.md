# Builder Credential Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `build credentials export <VARIABLE>` so one saved Builder value can be exported safely to exact raw stdout or a new file.

**Architecture:** Keep command wiring in `cli/src/index.ts` and put all behavior in a focused `credentials-export-command.ts` module. Resolve local/global and iOS/Android ambiguity with pure functions, reuse one shared Base64 eligibility helper with the existing credential manager, and exercise the public CLI through an isolated child-process test.

**Tech Stack:** TypeScript, Commander, `@clack/prompts`, Node filesystem/process APIs, Bun test scripts, generated Markdown CLI docs.

---

## File structure

- Create `cli/src/build/credentials-base64.ts`: shared Base64 eligibility and strict decode helpers.
- Create `cli/src/build/credentials-export-command.ts`: source/platform resolution, file-mode decode choice, secure exclusive writes, and the command handler.
- Modify `cli/src/build/credentials-manage.ts`: import the shared eligibility helper and remove its private duplicate.
- Modify `cli/src/index.ts`: register `build credentials export` and its options; no implementation logic lives here.
- Create `cli/test/test-credentials-export.mjs`: pure resolver/helper tests plus public CLI subprocess tests.
- Modify `cli/package.json`: add the focused test script and include it in the full CLI test chain.
- Regenerate `cli/README.md` and `cli/webdocs/build.mdx` from the Commander definition.
- Modify `cli/skills/native-builds/SKILL.md`: document the new command for the published TanStack Intent skill.

### Task 1: Share and verify Base64 behavior

**Files:**
- Create: `cli/src/build/credentials-base64.ts`
- Modify: `cli/src/build/credentials-manage.ts:813-824`
- Create: `cli/test/test-credentials-export.mjs`

- [ ] **Step 1: Write failing tests for the existing eligibility rules and strict decoding**

Create `cli/test/test-credentials-export.mjs` with the test harness and these initial assertions:

```js
#!/usr/bin/env bun

import assert from 'node:assert/strict'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(error)
  }
}

const {
  canDecodeCredentialBase64,
  decodeCredentialBase64,
} = await import('../src/build/credentials-base64.ts')

await test('keeps the credentials-manage Base64 eligibility rules', () => {
  assert.equal(canDecodeCredentialBase64('BUILD_CERTIFICATE_BASE64', 'short'), true)
  assert.equal(canDecodeCredentialBase64('APPLE_KEY_CONTENT', 'short'), true)
  assert.equal(canDecodeCredentialBase64('ANDROID_KEYSTORE_FILE', 'short'), true)
  assert.equal(canDecodeCredentialBase64('PLAY_CONFIG_JSON', 'short'), true)
  assert.equal(canDecodeCredentialBase64('CAPGO_IOS_PROVISIONING_MAP', 'A'.repeat(32)), false)
  assert.equal(canDecodeCredentialBase64('FUTURE_FIELD', 'A'.repeat(32)), true)
  assert.equal(canDecodeCredentialBase64('FUTURE_FIELD', 'plain text'), false)
})

await test('strict decoder accepts padded, unpadded, and whitespace Base64', () => {
  assert.equal(decodeCredentialBase64('c2VjcmV0').toString(), 'secret')
  assert.equal(decodeCredentialBase64('c2VjcmV0\n').toString(), 'secret')
  assert.equal(decodeCredentialBase64('YQ==').toString(), 'a')
  assert.equal(decodeCredentialBase64('').length, 0)
})

await test('strict decoder rejects malformed Base64', () => {
  assert.throws(() => decodeCredentialBase64('not base64!'), /valid Base64/)
  assert.throws(() => decodeCredentialBase64('A'), /valid Base64/)
  assert.throws(() => decodeCredentialBase64('Y=Q='), /valid Base64/)
})

process.exit(failures > 0 ? 1 : 0)
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```sh
bun cli/test/test-credentials-export.mjs
```

Expected: FAIL because `credentials-base64.ts` does not exist.

- [ ] **Step 3: Add the shared helper and switch the manager to it**

Create `cli/src/build/credentials-base64.ts`:

```ts
import { Buffer } from 'node:buffer'

export function canDecodeCredentialBase64(key: string, value: string): boolean {
  if (key === 'CAPGO_IOS_PROVISIONING_MAP')
    return false
  if (key.endsWith('_BASE64'))
    return true
  if (key === 'APPLE_KEY_CONTENT' || key === 'ANDROID_KEYSTORE_FILE' || key === 'PLAY_CONFIG_JSON')
    return true
  return value.length >= 32 && /^[A-Z0-9+/=\s]+$/i.test(value)
}

export function decodeCredentialBase64(value: string): Buffer {
  const normalized = value.replace(/[\t\n\r ]/g, '')
  if (normalized === '')
    return Buffer.alloc(0)
  const padded = normalized.includes('=')
  if (!/^[A-Z0-9+/]*={0,2}$/i.test(normalized)
    || (padded ? normalized.length % 4 !== 0 : normalized.length % 4 === 1))
    throw new Error('The stored value is not valid Base64')

  const decoded = Buffer.from(normalized, 'base64')
  const canonical = decoded.toString('base64')
  if (padded ? canonical !== normalized : canonical.replace(/=+$/, '') !== normalized)
    throw new Error('The stored value is not valid Base64')
  return decoded
}
```

In `credentials-manage.ts`, import `canDecodeCredentialBase64`, replace every
`canDecodeBase64(...)` call with it, and remove the private `canDecodeBase64`
function. Do not change any other manager behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```sh
bun cli/test/test-credentials-export.mjs
bun run --cwd cli build
```

Expected: the three helper tests pass and the CLI builds successfully.

- [ ] **Step 5: Commit the shared behavior**

```sh
git add cli/src/build/credentials-base64.ts cli/src/build/credentials-manage.ts cli/test/test-credentials-export.mjs
git commit -m "refactor(cli): share credential base64 handling"
```

### Task 2: Implement deterministic saved-value resolution

**Files:**
- Create: `cli/src/build/credentials-export-command.ts`
- Modify: `cli/test/test-credentials-export.mjs`

- [ ] **Step 1: Add failing resolver tests**

Extend the import in `test-credentials-export.mjs`:

```js
const { resolveCredentialsExport } = await import('../src/build/credentials-export-command.ts')
```

Add table-driven tests using these fixtures and assertions before the final
`process.exit`:

```js
const appId = 'com.example.app'
const localIos = { ios: { BUILD_CERTIFICATE_BASE64: 'local-cert', P12_PASSWORD: '' } }
const globalAndroid = { android: { ANDROID_KEYSTORE_FILE: 'global-store' } }

await test('automatically chooses the only configured source and platform', () => {
  assert.deepEqual(
    resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId }, { local: localIos, global: null }),
    { value: 'local-cert', source: 'local', platforms: ['ios'] },
  )
})

await test('requires a source flag whenever both stores configure the app', () => {
  assert.throws(
    () => resolveCredentialsExport('BUILD_CERTIFICATE_BASE64', { appId }, { local: localIos, global: localIos }),
    /--local.*--global/,
  )
})

await test('an explicit source never falls back', () => {
  assert.throws(
    () => resolveCredentialsExport('ANDROID_KEYSTORE_FILE', { appId, local: true }, { local: localIos, global: globalAndroid }),
    /local.*ANDROID_KEYSTORE_FILE/i,
  )
})

await test('rejects selecting local and global together', () => {
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, local: true, global: true }, { local: localIos, global: null }),
    /cannot use --local and --global together/i,
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

await test('preserves an intentionally empty stored value', () => {
  assert.equal(
    resolveCredentialsExport('P12_PASSWORD', { appId, platform: 'ios' }, { local: localIos, global: null }).value,
    '',
  )
})

await test('validates explicit platforms and missing configuration', () => {
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, platform: 'web' }, { local: localIos, global: null }),
    /ios or android/,
  )
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId, platform: 'android' }, { local: localIos, global: null }),
    /android.*not configured/i,
  )
  assert.throws(
    () => resolveCredentialsExport('P12_PASSWORD', { appId }, { local: null, global: null }),
    /No saved Builder credentials/,
  )
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun cli/test/test-credentials-export.mjs
```

Expected: FAIL because `credentials-export-command.ts` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Create `cli/src/build/credentials-export-command.ts` with these public types and
functions; command I/O is added in Task 3:

```ts
import type { SavedCredentials } from '../schemas/build'

export interface CredentialsExportOptions {
  appId?: string
  platform?: string
  local?: boolean
  global?: boolean
  file?: string
  raw?: boolean
  decodeBase64?: boolean
}

export interface CredentialsExportStores {
  local: SavedCredentials | null
  global: SavedCredentials | null
}

export interface ResolvedCredentialsExport {
  value: string
  source: 'local' | 'global'
  platforms: Array<'ios' | 'android'>
}

export function isCredentialsExportInvocation(argv: readonly string[]): boolean {
  return argv[2] === 'build' && argv[3] === 'credentials' && argv[4] === 'export'
}

function hasPlatformConfiguration(credentials: Record<string, unknown> | undefined): boolean {
  return credentials !== undefined && Object.values(credentials).some(value => typeof value === 'string')
}

function hasAppConfiguration(credentials: SavedCredentials | null): credentials is SavedCredentials {
  return credentials !== null
    && (hasPlatformConfiguration(credentials.ios) || hasPlatformConfiguration(credentials.android))
}

function storedValue(credentials: SavedCredentials, platform: 'ios' | 'android', variable: string): string | undefined {
  const value = (credentials[platform] as Record<string, unknown> | undefined)?.[variable]
  return typeof value === 'string' ? value : undefined
}

export function resolveCredentialsExport(
  variable: string,
  options: CredentialsExportOptions,
  stores: CredentialsExportStores,
): ResolvedCredentialsExport {
  if (options.local && options.global)
    throw new Error('Cannot use --local and --global together')

  const localConfigured = hasAppConfiguration(stores.local)
  const globalConfigured = hasAppConfiguration(stores.global)
  let source: 'local' | 'global'
  let saved: SavedCredentials

  if (options.local || options.global) {
    source = options.local ? 'local' : 'global'
    const selected = stores[source]
    if (!hasAppConfiguration(selected))
      throw new Error(`No saved Builder credentials for ${options.appId} in the ${source} store`)
    saved = selected
  }
  else if (localConfigured && globalConfigured) {
    throw new Error('Saved Builder credentials exist in both stores; pass --local or --global')
  }
  else if (localConfigured) {
    source = 'local'
    saved = stores.local
  }
  else if (globalConfigured) {
    source = 'global'
    saved = stores.global
  }
  else {
    throw new Error(`No saved Builder credentials for ${options.appId}`)
  }

  if (options.platform !== undefined && options.platform !== 'ios' && options.platform !== 'android')
    throw new Error('--platform must be ios or android')

  if (options.platform === 'ios' || options.platform === 'android') {
    if (!hasPlatformConfiguration(saved[options.platform]))
      throw new Error(`${options.platform} is not configured in the ${source} store`)
    const value = storedValue(saved, options.platform, variable)
    if (value === undefined)
      throw new Error(`${variable} is not stored for ${options.platform} in the ${source} store`)
    return { value, source, platforms: [options.platform] }
  }

  const iosConfigured = hasPlatformConfiguration(saved.ios)
  const androidConfigured = hasPlatformConfiguration(saved.android)
  if (iosConfigured && androidConfigured) {
    const iosValue = storedValue(saved, 'ios', variable)
    const androidValue = storedValue(saved, 'android', variable)
    if (iosValue !== undefined && androidValue !== undefined && iosValue === androidValue)
      return { value: iosValue, source, platforms: ['ios', 'android'] }
    if (iosValue === undefined && androidValue === undefined)
      throw new Error(`${variable} is not stored for ios or android in the ${source} store`)
    throw new Error(`${variable} is ambiguous across ios and android; pass --platform`)
  }

  const platform = iosConfigured ? 'ios' : 'android'
  const value = storedValue(saved, platform, variable)
  if (value === undefined)
    throw new Error(`${variable} is not stored for ${platform} in the ${source} store`)
  return { value, source, platforms: [platform] }
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```sh
bun cli/test/test-credentials-export.mjs
bun run --cwd cli typecheck
```

Expected: resolver tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit deterministic resolution**

```sh
git add cli/src/build/credentials-export-command.ts cli/test/test-credentials-export.mjs
git commit -m "feat(cli): resolve saved credential exports"
```

### Task 3: Add raw and secure file output through the public CLI

**Files:**
- Modify: `cli/src/build/credentials-export-command.ts`
- Modify: `cli/src/build/credentials.ts:132-170`
- Modify: `cli/src/index.ts:1-20,1216-1232`
- Modify: `cli/test/test-credentials-export.mjs`
- Modify: `cli/package.json`

- [ ] **Step 1: Add failing public-command and file-safety tests**

Extend `test-credentials-export.mjs` with this child-process fixture helper:

```js
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  if (fixture.local !== undefined)
    writeFileSync(join(cwd, '.capgo-credentials.json'), JSON.stringify(fixture.local))
  if (fixture.localContents !== undefined)
    writeFileSync(join(cwd, '.capgo-credentials.json'), fixture.localContents)
  if (fixture.global !== undefined) {
    const credentialsDir = join(home, '.capgo-credentials')
    mkdirSync(credentialsDir, { recursive: true })
    writeFileSync(join(credentialsDir, 'credentials.json'), JSON.stringify(fixture.global))
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

  const result = spawnSync(process.execPath, [cliEntry, 'build', 'credentials', 'export', ...args], {
    cwd,
    encoding: 'utf8',
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
```

Add `mkdtempSync` to the `node:fs` import. After all assertions and before
`process.exit`, remove each `tempRoots` entry with
`rmSync(root, { recursive: true, force: true })`.

The tests must assert all of these concrete behaviors:

```js
await test('raw mode prints only the stored value and no newline', () => {
  const result = runCli(['BUILD_CERTIFICATE_BASE64', '--app-id', appId, '--raw'], {
    local: { [appId]: { ios: { BUILD_CERTIFICATE_BASE64: 'exact-value' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'exact-value')
  assert.equal(result.stderr, '')
})

await test('raw mode ignores same-named environment variables', () => {
  const result = runCli(['BUILD_CERTIFICATE_BASE64', '--appId', appId, '--raw'], {
    local: { [appId]: { ios: { BUILD_CERTIFICATE_BASE64: 'saved-value' } } },
    env: { BUILD_CERTIFICATE_BASE64: 'environment-value' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'saved-value')
})

await test('raw mode can export an intentionally empty value', () => {
  const result = runCli(['P12_PASSWORD', '--app-id', appId, '--raw'], {
    local: { [appId]: { ios: { P12_PASSWORD: '' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

await test('raw failures use stderr, status 1, and never leak values', () => {
  const result = runCli(['SHARED', '--app-id', appId, '--raw'], {
    local: { [appId]: { ios: { SHARED: 'ios-secret' }, android: { SHARED: 'android-secret' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--platform/)
  assert.doesNotMatch(result.stderr, /ios-secret|android-secret/)
})

await test('file mode writes literal Base64 without a newline and warns in CI', () => {
  const result = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--file', 'keystore.txt'], {
    local: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'c2VjcmV0' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(readFileSync(join(result.cwd, 'keystore.txt'), 'utf8'), 'c2VjcmV0')
  assert.match(result.stdout, /not decoded|--decode-base64/i)
  assert.equal(statSync(join(result.cwd, 'keystore.txt')).mode & 0o777, 0o600)
})

await test('decode-base64 writes decoded bytes', () => {
  const result = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--file', 'keystore.bin', '--decode-base64'], {
    local: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'c2VjcmV0' } } },
  })
  assert.equal(result.status, 0)
  assert.equal(readFileSync(join(result.cwd, 'keystore.bin'), 'utf8'), 'secret')
})

await test('file mode refuses existing destinations and symlinks', () => {
  for (const destination of ['existing.txt', 'link.txt']) {
    const result = runCli(['P12_PASSWORD', '--app-id', appId, '--file', destination], {
      local: { [appId]: { ios: { P12_PASSWORD: '' } } },
      existingDestination: destination,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already exists/i)
  }
})

await test('invalid decode fails before creating the destination', () => {
  const result = runCli(['FUTURE_VALUE', '--app-id', appId, '--file', 'bad.bin', '--decode-base64'], {
    local: { [appId]: { ios: { FUTURE_VALUE: 'not base64!' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(existsSync(join(result.cwd, 'bad.bin')), false)
})

await test('validates output and source option combinations', () => {
  for (const args of [
    ['--app-id', appId, '--raw'],
    ['P12_PASSWORD', '--raw'],
    ['P12_PASSWORD', '--app-id', appId],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--file', 'x'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--decode-base64'],
    ['P12_PASSWORD', '--app-id', appId, '--file', '-'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--local', '--global'],
    ['P12_PASSWORD', '--app-id', appId, '--raw', '--unknown-option'],
  ]) {
    const result = runCli(args, { local: { [appId]: { ios: { P12_PASSWORD: '' } } } })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.notEqual(result.stderr, '')
  }
})

await test('does not silently fall back when a saved store cannot be parsed', () => {
  const result = runCli(['ANDROID_KEYSTORE_FILE', '--app-id', appId, '--raw'], {
    localContents: '{invalid-json',
    global: { [appId]: { android: { ANDROID_KEYSTORE_FILE: 'global-secret' } } },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /global-secret/)
})

await test('help documents raw stdout and failure guarantees', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /no trailing newline/i)
  assert.match(result.stdout, /stderr/i)
  assert.match(result.stdout, /status 1/i)
})
```

Also extend the command-module import to include
`resolveCredentialsFileValue`, then add:

```js
await test('interactive file choice decodes only when accepted', async () => {
  const accepted = await resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
    interactive: true,
    promptDecode: async () => true,
  })
  assert.equal(accepted.data.toString(), 'secret')
  assert.equal(accepted.decoded, true)

  const declined = await resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
    interactive: true,
    promptDecode: async () => false,
  })
  assert.equal(declined.data, 'c2VjcmV0')
  assert.equal(declined.warnLiteral, true)
})

await test('canceling an interactive decode prompt fails', async () => {
  await assert.rejects(
    () => resolveCredentialsFileValue('ANDROID_KEYSTORE_FILE', 'c2VjcmV0', {
      interactive: true,
      promptDecode: async () => Symbol('cancel'),
    }),
    /canceled/,
  )
})
```

- [ ] **Step 2: Build and run the test to verify RED**

Run:

```sh
bun run --cwd cli build
bun cli/test/test-credentials-export.mjs
```

Expected: pure tests pass but public-command tests fail because the export
command is not registered and the handler has no I/O implementation.

- [ ] **Step 3: Implement command validation, decode choice, and secure output**

First, extend `loadAllCredentials` and `loadSavedCredentials` in
`credentials.ts` with an optional `throwOnReadError = false` parameter. In the
existing read/parse behavior so strict mode returns `{}` only for `ENOENT` and
uses generic, non-secret errors for other read or parse failures. Pass the
strict flag through every `loadAllCredentials` call inside
`loadSavedCredentials`:

```ts
async function loadAllCredentials(local?: boolean, throwOnReadError = false): Promise<AllCredentials> {
  const filePath = getCredentialsPath(local)
  let content: string
  try {
    content = await readSafeFile(filePath)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {}
    if (throwOnReadError)
      throw new Error(`Cannot read saved credentials file: ${filePath}`)
    return {}
  }
  try {
    return JSON.parse(content) as AllCredentials
  }
  catch {
    if (throwOnReadError)
      throw new Error(`Cannot parse saved credentials file: ${filePath}`)
    return {}
  }
}

export async function loadSavedCredentials(
  appId?: string,
  local?: boolean,
  throwOnReadError = false,
): Promise<SavedCredentials | null> {
  if (local !== undefined) {
    const all = await loadAllCredentials(local, throwOnReadError)
    if (!appId) {
      const appIds = Object.keys(all)
      if (appIds.length === 0)
        return null
      return all[appIds[0]] || null
    }
    return all[appId] || null
  }

  const localAll = await loadAllCredentials(true, throwOnReadError)
  const globalAll = await loadAllCredentials(false, throwOnReadError)
  if (!appId) {
    const localAppIds = Object.keys(localAll)
    if (localAppIds.length > 0)
      return localAll[localAppIds[0]] || null

    const globalAppIds = Object.keys(globalAll)
    if (globalAppIds.length === 0)
      return null
    return globalAll[globalAppIds[0]] || null
  }

  return localAll[appId] || globalAll[appId] || null
}
```

Then extend `credentials-export-command.ts` with:

```ts
import type { FileHandle } from 'node:fs/promises'
import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exit, stderr, stdout } from 'node:process'
import { confirm, log } from '@clack/prompts'
import { formatError, canPromptInteractively } from '../utils'
import { canDecodeCredentialBase64, decodeCredentialBase64 } from './credentials-base64'
import { getGlobalCredentialsPath, getLocalCredentialsPath, loadSavedCredentials } from './credentials'

export async function resolveCredentialsFileValue(
  variable: string,
  value: string,
  options: { decodeBase64?: boolean, interactive: boolean, promptDecode: () => Promise<boolean | symbol> },
): Promise<{ data: string | Buffer, decoded: boolean, warnLiteral: boolean }> {
  if (options.decodeBase64)
    return { data: decodeCredentialBase64(value), decoded: true, warnLiteral: false }
  if (!canDecodeCredentialBase64(variable, value))
    return { data: value, decoded: false, warnLiteral: false }
  if (!options.interactive)
    return { data: value, decoded: false, warnLiteral: true }
  const answer = await options.promptDecode()
  if (typeof answer === 'symbol')
    throw new Error('Credential export canceled')
  return answer
    ? { data: decodeCredentialBase64(value), decoded: true, warnLiteral: false }
    : { data: value, decoded: false, warnLiteral: true }
}

async function writeExclusive(path: string, data: string | Buffer): Promise<void> {
  let handle: FileHandle | undefined
  let created = false
  try {
    handle = await open(path, 'wx', 0o600)
    created = true
    await handle.writeFile(data)
    await handle.chmod(0o600)
  }
  catch (error) {
    await handle?.close().catch(() => {})
    handle = undefined
    if (created)
      await unlink(path).catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Destination already exists: ${path}`)
    throw error
  }
  finally {
    await handle?.close()
  }
}

export async function exportCredentialsCommand(variable: string | undefined, options: CredentialsExportOptions): Promise<void> {
  try {
    if (!variable)
      throw new Error('Variable is required')
    if (!options.appId)
      throw new Error('--app-id <APP_ID> is required')
    if (Boolean(options.raw) === Boolean(options.file))
      throw new Error('Pass exactly one of --raw or --file <PATH>')
    if (options.decodeBase64 && options.raw)
      throw new Error('--decode-base64 cannot be used with --raw')
    if (options.file === '-')
      throw new Error('--file - is not supported; use --raw for stdout')

    const stores = {
      local: await loadSavedCredentials(options.appId, true, true),
      global: await loadSavedCredentials(options.appId, false, true),
    }
    const resolved = resolveCredentialsExport(variable, options, stores)
    if (options.raw) {
      stdout.write(resolved.value)
      return
    }

    const fileValue = await resolveCredentialsFileValue(variable, resolved.value, {
      decodeBase64: options.decodeBase64,
      interactive: canPromptInteractively(),
      promptDecode: () => confirm({ message: `${variable} looks like Base64. Decode it before writing the file?` }),
    })
    const destination = resolve(options.file!)
    await writeExclusive(destination, fileValue.data)
    if (fileValue.warnLiteral)
      log.warn(`Saved the stored Base64 text without decoding it. Pass --decode-base64 to write decoded bytes.`)
    const sourcePath = resolved.source === 'local' ? getLocalCredentialsPath() : getGlobalCredentialsPath()
    log.success(`Exported ${variable} from ${resolved.source} ${resolved.platforms.join('/')} credentials (${sourcePath}) to ${destination}${fileValue.decoded ? ' as decoded bytes' : ''}.`)
  }
  catch (error) {
    const message = formatError(error)
    stderr.write(`${message}\n`)
    exit(1)
  }
}
```

Do not include any stored value in diagnostics.

- [ ] **Step 4: Register only the Commander command**

Import `exportCredentialsCommand` and `isCredentialsExportInvocation` in
`cli/src/index.ts`, then register:

```ts
buildCredentials
  .command('export [variable]')
  .description(`Export one saved Builder credential or configuration value.

Raw mode prints only the exact stored value to stdout with no trailing newline.
All failures are written to stderr and exit with status 1. Saved local/global
configuration is used; environment variables are never exported.`)
  .action(exportCredentialsCommand)
  .option('--app-id <appId>', 'App ID whose saved Builder value will be exported (required)')
  .addOption(new Option('--appId <appId>', 'Compatibility alias for --app-id').hideHelp())
  .option('--platform <platform>', 'Platform: ios or android (required when saved platform values are ambiguous)')
  .option('--local', 'Export only from the project-local .capgo-credentials.json')
  .option('--global', 'Export only from ~/.capgo-credentials/credentials.json')
  .option('--file <path>', 'Write the value to a new file; existing destinations are never overwritten')
  .option('--raw', 'Write only the exact stored value to stdout without a trailing newline')
  .option('--decode-base64', 'Decode Base64 before file output; valid only with --file')
```

In the existing Commander-error catch branch at the bottom of `index.ts`, route
parser diagnostics for this command to stderr while preserving every other
command's current behavior:

```ts
if (commanderError.message) {
  if (isCredentialsExportInvocation(process.argv))
    process.stderr.write(`${commanderError.message}\n`)
  else
    log.error(commanderError.message)
}
```

Do not change any file under `cli/src/mcp/` or
`cli/src/build/onboarding/mcp/`.

- [ ] **Step 5: Add the focused test script and run GREEN verification**

Add to `cli/package.json`:

```json
"test:credentials-export": "bun test/test-credentials-export.mjs"
```

Insert `bun run test:credentials-export` immediately after
`bun run test:credentials` in the full `test` script.

Run:

```sh
bun run --cwd cli build
bun run --cwd cli test:credentials-export
bun run --cwd cli test:credentials
bun run --cwd cli test:ci-prompts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the public command**

```sh
git add cli/src/build/credentials-export-command.ts cli/src/build/credentials.ts cli/src/index.ts cli/test/test-credentials-export.mjs cli/package.json
git commit -m "feat(cli): export saved builder credentials"
```

### Task 4: Publish docs and prove the complete change

**Files:**
- Modify (generated): `cli/README.md`
- Modify (generated): `cli/webdocs/build.mdx`
- Modify: `cli/skills/native-builds/SKILL.md`

- [ ] **Step 1: Generate command documentation**

Run:

```sh
bun run --cwd cli build
bun run --cwd cli generate-docs
bun cli/dist/index.js generate-docs --folder cli/webdocs
```

Expected: the CLI README and `webdocs/build.mdx` include the new export command,
canonical `--app-id`, raw-output contract, and all options. Revert any unrelated
generated webdoc changes if the generator touches them without content changes.

- [ ] **Step 2: Update the native-build Intent skill**

Add this section after `build credentials update` in
`cli/skills/native-builds/SKILL.md`:

````md
### `build credentials export <VARIABLE>`

- Exports one value from saved Builder credentials; environment variables are never used.
- Requires `--app-id <APP_ID>` (the compatibility alias `--appId` is also accepted).
- Requires exactly one of:
  - `--raw`: prints only the exact stored value to stdout, with no trailing newline.
  - `--file <PATH>`: creates a new `0600` file and never overwrites an existing path.
- Use `--decode-base64` with `--file` to write decoded bytes; otherwise Base64 is saved as stored.
- Use `--local` or `--global` when the app exists in both stores.
- Use `--platform ios|android` when platform values are ambiguous.

```bash
npx @capgo/cli@latest build credentials export ANDROID_KEYSTORE_FILE \
  --app-id com.example.app --platform android --file ./release.keystore --decode-base64
```

````

- [ ] **Step 3: Run formatting, required CLI gates, and full tests**

Run in this order and inspect every output:

```sh
bun run --cwd cli lint
bun run --cwd cli typecheck
bun run --cwd cli build
bun run --cwd cli test:mcp
bun run --cwd cli test:bundle
bun run cli:test
bun cli/dist/index.js build credentials export --help
bun cli/dist/index.js --help
bun cli/dist/index.js --version
```

Expected: every command exits 0. The export help contains the raw stdout,
stderr, no-newline, and exit-status contract.

- [ ] **Step 4: Verify scope, line budget, and generated artifacts**

Run:

```sh
git diff --check
git status --short
git diff --name-only HEAD~3
git diff --numstat HEAD~3 -- cli/src cli/package.json
git diff HEAD~3 -- cli/src/mcp cli/src/build/onboarding/mcp
```

Expected:

- production additions plus deletions under `cli/src` and `cli/package.json`
  total strictly less than 400;
- the MCP diff is empty;
- `codedb.snapshot` remains unstaged and is not part of any feature commit;
- no credential values or test secrets appear in generated docs or diagnostics.

- [ ] **Step 5: Commit documentation and any lint-only adjustments**

```sh
git add cli/README.md cli/webdocs/build.mdx cli/skills/native-builds/SKILL.md
git commit -m "docs(cli): document credential export"
```

- [ ] **Step 6: Request final spec and code-quality review**

Review the complete branch against
`docs/superpowers/specs/2026-08-27-builder-credentials-export-design.md`.
Fix every missing requirement and every Critical or Important quality issue,
rerun the required gates after fixes, and commit the fixes with a conventional
commit message.
