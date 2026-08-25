import { describe, expect, it } from 'vitest'
import {
  drizzleErrorFingerprintSegment,
  isDatabaseOriginError,
  isTransientDatabaseError,
  isTransientPgError,
  readPgErrorCode,
} from '../supabase/functions/_backend/utils/pg_errors.ts'

describe('pg_errors', () => {
  it('detects transient connection failures in drizzle cause chains', () => {
    const error = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('Connection terminated unexpectedly'), {
        code: '57P01',
      }),
    })

    expect(isTransientPgError(error)).toBe(true)
  })

  it('does not treat invalid UUID casts as transient', () => {
    const error = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('invalid input syntax for type uuid'), {
        code: '22P02',
      }),
    })

    expect(isTransientPgError(error)).toBe(false)
  })

  it('does not treat protocol violations as transient', () => {
    const error = Object.assign(new Error('protocol error'), {
      code: '08P01',
    })

    expect(isTransientPgError(error)).toBe(false)
  })

  it('extracts table names and postgres codes for drizzle error fingerprints', () => {
    const error = Object.assign(new Error(`Failed query:
      SELECT app_id, push_update_enabled
      FROM public.notification_app_settings
      WHERE app_id = $1
    `), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('relation "notification_app_settings" does not exist'), {
        code: '42P01',
      }),
    })

    expect(drizzleErrorFingerprintSegment(error)).toBe('notification_app_settings:pg:42P01')
  })

  it('extracts quoted drizzle table names for fingerprints', () => {
    const error = Object.assign(new Error('Failed query: select "id" from "manifest" where "manifest"."app_version_id" = $1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('timeout'), {
        code: '57014',
      }),
    })

    expect(drizzleErrorFingerprintSegment(error)).toBe('manifest:pg:57014')
  })

  it('extracts table names from quoted schema-qualified drizzle queries', () => {
    const error = Object.assign(new Error('Failed query: select "id" from "public"."manifest" where "manifest"."app_version_id" = $1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('timeout'), {
        code: '57014',
      }),
    })

    expect(drizzleErrorFingerprintSegment(error)).toBe('manifest:pg:57014')
  })

  it('reads postgres error codes without leaking user-supplied values', () => {
    const error = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('invalid input syntax for type uuid: "046a...-missing"'), {
        code: '22P02',
      }),
    })

    expect(readPgErrorCode(error)).toBe('22P02')
  })

  it('requires database origin before treating transient node errors as database outages', () => {
    const stripeError = Object.assign(new Error('fetch failed'), {
      code: 'ECONNREFUSED',
      cause: Object.assign(new Error('connect ECONNREFUSED api.stripe.com:443'), {
        code: 'ECONNREFUSED',
      }),
    })

    expect(isTransientPgError(stripeError)).toBe(true)
    expect(isDatabaseOriginError(stripeError)).toBe(false)
    expect(isTransientDatabaseError(stripeError)).toBe(false)
  })

  it('treats postgres connection failures as database-origin transient errors', () => {
    const pgError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      port: 5432,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(pgError)).toBe(true)
    expect(isTransientDatabaseError(pgError)).toBe(true)
  })

  it('treats pooler postgres connection failures on non-5432 ports as database-origin', () => {
    const pgError = Object.assign(new Error('connect ECONNREFUSED db.pooler.example.com:6543'), {
      code: 'ECONNREFUSED',
      port: 6543,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(pgError)).toBe(true)
    expect(isTransientDatabaseError(pgError)).toBe(true)
  })

  it('treats local supabase postgres connection failures on port 54322 as database-origin', () => {
    const pgError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:54322'), {
      code: 'ECONNREFUSED',
      port: 54322,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(pgError)).toBe(true)
    expect(isTransientDatabaseError(pgError)).toBe(true)
  })

  it('detects message-only postgres connection failures on standard ports', () => {
    const pgError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })

    expect(isDatabaseOriginError(pgError)).toBe(true)
    expect(isTransientDatabaseError(pgError)).toBe(true)
  })

  it('does not treat redis or mongo connection failures as database-origin', () => {
    const redisError = Object.assign(new Error('connect ECONNREFUSED cache.example.com:6379'), {
      code: 'ECONNREFUSED',
      port: 6379,
      syscall: 'connect',
    })
    const mongoError = Object.assign(new Error('connect ECONNREFUSED mongo.example.com:27017'), {
      code: 'ECONNREFUSED',
      port: 27017,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(redisError)).toBe(false)
    expect(isDatabaseOriginError(mongoError)).toBe(false)
  })

  it('does not treat supabase API hostnames as postgres connection failures', () => {
    const authError = Object.assign(new Error('connect ECONNREFUSED xyzabcdef.supabase.co:443'), {
      code: 'ECONNREFUSED',
      port: 443,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(authError)).toBe(false)
  })

  it('treats supabase db hostnames as postgres connection failures', () => {
    const dbError = Object.assign(new Error('connect ECONNREFUSED db.xyzabcdef.supabase.co:5432'), {
      code: 'ECONNREFUSED',
      port: 5432,
      syscall: 'connect',
    })

    expect(isDatabaseOriginError(dbError)).toBe(true)
  })

  it('does not treat unrelated five-character codes as postgres SQLSTATE', () => {
    const fetchError = Object.assign(new Error('upstream unavailable'), {
      code: 'FETCH',
    })

    expect(isDatabaseOriginError(fetchError)).toBe(false)
    expect(isTransientDatabaseError(fetchError)).toBe(false)
  })
})
