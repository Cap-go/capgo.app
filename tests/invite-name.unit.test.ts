import { describe, expect, it } from 'vitest'
import { containsDomainName } from '../supabase/functions/shared/invite-name.ts'

describe('containsDomainName', () => {
  it.concurrent.each([
    'evil.com',
    'www.evil.com',
    'https://evil.com/path',
    'evil.com:443',
    'Support evil.com',
    '例子.测试',
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
