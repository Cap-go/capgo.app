import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const deviceStoppedId = '99000000-0000-4000-8000-000000000020'

const expireEligibleSql = `
  SELECT id::text AS id
  FROM public.simulator_sessions
  WHERE owner_org = $1::uuid
    AND status IN ('new', 'queued', 'starting', 'in-progress')
    AND (
      device_stopped_at IS NOT NULL
      OR COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
      OR COALESCE(last_activity_at, started_at, created_at) <= now() - make_interval(mins => 5)
    )
`

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
      id, owner_org, status, device_stopped_at, started_at, last_activity_at, max_duration_minutes
    ) VALUES (
      '${deviceStoppedId}',
      '${orgId}',
      'in-progress',
      now() - interval '3 minutes',
      now() - interval '10 minutes',
      now() - interval '1 minute',
      40
    );
  `)
}, 30000)

afterAll(async () => {
  await db.close()
})

describe('simulator expire device stop eligibility', () => {
  it('settles on device_stopped_at even when idle activity is fresh', async () => {
    const { rows } = await db.query<{ id: string }>(expireEligibleSql, [orgId])
    expect(rows.map(row => row.id)).toEqual([deviceStoppedId])
  })

  it('would miss a device stopped session without the device_stopped_at clause', async () => {
    const withoutDeviceStop = `
      SELECT id::text AS id
      FROM public.simulator_sessions
      WHERE owner_org = $1::uuid
        AND status IN ('new', 'queued', 'starting', 'in-progress')
        AND (
          COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
          OR COALESCE(last_activity_at, started_at, created_at) <= now() - make_interval(mins => 5)
        )
    `
    const { rows } = await db.query<{ id: string }>(withoutDeviceStop, [orgId])
    expect(rows).toHaveLength(0)
  })
})