#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  assertAppAllowsPreview,
  buildPreviewQrUrl,
  renderTerminalQrCode,
  resolvePreviewQrTarget,
  resolvePreviewQrOutputValue,
} from '../src/preview/qr.ts'
import { buildPreviewWebUrl } from '../src/preview/web-url.ts'
import { buildBundleUploadPreviewQrOptions } from '../src/bundle/upload-preview-qr.ts'

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

function createSupabaseStub({ apps = [], bundles = [], channels = [] }) {
  const tables = {
    apps,
    app_versions: bundles,
    channels,
  }

  return {
    from(table) {
      const filters = []
      const builder = {
        select() {
          return builder
        },
        eq(column, value) {
          filters.push({ column, value })
          return builder
        },
        maybeSingle() {
          const rows = (tables[table] ?? []).filter(row => filters.every(filter => row[filter.column] === filter.value))
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
        single() {
          const rows = (tables[table] ?? []).filter(row => filters.every(filter => row[filter.column] === filter.value))
          if (!rows[0])
            return Promise.resolve({ data: null, error: { message: 'not found' } })
          return Promise.resolve({ data: rows[0], error: null })
        },
      }
      return builder
    },
  }
}

await test('builds compact bundle preview deep link', () => {
  assert.equal(
    buildPreviewQrUrl({ appId: 'com.example.app', bundleName: '1.2.3', kind: 'bundle', versionId: 42 }),
    'capgo://preview/bundle?appId=com.example.app&versionId=42',
  )
})

await test('builds compact channel preview deep link', () => {
  assert.equal(
    buildPreviewQrUrl({ appId: 'com.example.app', channelId: 7, channelName: 'production', kind: 'channel' }),
    'capgo://preview/channel?appId=com.example.app&channel=production&channelId=7',
  )
})

await test('resolves bundle refs by id or name', async () => {
  const supabase = createSupabaseStub({
    bundles: [
      { app_id: 'com.example.app', deleted: false, id: 42, name: '1.2.3' },
      { app_id: 'com.example.app', deleted: false, id: 99, name: 'numeric-name' },
    ],
  })

  assert.deepEqual(
    await resolvePreviewQrTarget(supabase, 'com.example.app', { bundle: '42' }),
    { appId: 'com.example.app', bundleName: '1.2.3', kind: 'bundle', versionId: 42 },
  )
  assert.deepEqual(
    await resolvePreviewQrTarget(supabase, 'com.example.app', { bundle: 'numeric-name' }),
    { appId: 'com.example.app', bundleName: 'numeric-name', kind: 'bundle', versionId: 99 },
  )
})

await test('resolves channel refs by id or name', async () => {
  const supabase = createSupabaseStub({
    channels: [
      { app_id: 'com.example.app', id: 7, name: 'production' },
      { app_id: 'com.example.app', id: 8, name: 'beta' },
    ],
  })

  assert.deepEqual(
    await resolvePreviewQrTarget(supabase, 'com.example.app', { channel: '7' }),
    { appId: 'com.example.app', channelId: 7, channelName: 'production', kind: 'channel' },
  )
  assert.deepEqual(
    await resolvePreviewQrTarget(supabase, 'com.example.app', { channel: 'beta' }),
    { appId: 'com.example.app', channelId: 8, channelName: 'beta', kind: 'channel' },
  )
})

await test('requires type when positional target is ambiguous', async () => {
  const supabase = createSupabaseStub({
    bundles: [{ app_id: 'com.example.app', deleted: false, id: 42, name: 'production' }],
    channels: [{ app_id: 'com.example.app', id: 7, name: 'production' }],
  })

  await assert.rejects(
    () => resolvePreviewQrTarget(supabase, 'com.example.app', { target: 'production' }),
    /matches both a bundle and a channel/,
  )
})

await test('rejects QR when app preview is disabled', async () => {
  const supabase = createSupabaseStub({
    apps: [{ app_id: 'com.example.app', allow_preview: false }],
  })

  await assert.rejects(
    () => assertAppAllowsPreview(supabase, 'com.example.app'),
    /Preview is disabled/,
  )
})


await test('builds web preview URLs for bundle and channel targets', () => {
  assert.equal(
    buildPreviewWebUrl({ appId: 'com.example.app', bundleName: '1.2.3', kind: 'bundle', versionId: 42 }),
    'https://42-com-0example-0app.preview.capgo.app/',
  )
  assert.equal(
    buildPreviewWebUrl({ appId: 'com.example.app', channelId: 7, channelName: 'production', kind: 'channel' }, 'dev'),
    'https://c7-com-0example-0app.preview.dev.capgo.app/',
  )
})

await test('can target web preview URLs for QR output', () => {
  const target = { appId: 'com.example.app', bundleName: '1.2.3', kind: 'bundle', versionId: 42 }
  assert.equal(
    resolvePreviewQrOutputValue(target, { webUrl: true }),
    'https://42-com-0example-0app.preview.capgo.app/',
  )
})

await test('renders terminal QR text', async () => {
  const qr = await renderTerminalQrCode('capgo://preview/bundle?appId=com.example.app&versionId=42')
  assert.match(qr, /\n/)
  assert.ok(qr.length > 100)
})

await test('post-upload QR options do not forward the upload channel target', () => {
  assert.deepEqual(
    buildBundleUploadPreviewQrOptions({
      apikey: 'test-key',
      bundle: 'original-bundle-option',
      channel: 'production',
      qrPreview: true,
      supaAnon: 'anon',
      supaHost: 'https://example.test',
    }, 'uploaded-bundle'),
    {
      apikey: 'test-key',
      bundle: 'uploaded-bundle',
      supaAnon: 'anon',
      supaHost: 'https://example.test',
    },
  )
})

if (failures > 0) {
  console.error(`\n❌ ${failures} preview QR test(s) failed`)
  process.exit(1)
}

console.log('\n✅ Preview QR checks work')
