import { FunctionsHttpError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { getCapgoApiErrorCode } from '../src/services/capgoApi'

describe('getCapgoApiErrorCode', () => {
  it('returns 23505 from organization duplicate moreInfo messages', async () => {
    const response = new Response(JSON.stringify({
      error: 'cannot_create_org',
      message: 'Cannot create org',
      moreInfo: {
        error: 'duplicate key value violates unique constraint "orgs_name_key"',
      },
    }), { status: 400 })

    await expect(getCapgoApiErrorCode(new FunctionsHttpError(response))).resolves.toBe('23505')
  })

  it('returns top-level error codes when moreInfo is not a unique violation', async () => {
    const response = new Response(JSON.stringify({
      error: 'cannot_create_org',
      message: 'Cannot create org',
      moreInfo: { error: 'missing_org_super_admin_role' },
    }), { status: 400 })

    await expect(getCapgoApiErrorCode(new FunctionsHttpError(response))).resolves.toBe('cannot_create_org')
  })
})
