import { describe, expect, it } from 'vitest'
import {
  drizzleErrorFingerprintSegment,
  formatPgErrorCause,
  isTransientPgError,
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

  it('extracts table names for drizzle error fingerprints', () => {
    const error = Object.assign(new Error(`Failed query:
      SELECT app_id, push_update_enabled
      FROM public.notification_app_settings
      WHERE app_id = $1
    `), {
      name: 'DrizzleQueryError',
    })

    expect(drizzleErrorFingerprintSegment(error)).toBe('notification_app_settings')
  })

  it('extracts quoted drizzle table names for fingerprints', () => {
    const error = Object.assign(new Error('Failed query: select "id" from "manifest" where "manifest"."app_version_id" = $1'), {
      name: 'DrizzleQueryError',
    })

    expect(drizzleErrorFingerprintSegment(error)).toBe('manifest')
  })

  it('formats postgres causes for observability', () => {
    const error = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('relation "notification_app_settings" does not exist'), {
        code: '42P01',
      }),
    })

    expect(formatPgErrorCause(error)).toBe('42P01: relation "notification_app_settings" does not exist')
  })
})
