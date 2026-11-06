#!/usr/bin/env node
// --build-env / CAPGO_BUILD_ENV parsing.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parseBuildEnv } = await import('../src/build/build-env.ts')
const { parseDebugSymbolsUrl, writeBuildOutputRecord } = await import('../src/build/output-record.ts')

let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
  }
  catch (error) {
    failed++
    console.error(`❌ ${name}: ${error.message}`)
  }
}
function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function assertThrows(fn, pattern) {
  try {
    fn()
  }
  catch (error) {
    if (!pattern.test(error.message))
      throw new Error(`Unexpected error: ${error.message}`)
    return
  }
  throw new Error('Expected an error')
}

test('KEY reads the value from the environment, KEY=VALUE is literal', () => {
  assertEquals(
    parseBuildEnv(['SENTRY_AUTH_TOKEN', 'SENTRY_ORG=acme'], { SENTRY_AUTH_TOKEN: 'secret' }),
    { SENTRY_AUTH_TOKEN: 'secret', SENTRY_ORG: 'acme' },
  )
})

test('CAPGO_BUILD_ENV lists names, CLI entries win', () => {
  assertEquals(
    parseBuildEnv(['B=cli'], { CAPGO_BUILD_ENV: 'A, B', A: '1', B: 'env' }),
    { A: '1', B: 'cli' },
  )
})

test('values may contain =', () => {
  assertEquals(parseBuildEnv(['DSN=https://x@y/1?a=b'], {}), { DSN: 'https://x@y/1?a=b' })
})

test('missing env value fails', () => {
  assertThrows(() => parseBuildEnv(['SENTRY_AUTH_TOKEN'], {}), /not set/)
})

test('invalid and reserved names fail', () => {
  assertThrows(() => parseBuildEnv(['lower=1'], {}), /uppercase/)
  assertThrows(() => parseBuildEnv(['CAPGO_IOS_SCHEME=App'], {}), /reserved/)
  assertThrows(() => parseBuildEnv(['P12_PASSWORD=x'], {}), /reserved/)
  assertThrows(() => parseBuildEnv(['OUTPUT_UPLOAD_URL_IOS=x'], {}), /reserved/)
})

test('debug symbols URL is read from the builder log line', () => {
  assertEquals(
    parseDebugSymbolsUrl('🧩 Debug symbols for crash reporting (iOS dSYMs zip): https://builder.capgo.app/builder_download_direct_artefact/abc'),
    'https://builder.capgo.app/builder_download_direct_artefact/abc',
  )
  assertEquals(parseDebugSymbolsUrl('Uploading IPA artifact to R2'), null)
})

const dir = mkdtempSync(join(tmpdir(), 'capgo-record-'))
const record = await writeBuildOutputRecord(join(dir, 'build.json'), {
  jobId: 'job', appId: 'com.example', platform: 'android', buildMode: 'release', status: 'succeeded',
  outputUrl: null, symbolsUrl: 'https://x/mapping',
})
test('output record stores symbolsUrl', () => {
  assertEquals(record.symbolsUrl, 'https://x/mapping')
  assertEquals(JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')).symbolsUrl, 'https://x/mapping')
})
rmSync(dir, { recursive: true, force: true })

if (failed > 0)
  process.exit(1)
console.log('\n✅ All build env / symbols tests passed!')
