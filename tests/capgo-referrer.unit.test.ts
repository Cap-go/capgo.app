import { describe, expect, it } from 'vitest'
import { isCapgoDomainReferrer, isDirectLoginLanding } from '../src/utils/capgoReferrer'

describe('isCapgoDomainReferrer', () => {
  it.concurrent('accepts Capgo marketing and console hosts', () => {
    expect(isCapgoDomainReferrer('https://capgo.app/register/')).toBe(true)
    expect(isCapgoDomainReferrer('https://www.capgo.app/register/')).toBe(true)
    expect(isCapgoDomainReferrer('https://console.capgo.app/login')).toBe(true)
    expect(isCapgoDomainReferrer('https://development.capgo.app/register')).toBe(true)
    expect(isCapgoDomainReferrer('https://sb.capgo.app/auth/v1/verify')).toBe(true)
  })

  it.concurrent('rejects missing, invalid, and non-Capgo referrers', () => {
    expect(isCapgoDomainReferrer(undefined)).toBe(false)
    expect(isCapgoDomainReferrer(null)).toBe(false)
    expect(isCapgoDomainReferrer('')).toBe(false)
    expect(isCapgoDomainReferrer('not-a-url')).toBe(false)
    expect(isCapgoDomainReferrer('https://evil.com/')).toBe(false)
    expect(isCapgoDomainReferrer('https://capgo.app.evil.com/')).toBe(false)
    expect(isCapgoDomainReferrer('https://notcapgo.app/')).toBe(false)
    expect(isCapgoDomainReferrer('http://localhost:5173/register')).toBe(false)
  })
})

describe('isDirectLoginLanding', () => {
  it.concurrent('is true only when the document first loaded on /login', () => {
    expect(isDirectLoginLanding('https://console.capgo.app/login')).toBe(true)
    expect(isDirectLoginLanding('https://console.capgo.app/login?access_token=a&refresh_token=b')).toBe(true)
    expect(isDirectLoginLanding('https://console.capgo.app/login/')).toBe(true)
  })

  it.concurrent('is false when another console page loaded first', () => {
    expect(isDirectLoginLanding('https://console.capgo.app/invitation?invite_magic_string=x')).toBe(false)
    expect(isDirectLoginLanding('https://console.capgo.app/dashboard')).toBe(false)
    expect(isDirectLoginLanding('https://console.capgo.app/')).toBe(false)
  })

  it.concurrent('is true when the first URL is missing or invalid', () => {
    expect(isDirectLoginLanding(undefined)).toBe(true)
    expect(isDirectLoginLanding(null)).toBe(true)
    expect(isDirectLoginLanding('')).toBe(true)
    expect(isDirectLoginLanding('not-a-url')).toBe(true)
  })
})
