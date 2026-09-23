import { describe, expect, it } from 'vitest'
import { containsDomainName } from '../supabase/functions/shared/invite-name.ts'

describe('containsDomainName', () => {
  it.concurrent.each([
    'evil.com',
    'www.evil.com',
    'https://evil.com/path',
    'evil.com:443',
    'evil.com:65536',
    'Support evil.com',
    'John(evil.com)',
    '例子.测试',
    'evil。com',
    'evil．com',
    'evil｡com',
    'xn--fsqu00a.xn--0zwm56d',
  ])('detects domain names in %s', (name) => {
    expect(containsDomainName(name)).toBe(true)
  })

  it.concurrent.each([
    'Élodie',
    'Łukasz Kowalski',
    'О’Коннор',
    'محمد العلي',
    '李 小龙',
    'Jean-Luc',
    'Dr. Martin',
    'J.R.R. Tolkien',
  ])('allows human names in %s', (name) => {
    expect(containsDomainName(name)).toBe(false)
  })
})
