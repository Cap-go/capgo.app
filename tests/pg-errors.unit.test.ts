import { describe, expect, it } from 'vitest'
import {
  drizzleErrorFingerprintSegment,
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
})
