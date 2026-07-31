import type {
  ReadReplicaSchemaSyncClient,
  ReadReplicaSchemaSyncStatement,
} from '../read_replicate/schema_additive_sync.ts'
import { describe, expect, it } from 'vitest'
import {
  applyReadReplicaAdditiveSchemaSync,
  planReadReplicaSchemaSync,
  reconcileReadReplicaSchema,
} from '../read_replicate/schema_additive_sync.ts'
import { READ_REPLICA_SCHEMA_CATALOG_SQL } from '../read_replicate/schema_catalog.ts'

function catalogs() {
  const expected = {
    tables: [{ name: 'apps' }],
    columns: [
      {
        table: 'apps',
        name: 'id',
        type: 'uuid',
        notNull: true,
        default: null,
        identity: '',
        generated: '',
      },
      {
        table: 'apps',
        name: 'created_from_onboarding',
        type: 'boolean',
        notNull: true,
        default: 'false',
        identity: '',
        generated: '',
      },
    ],
    constraints: [],
    indexes: [
      {
        table: 'apps',
        name: 'idx_apps_id',
        definition: 'CREATE INDEX idx_apps_id ON public.apps USING btree (id)',
        valid: true,
        constraintOwned: false,
      },
    ],
  }
  const initial = {
    ...expected,
    columns: [expected.columns[0]],
    indexes: [] as typeof expected.indexes,
  }

  return { expected, initial }
}

describe('read-replica additive schema sync', () => {
  it.concurrent(
    'fails instead of reporting applied objects when the post-DDL catalog is stale',
    async () => {
      const { expected, initial } = catalogs()
      const statements: string[] = []
      let catalogReads = 0
      const client = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL) {
            catalogReads += 1
            return { rows: [{ catalog: initial }] }
          }

          statements.push(text)
          return { rows: [] }
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).rejects.toThrow(
        'did not persist column apps.created_from_onboarding, index apps.idx_apps_id',
      )
      expect(catalogReads).toBe(2)
      expect(statements).toEqual(
        expect.arrayContaining([
          'ALTER TABLE public."apps" ADD COLUMN IF NOT EXISTS "created_from_onboarding" boolean DEFAULT false NOT NULL',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_apps_id" ON public."apps" USING btree (id)',
        ]),
      )
    },
  )

  it.concurrent(
    'fails when a created index remains invalid after the catalog refresh',
    async () => {
      const { expected } = catalogs()
      const current = {
        ...expected,
        indexes: [] as typeof expected.indexes,
      }
      const client = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: current }] }

          if (text.startsWith('CREATE INDEX'))
            current.indexes.push({ ...expected.indexes[0], valid: false })
          return { rows: [] }
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).rejects.toThrow('did not persist index apps.idx_apps_id')
    },
  )

  it.concurrent(
    'returns applied only after the post-DDL catalog contains every statement',
    async () => {
      const { expected, initial } = catalogs()
      const current = structuredClone(initial)
      let catalogReads = 0
      const client = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL) {
            catalogReads += 1
            return { rows: [{ catalog: current }] }
          }

          if (text.startsWith('ALTER TABLE'))
            current.columns.push(expected.columns[1])
          if (text.startsWith('CREATE INDEX'))
            current.indexes.push(expected.indexes[0])
          return { rows: [] }
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).resolves.toEqual({
        applied: [
          { kind: 'column', table: 'apps', name: 'created_from_onboarding' },
          { kind: 'index', table: 'apps', name: 'idx_apps_id' },
        ],
        skipped: [],
      })
      expect(catalogReads).toBe(2)
    },
  )

  it.concurrent(
    'preflights and routes supported column additions through one direct transactional plan instead of raw DDL',
    async () => {
      const { expected, initial } = catalogs()
      const expectedColumnsOnly = { ...expected, indexes: [] }
      const current = structuredClone(initial)
      const directQueries: string[] = []
      const events: string[] = []
      const executed: ReadReplicaSchemaSyncStatement[][] = []
      const client: ReadReplicaSchemaSyncClient = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: current }] }

          directQueries.push(text)
          return { rows: [] }
        },
        assertCanApplyReadReplicaSchemaPlan(plan) {
          events.push('preflight')
          expect(plan.skipped).toEqual([])
          expect(plan.statements).toEqual([
            {
              kind: 'column',
              table: 'apps',
              name: 'created_from_onboarding',
              sql: 'ALTER TABLE public."apps" ADD COLUMN IF NOT EXISTS "created_from_onboarding" boolean DEFAULT false NOT NULL',
            },
          ])
        },
        async applyReadReplicaSchemaPlan(plan) {
          events.push('apply')
          executed.push(plan.statements)
          current.columns.push(expectedColumnsOnly.columns[1])
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expectedColumnsOnly),
      ).resolves.toEqual({
        applied: [{
          kind: 'column',
          table: 'apps',
          name: 'created_from_onboarding',
        }],
        skipped: [],
      })
      expect(events).toEqual(['preflight', 'apply'])
      expect(executed).toHaveLength(1)
      expect(directQueries).not.toContain(
        expect.stringContaining('ALTER TABLE'),
      )
    },
  )

  it.concurrent(
    'requires a whole-plan preflight before transactional schema execution',
    async () => {
      const { expected, initial } = catalogs()
      const expectedColumnsOnly = { ...expected, indexes: [] }
      const queryCalls: string[] = []
      const appliedPlans: ReadReplicaSchemaSyncStatement[][] = []
      const client: ReadReplicaSchemaSyncClient = {
        query: async (text: string) => {
          queryCalls.push(text)
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: initial }] }

          return { rows: [] }
        },
        async applyReadReplicaSchemaPlan(plan) {
          appliedPlans.push(plan.statements)
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expectedColumnsOnly),
      ).rejects.toThrow(
        'Transactional read-replica schema execution must preflight the whole reconciliation plan before applying schema changes',
      )
      expect(appliedPlans).toEqual([])
      expect(queryCalls).toEqual([READ_REPLICA_SCHEMA_CATALOG_SQL])
    },
  )

  it.concurrent(
    'does not invoke the server-side import when whole-plan preflight rejects unsupported DDL',
    async () => {
      const { expected, initial } = catalogs()
      const queryCalls: string[] = []
      let serverSideImportCalls = 0
      const client: ReadReplicaSchemaSyncClient = {
        query: async (text: string) => {
          queryCalls.push(text)
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: initial }] }

          return { rows: [] }
        },
        assertCanApplyReadReplicaSchemaPlan(plan) {
          const unsupported = plan.statements.find(
            statement => statement.kind !== 'column',
          )
          if (unsupported) {
            throw new Error(
              `direct plan cannot apply ${unsupported.kind} ${unsupported.table}.${unsupported.name}`,
            )
          }
        },
        async applyReadReplicaSchemaPlan() {
          serverSideImportCalls += 1
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).rejects.toThrow('direct plan cannot apply index apps.idx_apps_id')
      expect(serverSideImportCalls).toBe(0)
      expect(queryCalls).toEqual([READ_REPLICA_SCHEMA_CATALOG_SQL])
    },
  )

  it.concurrent(
    'rejects skipped reconciliation before applying supported schema changes',
    async () => {
      const { expected: baseExpected, initial } = catalogs()
      const expected = {
        ...baseExpected,
        indexes: [],
        columns: [
          ...baseExpected.columns,
          {
            table: 'apps',
            name: 'unsupported_generated',
            type: 'text',
            notNull: false,
            default: null,
            identity: '',
            generated: 's',
          },
        ],
      }
      const queryCalls: string[] = []
      const appliedPlans: ReadReplicaSchemaSyncStatement[][] = []
      const client: ReadReplicaSchemaSyncClient = {
        query: async (text: string) => {
          queryCalls.push(text)
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: initial }] }

          return { rows: [] }
        },
        assertCanApplyReadReplicaSchemaPlan(plan) {
          const skipped = plan.skipped[0]
          if (skipped) {
            throw new Error(
              `direct plan cannot reconcile skipped ${skipped.kind} ${skipped.table}.${skipped.name}`,
            )
          }
        },
        async applyReadReplicaSchemaPlan(plan) {
          appliedPlans.push(plan.statements)
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).rejects.toThrow(
        'direct plan cannot reconcile skipped column apps.unsupported_generated',
      )
      expect(appliedPlans).toEqual([])
      expect(queryCalls).toEqual([READ_REPLICA_SCHEMA_CATALOG_SQL])
    },
  )

  it.concurrent(
    'removes an unexpected ordinary index from a selected replica table',
    async () => {
      const { expected } = catalogs()
      const current = structuredClone(expected)
      current.indexes.push({
        table: 'apps',
        name: 'replica_only_idx',
        definition:
          'CREATE INDEX replica_only_idx ON public.apps USING btree (id)',
        valid: true,
        constraintOwned: false,
      })
      const statements: string[] = []
      const client = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: current }] }

          statements.push(text)
          if (text.startsWith('DROP INDEX')) {
            current.indexes = current.indexes.filter(
              index => index.name !== 'replica_only_idx',
            )
          }
          return { rows: [] }
        },
      }

      await expect(
        applyReadReplicaAdditiveSchemaSync(client, expected),
      ).resolves.toEqual({
        applied: [
          { kind: 'drop_index', table: 'apps', name: 'replica_only_idx' },
        ],
        skipped: [],
      })
      expect(statements).toContain(
        'DROP INDEX CONCURRENTLY IF EXISTS public."replica_only_idx"',
      )
    },
  )

  it.concurrent('never drops an index that backs a replica constraint', () => {
    const { expected } = catalogs()
    const actual = structuredClone(expected)
    actual.indexes.push({
      table: 'apps',
      name: 'replica_only_pkey',
      definition:
        'CREATE UNIQUE INDEX replica_only_pkey ON public.apps USING btree (id)',
      valid: true,
      constraintOwned: true,
    })

    expect(planReadReplicaSchemaSync(expected, actual)).toEqual({
      statements: [],
      skipped: [
        {
          kind: 'index',
          table: 'apps',
          name: 'replica_only_pkey',
          reason: 'constraint_owned_index',
        },
      ],
    })
  })

  it.concurrent(
    're-reads the live primary catalog after synchronizing the replica',
    async () => {
      const { expected, initial } = catalogs()
      const replicaCatalog = structuredClone(initial)
      let masterCatalogReads = 0
      const master = {
        query: async (text: string) => {
          expect(text).toBe(READ_REPLICA_SCHEMA_CATALOG_SQL)
          masterCatalogReads += 1
          return { rows: [{ catalog: expected }] }
        },
      }
      const replica = {
        query: async (text: string) => {
          if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
            return { rows: [{ catalog: replicaCatalog }] }

          if (text.startsWith('ALTER TABLE'))
            replicaCatalog.columns.push(expected.columns[1])
          if (text.startsWith('CREATE INDEX'))
            replicaCatalog.indexes.push(expected.indexes[0])
          return { rows: [] }
        },
      }

      await expect(
        reconcileReadReplicaSchema(master, replica),
      ).resolves.toEqual({
        applied: [
          { kind: 'column', table: 'apps', name: 'created_from_onboarding' },
          { kind: 'index', table: 'apps', name: 'idx_apps_id' },
        ],
        skipped: [],
        issues: [],
      })
      expect(masterCatalogReads).toBe(2)
    },
  )

  it.concurrent('reports constraint-owned residual drift after reconciling from the primary', async () => {
    const { expected } = catalogs()
    const replicaCatalog = structuredClone(expected)
    replicaCatalog.indexes.push({
      table: 'apps',
      name: 'replica_only_pkey',
      definition: 'CREATE UNIQUE INDEX replica_only_pkey ON public.apps USING btree (id)',
      valid: true,
      constraintOwned: true,
    })
    const master = {
      query: async () => ({ rows: [{ catalog: expected }] }),
    }
    const replica = {
      query: async (text: string) => {
        if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
          return { rows: [{ catalog: replicaCatalog }] }
        return { rows: [] }
      },
    }

    await expect(reconcileReadReplicaSchema(master, replica)).resolves.toMatchObject({
      applied: [],
      skipped: [{
        kind: 'index',
        table: 'apps',
        name: 'replica_only_pkey',
        reason: 'constraint_owned_index',
      }],
      issues: [{
        kind: 'index',
        object: 'replica_only_pkey',
        reason: 'unexpected index adds storage and write cost',
      }],
    })
  })

  it.concurrent('replaces an index with a different definition even when the old index is invalid', async () => {
    const { expected } = catalogs()
    const current = structuredClone(expected)
    current.indexes[0] = {
      ...current.indexes[0],
      definition: 'CREATE INDEX idx_apps_id ON public.apps USING btree (created_from_onboarding)',
      valid: false,
    }
    const statements: string[] = []
    const client = {
      query: async (text: string) => {
        if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
          return { rows: [{ catalog: current }] }

        statements.push(text)
        if (text.startsWith('DROP INDEX'))
          current.indexes = []
        if (text.startsWith('CREATE INDEX'))
          current.indexes.push(expected.indexes[0])
        return { rows: [] }
      },
    }

    await expect(
      applyReadReplicaAdditiveSchemaSync(client, expected),
    ).resolves.toEqual({
      applied: [
        { kind: 'drop_index', table: 'apps', name: 'idx_apps_id' },
        { kind: 'index', table: 'apps', name: 'idx_apps_id' },
      ],
      skipped: [],
    })
    expect(statements).toEqual(expect.arrayContaining([
      'DROP INDEX CONCURRENTLY IF EXISTS public."idx_apps_id"',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_apps_id" ON public."apps" USING btree (id)',
    ]))
  })

  it.concurrent('converges a missing key constraint by building and attaching its selected index', async () => {
    const expected = {
      tables: [{ name: 'orgs' }],
      columns: [],
      constraints: [{
        table: 'orgs',
        name: 'unique customer_id on orgs',
        type: 'u' as const,
        definition: 'UNIQUE (customer_id)',
      }],
      indexes: [{
        table: 'orgs',
        name: 'unique customer_id on orgs',
        definition: 'CREATE UNIQUE INDEX "unique customer_id on orgs" ON public.orgs USING btree (customer_id)',
        valid: true,
        constraintOwned: true,
      }],
    }
    const current = structuredClone(expected)
    current.constraints = []
    current.indexes = []
    const statements: string[] = []
    const client = {
      query: async (text: string) => {
        if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
          return { rows: [{ catalog: current }] }

        statements.push(text)
        if (text.startsWith('CREATE UNIQUE INDEX')) {
          current.indexes.push({
            ...expected.indexes[0],
            constraintOwned: false,
          })
        }
        if (text.startsWith('ALTER TABLE') && text.includes('ADD CONSTRAINT')) {
          current.constraints.push(expected.constraints[0])
          current.indexes[0].constraintOwned = true
        }
        return { rows: [] }
      },
    }

    await expect(
      applyReadReplicaAdditiveSchemaSync(client, expected),
    ).resolves.toEqual({
      applied: [
        { kind: 'index', table: 'orgs', name: 'unique customer_id on orgs' },
        { kind: 'constraint', table: 'orgs', name: 'unique customer_id on orgs' },
      ],
      skipped: [],
    })
    expect(statements).toEqual(expect.arrayContaining([
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unique customer_id on orgs" ON public."orgs" USING btree (customer_id)',
      'ALTER TABLE public."orgs" ADD CONSTRAINT "unique customer_id on orgs" UNIQUE USING INDEX "unique customer_id on orgs"',
    ]))
  })

  it.concurrent('does not add a missing selected CHECK constraint', () => {
    const expected = {
      tables: [{ name: 'apps' }],
      columns: [],
      constraints: [{
        table: 'apps',
        name: 'apps_id_check',
        type: 'c' as const,
        definition: 'CHECK (id IS NOT NULL)',
        valid: true,
      }],
      indexes: [],
    }
    const current = structuredClone(expected)
    current.constraints = []

    expect(planReadReplicaSchemaSync(expected, current)).toEqual({
      statements: [],
      skipped: [],
    })
  })

  it.concurrent('replaces the selected helper function from the primary catalog', async () => {
    const expected = {
      tables: [{ name: 'apps' }],
      columns: [],
      constraints: [],
      indexes: [],
      functions: [{
        name: 'one_month_ahead',
        arguments: '',
        definition: 'CREATE OR REPLACE FUNCTION public.one_month_ahead() RETURNS timestamp without time zone LANGUAGE sql AS $$ SELECT NOW() + INTERVAL \'1 month\' $$;',
      }],
    }
    const current = structuredClone(expected)
    current.functions[0].definition = 'CREATE OR REPLACE FUNCTION public.one_month_ahead() RETURNS timestamp without time zone LANGUAGE sql AS $$ SELECT NOW() $$;'
    const client = {
      query: async (text: string) => {
        if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
          return { rows: [{ catalog: current }] }

        if (text.startsWith('CREATE OR REPLACE FUNCTION'))
          current.functions[0] = expected.functions[0]
        return { rows: [] }
      },
    }

    await expect(
      applyReadReplicaAdditiveSchemaSync(client, expected),
    ).resolves.toEqual({
      applied: [{ kind: 'function', table: 'public', name: 'one_month_ahead()' }],
      skipped: [],
    })
  })

  it.concurrent('aligns selected sequence options without resetting its runtime value', async () => {
    const expected = {
      tables: [{ name: 'apps' }],
      columns: [],
      constraints: [],
      indexes: [],
      sequences: [{
        name: 'apps_id_seq',
        type: 'bigint',
        start: '1',
        increment: '1',
        min: '1',
        max: '9223372036854775807',
        cache: '1',
        cycle: false,
        ownedTable: null,
        ownedColumn: null,
      }],
    }
    const current = structuredClone(expected)
    current.sequences[0].increment = '2'
    const statements: string[] = []
    const client = {
      query: async (text: string) => {
        if (text === READ_REPLICA_SCHEMA_CATALOG_SQL)
          return { rows: [{ catalog: current }] }

        statements.push(text)
        if (text.startsWith('ALTER SEQUENCE'))
          current.sequences[0] = expected.sequences[0]
        return { rows: [] }
      },
    }

    await expect(
      applyReadReplicaAdditiveSchemaSync(client, expected),
    ).resolves.toEqual({
      applied: [{ kind: 'sequence', table: 'public', name: 'apps_id_seq' }],
      skipped: [],
    })
    expect(statements).toContain(
      'ALTER SEQUENCE public."apps_id_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE OWNED BY NONE',
    )
    expect(statements.join('\n')).not.toContain('RESTART')
  })

  it.concurrent('escapes enum labels and rejects NUL labels', () => {
    const actual = { types: [] }

    expect(planReadReplicaSchemaSync({
      types: [{
        name: 'replica_enum',
        kind: 'e',
        definition: ['safe', String.raw`slash\and'quote`],
      }],
    }, actual)).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'replica_enum',
        sql: String.raw`CREATE TYPE public."replica_enum" AS ENUM (E'safe', E'slash\\and''quote')`,
      }],
      skipped: [],
    })

    expect(planReadReplicaSchemaSync({
      types: [{
        name: 'invalid_enum',
        kind: 'e',
        definition: ['contains\0nul'],
      }],
    }, actual)).toEqual({
      statements: [],
      skipped: [{
        kind: 'type',
        table: 'public',
        name: 'invalid_enum',
        reason: 'unsupported_type_creation',
      }],
    })
  })

  it.concurrent('does not reconcile existing column defaults', () => {
    const { expected } = catalogs()
    const current = structuredClone(expected)
    current.columns[0] = {
      ...current.columns[0],
      default: 'gen_random_uuid()',
    }

    expect(planReadReplicaSchemaSync(expected, current)).toEqual({
      statements: [],
      skipped: [],
    })
  })

  it.concurrent('rejects existing-column nullability changes before primary migration', () => {
    const { expected } = catalogs()
    const current = structuredClone(expected)
    current.columns[0] = {
      ...current.columns[0],
      notNull: false,
    }

    expect(planReadReplicaSchemaSync(expected, current)).toEqual({
      statements: [],
      skipped: [{
        kind: 'column',
        table: 'apps',
        name: 'id',
        reason: 'pre_primary_column_nullability',
      }],
    })
  })
})
