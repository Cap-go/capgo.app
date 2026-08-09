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

function createHttpStub({ apps = [], bundles = [], channels = [] }) {
  return {
    apikey: 'test-key',
    async invoke(path) {
      const url = new URL(path, 'https://example.test/')
      const pathname = url.pathname.replace(/^\//, '')

      if (pathname.startsWith('app/')) {
        const appId = decodeURIComponent(pathname.slice('app/'.length))
        const app = apps.find(row => row.app_id === appId)
        if (!app)
          return { data: null, error: Object.assign(new Error('not found'), { context: { status: 404 } }) }
        return { data: app, error: null }
      }

      if (pathname === 'bundle') {
        const appId = url.searchParams.get('app_id')
        const page = Number(url.searchParams.get('page') || '0')
        const rows = bundles.filter(row => row.app_id === appId && row.deleted === false)
        const slice = rows.slice(page * 50, page * 50 + 50)
        return { data: slice, error: null }
      }

      if (pathname === 'channel') {
        const appId = url.searchParams.get('app_id')
        const channelName = url.searchParams.get('channel')
        const page = Number(url.searchParams.get('page') || '0')
        const rows = channels.filter(row => row.app_id === appId)
        if (channelName) {
          const channel = rows.find(row => row.name === channelName)
          if (!channel)
            return { data: null, error: Object.assign(new Error('missing'), { context: { status: 400 } }) }
          return { data: channel, error: null }
        }
        return { data: rows.slice(page * 50, page * 50 + 50), error: null }
      }

      return { data: null, error: new Error(`unexpected path ${path}`) }
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
  const http = createHttpStub({
    bundles: [
      { app_id: 'com.example.app', deleted: false, id: 42, name: '1.2.3' },
      { app_id: 'com.example.app', deleted: false, id: 99, name: 'numeric-name' },
    ],
  })

  assert.deepEqual(
    await resolvePreviewQrTarget(http, 'com.example.app', { bundle: '42' }),
    { appId: 'com.example.app', bundleName: '1.2.3', kind: 'bundle', versionId: 42 },
  )
  assert.deepEqual(
    await resolvePreviewQrTarget(http, 'com.example.app', { bundle: 'numeric-name' }),
    { appId: 'com.example.app', bundleName: 'numeric-name', kind: 'bundle', versionId: 99 },
  )
})

await test('resolves channel refs by id or name', async () => {
  const http = createHttpStub({
    channels: [
      { app_id: 'com.example.app', id: 7, name: 'production' },
      { app_id: 'com.example.app', id: 8, name: 'beta' },
    ],
  })

  assert.deepEqual(
    await resolvePreviewQrTarget(http, 'com.example.app', { channel: '7' }),
    { appId: 'com.example.app', channelId: 7, channelName: 'production', kind: 'channel' },
  )
  assert.deepEqual(
    await resolvePreviewQrTarget(http, 'com.example.app', { channel: 'beta' }),
    { appId: 'com.example.app', channelId: 8, channelName: 'beta', kind: 'channel' },
  )
})

await test('requires type when positional target is ambiguous', async () => {
  const http = createHttpStub({
    bundles: [{ app_id: 'com.example.app', deleted: false, id: 42, name: 'production' }],
    channels: [{ app_id: 'com.example.app', id: 7, name: 'production' }],
  })

  await assert.rejects(
    () => resolvePreviewQrTarget(http, 'com.example.app', { target: 'production' }),
    /matches both a bundle and a channel/,
  )
})

await test('rejects QR when app preview is disabled', async () => {
  const http = createHttpStub({
    apps: [{ app_id: 'com.example.app', allow_preview: false }],
  })

  await assert.rejects(
    () => assertAppAllowsPreview(http, 'com.example.app'),
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
