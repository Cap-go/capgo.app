import { describe, expect, it } from 'vitest'
import * as pluginPgErrors from '../supabase/functions/_backend/plugin_runtime/utils/pg_errors.ts'
import {
  drizzleErrorFingerprintSegment,
  isDatabaseOriginError,
  isReadOnlyPgConnectionRetryError,
  isTransientDatabaseError,
  isTransientPgError,
  readPgErrorCauseMessage,
  readPgErrorCode,
} from '../supabase/functions/_backend/utils/pg_errors.ts'

function drizzleError(causeMessage: string, code?: string, query = 'Failed query: SELECT 1') {
  const cause = code ? Object.assign(new Error(causeMessage), { code }) : new Error(causeMessage)
  return Object.assign(new Error(query), { name: 'DrizzleQueryError', cause })
}

function connectError(target: string, port?: number) {
  return Object.assign(new Error(`connect ECONNREFUSED ${target}`), {
    code: 'ECONNREFUSED',
    ...(port === undefined ? {} : { port, syscall: 'connect' }),
  })
}

describe('pg_errors', () => {
  it('treats hyperdrive not-queryable drizzle failures as read-only retry only (not shared transient)', () => {
    const error = drizzleError('Client has encountered a connection error and is not queryable', undefined, 'Failed query: select "file_name" from "manifest" where "manifest"."app_version_id" = $1')

    expect(isTransientPgError(error)).toBe(false)
    expect(isTransientDatabaseError(error)).toBe(false)
    expect(isReadOnlyPgConnectionRetryError(error)).toBe(true)
    expect(readPgErrorCauseMessage(error)).toBe('Client has encountered a connection error and is not queryable')
  })

  it('redacts quoted literals from postgres cause messages and reads codes without leaking values', () => {
    expect(readPgErrorCauseMessage(drizzleError('invalid input syntax for type uuid: "046a0000-0000-0000-0000-000000000000"', '22P02'))).toBe('invalid input syntax for type uuid: "?"')
    expect(readPgErrorCode(drizzleError('invalid input syntax for type uuid: "046a...-missing"', '22P02'))).toBe('22P02')
  })

  it.each([
    ['drizzle connection termination', drizzleError('Connection terminated unexpectedly', '57P01'), true],
    ['replica recovery conflict', drizzleError('canceling statement due to conflict with recovery', '40001', 'Failed query: select "file_name" from "manifest"'), true],
    ['pool slot timeout', Object.assign(new Error('Timed out while waiting for an open slot in the pool.'), { name: 'DrizzleQueryError' }), true],
    ['invalid UUID cast', drizzleError('invalid input syntax for type uuid', '22P02'), false],
    ['protocol violation', Object.assign(new Error('protocol error'), { code: '08P01' }), false],
  ])('isTransientPgError: %s -> %s', (_name, error, expected) => {
    expect(isTransientPgError(error)).toBe(expected)
  })

  it.each([
    ['unquoted multi-line query', `Failed query:
      SELECT app_id, push_update_enabled
      FROM public.notification_app_settings
      WHERE app_id = $1
    `, 'relation "notification_app_settings" does not exist', '42P01', 'notification_app_settings:pg:42P01'],
    ['quoted table', 'Failed query: select "id" from "manifest" where "manifest"."app_version_id" = $1', 'timeout', '57014', 'manifest:pg:57014'],
    ['quoted schema-qualified table', 'Failed query: select "id" from "public"."manifest" where "manifest"."app_version_id" = $1', 'timeout', '57014', 'manifest:pg:57014'],
  ])('extracts drizzle fingerprint from %s', (_name, query, causeMessage, code, expected) => {
    expect(drizzleErrorFingerprintSegment(drizzleError(causeMessage, code, query))).toBe(expected)
  })

  it('requires database origin before treating transient node errors as database outages', () => {
    const stripeError = Object.assign(new Error('fetch failed'), {
      code: 'ECONNREFUSED',
      cause: Object.assign(new Error('connect ECONNREFUSED api.stripe.com:443'), { code: 'ECONNREFUSED' }),
    })

    expect(isTransientPgError(stripeError)).toBe(true)
    expect(isDatabaseOriginError(stripeError)).toBe(false)
    expect(isTransientDatabaseError(stripeError)).toBe(false)
  })

  it.each([
    ['postgres 5432', connectError('127.0.0.1:5432', 5432)],
    ['pooler on 6543', connectError('db.pooler.example.com:6543', 6543)],
    ['local supabase on 54322', connectError('127.0.0.1:54322', 54322)],
    ['message-only standard port', connectError('127.0.0.1:5432')],
  ])('treats %s connection failures as database-origin transient errors', (_name, error) => {
    expect(isDatabaseOriginError(error)).toBe(true)
    expect(isTransientDatabaseError(error)).toBe(true)
  })

  it.each([
    ['redis', connectError('cache.example.com:6379', 6379), false],
    ['mongo', connectError('mongo.example.com:27017', 27017), false],
    ['supabase API hostname', connectError('xyzabcdef.supabase.co:443', 443), false],
    ['supabase db hostname', connectError('db.xyzabcdef.supabase.co:5432', 5432), true],
  ])('isDatabaseOriginError: %s connection failure -> %s', (_name, error, expected) => {
    expect(isDatabaseOriginError(error)).toBe(expected)
  })

  it('does not treat unrelated five-character codes as postgres SQLSTATE', () => {
    const fetchError = Object.assign(new Error('upstream unavailable'), { code: 'FETCH' })

    expect(isDatabaseOriginError(fetchError)).toBe(false)
    expect(isTransientDatabaseError(fetchError)).toBe(false)
  })

  it('allows read-only retry only for connection-class drizzle failures', () => {
    const statementTimeout = drizzleError('canceling statement due to statement timeout', '57014')
    const hyperdriveWait = drizzleError('timed out while waiting for a message from the origin database')
    const econnreset = Object.assign(new Error('read ECONNRESET'), { name: 'DrizzleQueryError', code: 'ECONNRESET' })

    expect(isReadOnlyPgConnectionRetryError(drizzleError('Connection terminated unexpectedly', '57P01'))).toBe(true)
    expect(isReadOnlyPgConnectionRetryError(econnreset)).toBe(true)
    expect(isReadOnlyPgConnectionRetryError(statementTimeout)).toBe(false)
    expect(isReadOnlyPgConnectionRetryError(hyperdriveWait)).toBe(false)
    expect(isTransientDatabaseError(statementTimeout)).toBe(true)
    expect(isTransientDatabaseError(hyperdriveWait)).toBe(true)
  })

  it('treats hyperdrive connect timeouts as transient and read-only retryable in both copies', () => {
    const connectTimeout = Object.assign(new Error('Failed query: select "channel_id" from "channel_devices" where "channel_devices"."device_id" = $1'), {
      name: 'DrizzleQueryError',
      cause: new Error('Timed out while creating a new server connection.'),
    })

    for (const errors of [{ isReadOnlyPgConnectionRetryError, isTransientDatabaseError }, pluginPgErrors]) {
      expect(errors.isTransientDatabaseError(connectTimeout)).toBe(true)
      expect(errors.isReadOnlyPgConnectionRetryError(connectTimeout)).toBe(true)
    }
  })

  it('classifies bare hyperdrive connect failures as database-origin read-only retries', () => {
    const bareConnect = new Error('Client has encountered a connection error and is not queryable')

    expect(isDatabaseOriginError(bareConnect)).toBe(true)
    expect(isReadOnlyPgConnectionRetryError(bareConnect)).toBe(true)
    expect(isTransientDatabaseError(bareConnect)).toBe(false)
  })
})
