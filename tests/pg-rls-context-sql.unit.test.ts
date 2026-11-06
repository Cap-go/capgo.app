import { describe, expect, it } from 'vitest'
import { quotePgLiteral, rlsContextSql } from '../supabase/functions/_backend/utils/pg_rls.ts'

describe('quotePgLiteral', () => {
  it('doubles quotes and backslashes and adds E when a backslash is present', () => {
    expect(quotePgLiteral('plain')).toBe('\'plain\'')
    expect(quotePgLiteral('it\'s')).toBe('\'it\'\'s\'')
    expect(quotePgLiteral('a\\b')).toBe(' E\'a\\\\b\'')
    expect(quotePgLiteral('\'); DROP TABLE apps; --')).toBe('\'\'\'); DROP TABLE apps; --\'')
  })

  it('rejects NUL', () => {
    expect(() => quotePgLiteral('a\0b')).toThrow('NUL')
  })
})

describe('rlsContextSql', () => {
  it('sets the API key header and anon role', () => {
    const sql = rlsContextSql({ kind: 'apikey', apikey: 'k\'"\\x' })
    expect(sql).toContain('set_config(\'request.headers\',  E\'{"capgkey":"k\'\'\\\\"\\\\\\\\x"}\', true)')
    expect(sql).toContain('set_config(\'role\', \'anon\', true)')
  })

  it('keeps the connection role for the service principal', () => {
    const sql = rlsContextSql({ kind: 'service' })
    expect(sql).not.toContain('set_config(\'role\'')
    expect(sql).toContain('\'{"role":"service_role"}\'')
  })

  it('sets authenticated claims for a JWT principal', () => {
    const sql = rlsContextSql({ kind: 'jwt', userId: 'u1', claims: { sub: 'other', role: 'service_role', email: 'x' } as any })
    expect(sql).toContain('\'{"sub":"u1","role":"authenticated","email":"x"}\'')
    expect(sql).toContain('set_config(\'request.jwt.claim.sub\', \'u1\', true)')
    expect(sql).toContain('set_config(\'role\', \'authenticated\', true)')
  })
})
