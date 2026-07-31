import type { ReadReplicaSchemaSyncPlan } from '../read_replicate/schema_additive_sync.ts'
import { describe, expect, it } from 'vitest'
import { preflightCompatibilityIssues } from '../scripts/sync-read-replica-schema.ts'

function catalogs() {
  const expected = {
    version: 1,
    tables: [
      { name: 'org_users', kind: 'r', reloptions: [] },
      { name: 'orgs', kind: 'r', reloptions: [] },
    ],
    columns: [
      {
        table: 'org_users',
        name: 'id',
        position: 1,
        type: 'bigint',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'org_users',
        name: 'user_id',
        position: 2,
        type: 'uuid',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'org_users',
        name: 'is_invite',
        position: 3,
        type: 'boolean',
        notNull: true,
        default: 'false',
        identity: '',
        generated: '',
      },
      {
        table: 'orgs',
        name: 'id',
        position: 1,
        type: 'uuid',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
    ],
    constraints: [],
    indexes: [],
    types: [],
    sequences: [],
    functions: [],
  }
  const actual = {
    version: 1,
    tables: [
      { name: 'org_users', kind: 'r', reloptions: [] },
      { name: 'orgs', kind: 'r', reloptions: [] },
    ],
    columns: [
      {
        table: 'org_users',
        name: 'id',
        position: 1,
        type: 'bigint',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'org_users',
        name: 'user_id',
        position: 2,
        type: 'uuid',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'org_users',
        name: 'user_right',
        position: 3,
        type: 'user_min_right',
        notNull: false,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'orgs',
        name: 'id',
        position: 1,
        type: 'uuid',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'orgs',
        name: 'use_new_rbac',
        position: 2,
        type: 'boolean',
        notNull: true,
        default: 'true',
        identity: '',
        generated: '',
      },
    ],
    constraints: [],
    indexes: [],
    types: [{ name: 'user_min_right', kind: 'e', definition: ['read'] }],
    sequences: [],
    functions: [],
  }

  return { actual, expected }
}

const plannedIsInvite: ReadReplicaSchemaSyncPlan = {
  statements: [
    {
      kind: 'column',
      table: 'org_users',
      name: 'is_invite',
      sql: 'ALTER TABLE public."org_users" ADD COLUMN IF NOT EXISTS "is_invite" boolean DEFAULT false NOT NULL',
    },
  ],
  skipped: [],
}

describe('read-replica pre-primary schema preflight', () => {
  it.concurrent(
    'accepts a planned additive column while retaining safe legacy subscriber remnants',
    () => {
      const { actual, expected } = catalogs()

      expect(
        preflightCompatibilityIssues(expected, actual, plannedIsInvite),
      ).toEqual([])
    },
  )

  it.concurrent(
    'keeps an unplanned incompatible subscriber column as a release blocker',
    () => {
      const { actual, expected } = catalogs()
      actual.columns[1] = { ...actual.columns[1], type: 'text' }

      expect(
        preflightCompatibilityIssues(expected, actual, plannedIsInvite),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'column',
            object: 'org_users.user_id',
            reason: 'expected type uuid, found text',
          }),
        ]),
      )
    },
  )
})
