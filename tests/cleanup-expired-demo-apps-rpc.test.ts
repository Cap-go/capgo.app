import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

const pgPool = new Pool({ connectionString: POSTGRES_URL })

afterAll(async () => {
  await pgPool.end()
})

describe('cleanup_expired_demo_apps RPC authorization', () => {
  it.concurrent('keeps execute privilege only for service-role callers', async () => {
    const { rows } = await pgPool.query<{
      service_role_can_execute: boolean
      anon_can_execute: boolean
      authenticated_can_execute: boolean
      public_can_execute: boolean
    }>(`
      SELECT
        has_function_privilege('service_role', 'public.cleanup_expired_demo_apps()', 'EXECUTE') AS service_role_can_execute,
        has_function_privilege('anon', 'public.cleanup_expired_demo_apps()', 'EXECUTE') AS anon_can_execute,
        has_function_privilege('authenticated', 'public.cleanup_expired_demo_apps()', 'EXECUTE') AS authenticated_can_execute,
        has_function_privilege('public', 'public.cleanup_expired_demo_apps()', 'EXECUTE') AS public_can_execute
    `)

    expect(rows).toEqual([{
      service_role_can_execute: true,
      anon_can_execute: false,
      authenticated_can_execute: false,
      public_can_execute: false,
    }])
  })
})
