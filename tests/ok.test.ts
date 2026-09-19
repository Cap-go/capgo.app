import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from 'node:process'
import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_API_URL, getSupabaseClient } from './test-utils.ts'

describe('supabase Client Tests', () => {
  it('client creation and database query', async () => {
    const client: SupabaseClient = getSupabaseClient()

    // Test a simple query to the database
    const { data: table_data, error: table_error } = await client
      .from('users')
      .select('*')
      .limit(1)

    if (table_error)
      throw new Error(`Invalid Supabase client: ${table_error.message}`)

    expect(table_data).toBeTruthy()
  })
})

describe('[GET] /ok Function Test', () => {
  it('function invocation', async () => {
    const client: SupabaseClient = getSupabaseClient()

    // In Cloudflare Workers test mode, Supabase Edge Functions are not running.
    // Validate the Cloudflare API worker /ok endpoint instead.
    if (env.USE_CLOUDFLARE_WORKERS === 'true') {
      const response = await fetch(`${CLOUDFLARE_API_URL}/ok`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })

      const healthResponse = await fetch(`${CLOUDFLARE_API_URL}/health`)
      expect(healthResponse.status).toBeGreaterThanOrEqual(200)
      expect(healthResponse.status).toBeLessThan(600)
      const healthBody = await healthResponse.json() as { status: string, checks?: Array<{ name: string }> }
      expect(healthBody.status).toMatch(/^(ok|degraded|unhealthy)$/)
      expect(healthBody.checks?.some(check => check.name === 'database')).toBe(true)
      return
    }

    // Supabase Edge Functions mode
    const { data: func_data, error: func_error } = await client.functions.invoke('ok', {
      body: { name: 'bar' },
    })

    if (func_error)
      throw new Error(`Invalid response: ${func_error.message}`)

    expect(func_data.status).toBe('ok')
  })
})
