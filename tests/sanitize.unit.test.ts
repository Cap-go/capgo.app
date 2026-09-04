import { describe, expect, it } from 'vitest'
import { isLocalDevHost, isSafeImageFetchUrl, sanitizeHttpUrl } from '../src/utils/sanitize.ts'

describe('isLocalDevHost', () => {
  it.concurrent('recognizes localhost and loopback hostnames', () => {
    expect(isLocalDevHost('localhost')).toBe(true)
    expect(isLocalDevHost('app.localhost')).toBe(true)
    expect(isLocalDevHost('127.0.0.1')).toBe(true)
    expect(isLocalDevHost('::1')).toBe(true)
    expect(isLocalDevHost('[::1]')).toBe(true)
    expect(isLocalDevHost('evil.example')).toBe(false)
  })
})

describe('sanitizeHttpUrl', () => {
  it.concurrent('accepts https URLs', () => {
    expect(sanitizeHttpUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it.concurrent('rejects javascript, data, vbscript, and missing schemes', () => {
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeHttpUrl('data:text/html,alert(1)')).toBeNull()
    expect(sanitizeHttpUrl('vbscript:msgbox(1)')).toBeNull()
    expect(sanitizeHttpUrl('not-a-url')).toBeNull()
    expect(sanitizeHttpUrl('http://evil.example')).toBeNull()
  })

  it.concurrent('allows localhost http in dev-style URLs', () => {
    expect(sanitizeHttpUrl('http://localhost:5173/path')).toBe('http://localhost:5173/path')
    expect(sanitizeHttpUrl('http://app.localhost/path')).toBe('http://app.localhost/path')
    expect(sanitizeHttpUrl('http://127.0.0.1:5173/path')).toBe('http://127.0.0.1:5173/path')
    expect(sanitizeHttpUrl('http://[::1]:5173/path')).toBe('http://[::1]:5173/path')
  })
})

describe('isSafeImageFetchUrl', () => {
  it.concurrent('accepts https image sources only', () => {
    expect(isSafeImageFetchUrl('https://cdn.example/icon.png')).toBe(true)
    expect(isSafeImageFetchUrl('http://cdn.example/icon.png')).toBe(false)
  })

  it.concurrent('accepts localhost http image sources', () => {
    expect(isSafeImageFetchUrl('http://localhost/icon.png')).toBe(true)
    expect(isSafeImageFetchUrl('http://127.0.0.1/icon.png')).toBe(true)
    expect(isSafeImageFetchUrl('http://[::1]/icon.png')).toBe(true)
  })
})
