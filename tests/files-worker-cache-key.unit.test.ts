import { describe, expect, it } from 'vitest'
import { buildWorkersCacheKey } from '../cloudflare_workers/files/cache_key.ts'

const url = 'https://files.example.com/files/read/attachments/orgs/fake/apps/com.example.fake/delta/key'
describe('files entrypoint cache routing', () => {
  it.each(['GET', 'HEAD'])('keeps %s receipt requests inside the exact-key evidence handler', (method) => {
    expect(buildWorkersCacheKey(new Request(url, { method, headers: { 'x-cli-version': '8.82.0' } }))).toBeNull()
    expect(buildWorkersCacheKey(new Request(`${url}?nocache=`, { method }))).toBeNull()
    expect(buildWorkersCacheKey(new Request(`${url}?nocache=unique`, { method }))).toBeNull()
  })
  it('retains managed caching for ordinary device downloads with stable tracking normalization', () => {
    expect(buildWorkersCacheKey(new Request(url))).toBe('/files-cache/files/read/attachments/orgs/fake/apps/com.example.fake/delta/key')
    expect(buildWorkersCacheKey(new Request(url, { headers: { 'x-cli-version': ' ' } }))).toBe(buildWorkersCacheKey(new Request(url)))
    expect(buildWorkersCacheKey(new Request(`${url}?device_id=fake-device`))).toBe(buildWorkersCacheKey(new Request(url)))
  })
  it('keys immutable previews by lowercase host and sorted query parameters', () => {
    expect(buildWorkersCacheKey(new Request('https://APP-123.preview.capgo.app/index.html?b=2&a=1'))).toBe('/preview-cache/app-123.preview.capgo.app/index.html?a=1&b=2')
  })
  it('does not cache unrelated paths on an ordinary host', () => {
    expect(buildWorkersCacheKey(new Request('https://files.example.com/ok'))).toBeNull()
  })
  it('bypasses mutable preview metadata and channel previews', () => {
    expect(buildWorkersCacheKey(new Request('https://app-123.preview.capgo.app/.capgo/preview.json'))).toBeNull()
    expect(buildWorkersCacheKey(new Request('https://app-123.preview.capgo.app/robots.txt'))).toBeNull()
    expect(buildWorkersCacheKey(new Request('https://c12-app.preview.capgo.app/index.html'))).toBeNull()
  })
  it('preserves range and non-GET bypasses', () => {
    expect(buildWorkersCacheKey(new Request(url, { headers: { range: 'bytes=0-1' } }))).toBeNull()
    expect(buildWorkersCacheKey(new Request(url, { method: 'POST' }))).toBeNull()
  })
})
