import { escapeLiteral } from 'pg'
import { describe, expect, it } from 'vitest'
import { catalogFromPayload, consoleRoleSetupSql } from '../supabase/functions/_backend/private/console_query_run.ts'
import { transactionBeginSql, withPgTransaction } from '../supabase/functions/_backend/utils/pg.ts'

const userId = '11111111-1111-4111-8111-111111111111'

describe('console role setup', () => {
  it('sends the caller role in the same statement as BEGIN', () => {
    const setup = consoleRoleSetupSql({
      role: 'authenticated',
      claims: { sub: userId, email: "o'reilly@example.com", role: 'authenticated' },
    })
    const begin = transactionBeginSql('read write', setup)
    expect(begin.startsWith('BEGIN READ WRITE; SET LOCAL statement_timeout = 10000;')).toBe(true)
    expect(begin).toContain('SET LOCAL idle_in_transaction_session_timeout = 15000;')
    expect(begin).toContain(escapeLiteral("o'reilly@example.com"))
    expect(begin.split('\n').filter(line => line.startsWith('SET LOCAL ROLE'))).toEqual(['SET LOCAL ROLE authenticated;'])
    expect(begin.match(/BEGIN/g)).toEqual(['BEGIN'])
    expect(begin).not.toContain('SET SESSION')
  })

  it('keeps a quote inside the claim literal', () => {
    const evil = "x'; SET LOCAL ROLE postgres; --"
    const setup = consoleRoleSetupSql({
      role: 'authenticated',
      claims: { sub: userId, email: evil, role: 'authenticated' },
    })
    expect(setup).toContain(escapeLiteral(evil))
    expect(setup.split('\n').filter(line => line.startsWith('SET LOCAL ROLE'))).toEqual(['SET LOCAL ROLE authenticated;'])
  })

  it('uses the anon role for the pre-login probe', () => {
    const setup = consoleRoleSetupSql({ role: 'anon' })
    expect(setup.split('\n').filter(line => line.startsWith('SET LOCAL ROLE'))).toEqual(['SET LOCAL ROLE anon;'])
    expect(transactionBeginSql('read write')).toBe('BEGIN READ WRITE; SET LOCAL statement_timeout = 10000; SET LOCAL idle_in_transaction_session_timeout = 15000')
  })

  it('rolls back when the role setup on BEGIN fails', async () => {
    const statements: string[] = []
    const client = {
      async query(text: string) {
        statements.push(text)
        if (text.includes('SET LOCAL ROLE'))
          throw new Error('permission denied to set role')
      },
      release() {
        statements.push('release')
      },
    }
    const pool = { connect: async () => client }
    await expect(withPgTransaction(pool as never, async () => 'ran', {
      appendSql: 'SET LOCAL ROLE authenticated',
    })).rejects.toThrow('permission denied to set role')
    expect(statements.some(statement => statement.startsWith('BEGIN'))).toBe(true)
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.at(-1)).toBe('release')
  })
})

describe('console catalog payload', () => {
  it('reads columns and functions from one payload', () => {
    const catalog = catalogFromPayload({
      columns: [{ table_name: 'orgs', column_name: 'id', udt: 'uuid' }],
      foreign_keys: [{
        name: 'orgs_created_by_fkey',
        sourceTable: 'orgs',
        sourceColumn: 'created_by',
        targetTable: 'users',
        targetColumn: 'id',
        unique: true,
      }],
      functions: [{
        name: 'is_not_deleted',
        returns_set: false,
        arg_count: 1,
        arg_names: ['email_check'],
        arg_modes: null,
        return_kind: 'b',
        arg_types: ['varchar'],
        default_count: 0,
      }],
    })
    expect(catalog.columns.get('orgs')).toEqual([{ name: 'id', udt: 'uuid' }])
    expect(catalog.foreignKeys).toHaveLength(1)
    expect(catalog.functions[0]).toMatchObject({
      name: 'is_not_deleted',
      argNames: ['email_check'],
      argTypes: ['varchar'],
      returnsSet: false,
    })
  })
})
