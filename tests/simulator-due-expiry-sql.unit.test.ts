import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIMULATOR_SESSIONS_DUE_FOR_EXPIRY_SQL } from '../supabase/functions/_backend/public/build/concurrency.ts'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const idleDueId = '99000000-0000-4000-8000-000000000010'
const idleSkippedId = '99000000-0000-4000-8000-000000000011'
const activeId = '99000000-0000-4000-8000-000000000012'
const maxDueSkippedId = '99000000-0000-4000-8000-000000000013'

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE public.simulator_sessions (
      id uuid PRIMARY KEY,
      owner_org uuid NOT NULL,
      status text NOT NULL,
      emulator_id text,
      device_stopped_at timestamptz,
      started_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz,
      max_duration_minutes integer NOT NULL DEFAULT 40
    );
  `)
  await db.exec(`
    INSERT INTO public.simulator_sessions (
      id, owner_org, status, emulator_id, device_stopped_at, started_at, last_activity_at, max_duration_minutes
    ) VALUES
      ('${idleDueId}', '${orgId}', 'in-progress', 'emu-due', NULL, now() - interval '20 minutes', now() - interval '6 minutes', 40),
      ('${idleSkippedId}', '${orgId}', 'in-progress', 'emu-skip', NULL, now() - interval '20 minutes', now() - interval '6 minutes', 40),
      ('${activeId}', '${orgId}', 'in-progress', 'emu-live', NULL, now() - interval '20 minutes', now() - interval '2 minutes', 40),
      ('${maxDueSkippedId}', '${orgId}', 'in-progress', 'emu-max', NULL, now() - interval '41 minutes', now() - interval '41 minutes', 40);
  `)
}, 30000)

afterAll(async () => {
  await db.close()
})

async function queryDueIds(skipIds: string[]): Promise<string[]> {
  await db.exec('BEGIN')
  try {
    const { rows } = await db.query<{ id: string }>(
      SIMULATOR_SESSIONS_DUE_FOR_EXPIRY_SQL,
      [orgId, skipIds],
    )
    return rows.map(row => row.id).sort()
  }
  finally {
    await db.exec('ROLLBACK')
  }
}

describe('simulator due-for-expiry device stop SQL', () => {
  it('returns idle-not-skipped and max-due rows when skip list is set', async () => {
    const skipIds = [idleSkippedId, maxDueSkippedId]
    await expect(queryDueIds(skipIds)).resolves.toEqual([idleDueId, maxDueSkippedId].sort())
  })

  it('returns every idle due row when skip list is empty', async () => {
    await expect(queryDueIds([])).resolves.toEqual(
      [idleDueId, idleSkippedId, maxDueSkippedId].sort(),
    )
  })
})
