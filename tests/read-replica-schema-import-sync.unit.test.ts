import type {
  ReadReplicaSchemaSyncPlan,
  ReadReplicaSchemaSyncStatement,
} from '../read_replicate/schema_additive_sync.ts'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertGoogleReadReplicaSchemaPlan,
  partitionReadReplicaImportStatements,
  renderReadReplicaImportTransaction,
  renderReadReplicaIndexImport,
} from '../scripts/sync-read-replica-schema.ts'

const syncScriptUrl = new URL(
  '../scripts/sync-read-replica-schema.ts',
  import.meta.url,
)

const safeColumnStatement: ReadReplicaSchemaSyncStatement = {
  kind: 'column',
  table: 'apps',
  name: 'read_replica_import_unit',
  sql: 'ALTER TABLE public."apps" ADD COLUMN IF NOT EXISTS "read_replica_import_unit" boolean',
}

const safeIndexStatement: ReadReplicaSchemaSyncStatement = {
  kind: 'index',
  table: 'apps',
  name: 'read_replica_import_unit_index',
  sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "read_replica_import_unit_index" ON public."apps" ("app_id")',
}

const spacedIndexStatement: ReadReplicaSchemaSyncStatement = {
  kind: 'index',
  table: 'orgs',
  name: 'unique customer_id on orgs',
  sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unique customer_id on orgs" ON public."orgs" USING btree (customer_id)',
}

const spacedConstraintStatement: ReadReplicaSchemaSyncStatement = {
  kind: 'constraint',
  table: 'orgs',
  name: 'unique customer_id on orgs',
  sql: 'ALTER TABLE public."orgs" ADD CONSTRAINT "unique customer_id on orgs" UNIQUE USING INDEX "unique customer_id on orgs"',
}

function plan(
  statements: ReadReplicaSchemaSyncStatement[],
): ReadReplicaSchemaSyncPlan {
  return { statements, skipped: [] }
}

describe('read-replica Cloud SQL server-side import', () => {
  it.concurrent('renders reviewed DDL as one postgres-owned atomic import transaction', () => {
    assertGoogleReadReplicaSchemaPlan(plan([safeColumnStatement]))

    expect(renderReadReplicaImportTransaction([safeColumnStatement])).toBe(
      [
        'BEGIN;',
        `${safeColumnStatement.sql};`,
        'COMMIT;',
      ].join('\n'),
    )
  })

  it.concurrent('imports reviewed index DDL outside the atomic transaction', () => {
    assertGoogleReadReplicaSchemaPlan(plan([safeIndexStatement]))

    expect(renderReadReplicaIndexImport([safeIndexStatement])).toBe(
      'CREATE INDEX IF NOT EXISTS "read_replica_import_unit_index" ON public."apps" ("app_id");',
    )
    expect(() => {
      renderReadReplicaImportTransaction([safeIndexStatement])
    }).toThrow('cannot atomically apply')
  })

  it.concurrent('strips only the leading CONCURRENTLY keyword from index DDL', () => {
    const tricky: ReadReplicaSchemaSyncStatement = {
      kind: 'index',
      table: 'apps',
      name: 'create index concurrently trap',
      sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "create index concurrently trap" ON public."apps" ("app_id")',
    }
    assertGoogleReadReplicaSchemaPlan(plan([tricky]))
    expect(renderReadReplicaIndexImport([tricky])).toBe(
      'CREATE INDEX IF NOT EXISTS "create index concurrently trap" ON public."apps" ("app_id");',
    )
  })

  it.concurrent('imports quoted index names that contain spaces', () => {
    assertGoogleReadReplicaSchemaPlan(plan([spacedIndexStatement, spacedConstraintStatement]))

    expect(renderReadReplicaIndexImport([spacedIndexStatement])).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "unique customer_id on orgs" ON public."orgs" USING btree (customer_id);',
    )
    expect(renderReadReplicaImportTransaction([spacedConstraintStatement])).toContain(
      spacedConstraintStatement.sql,
    )
  })

  it.concurrent('partitions index DDL between column and constraint imports', () => {
    expect(
      partitionReadReplicaImportStatements([
        safeColumnStatement,
        safeIndexStatement,
        spacedConstraintStatement,
      ]),
    ).toEqual({
      preIndexAtomicStatements: [safeColumnStatement],
      indexStatements: [safeIndexStatement],
      postIndexAtomicStatements: [spacedConstraintStatement],
    })
  })

  it.concurrent('rejects unsupported plans before they can become import input', () => {
    const unsupportedStatements: ReadReplicaSchemaSyncStatement[] = [
      {
        kind: 'function',
        table: 'public',
        name: 'read_replica_import_unit_function()',
        sql: 'CREATE OR REPLACE FUNCTION public.read_replica_import_unit_function() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
      },
    ]

    for (const statement of unsupportedStatements) {
      expect(() => {
        assertGoogleReadReplicaSchemaPlan(plan([statement]))
      }).toThrow('cannot atomically apply')
      expect(() => {
        renderReadReplicaImportTransaction([statement])
      }).toThrow('cannot atomically apply')
    }
  })

  it.concurrent('uses only the server-side postgres import path without database-side machinery', async () => {
    const source = await readFile(syncScriptUrl, 'utf8')

    expect(source).toMatch(/['"]sql['"],\s*['"]import['"],\s*['"]sql['"]/)
    expect(source).toMatch(/--user=(?:postgres|\$\{POSTGRES_IMPORT_USER\})/)
    expect(source).toContain('BEGIN;')
    expect(source).toContain('COMMIT;')
    expect(source).toContain('renderReadReplicaIndexImport(indexStatements)')
    expect(source).toContain('preIndexAtomicStatements')
    expect(source).toContain('postIndexAtomicStatements')
    expect(source).toContain('renderCloudSqlIndexStatement')
    expect(source).not.toContain('capgo_read_replica_schema_owner')
    expect(source).not.toContain('bootstrap-read-replica-schema-owner')
    expect(source).not.toContain('CREATE ROLE')
    expect(source).not.toContain(' OWNER TO ')
    expect(source).not.toContain('SET LOCAL ROLE')
    expect(source).not.toContain('CREATE FUNCTION')
    expect(source).not.toContain('SECURITY DEFINER')
    expect(source).not.toContain('GRANT ')
    expect(source).not.toContain('REVOKE ')
  })
})
