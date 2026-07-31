import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { READ_REPLICA_SCHEMA_CATALOG_SQL } from '../read_replicate/schema_catalog.ts'
import { cleanupPostgresClient, getPostgresClient } from './test-utils.ts'

interface CatalogIndex {
  table: string
  name: string
  constraintOwned: boolean
}

interface CatalogType {
  name: string
  kind: string
  definition: unknown
}

interface CatalogSequence {
  name: string
  ownedTable: string | null
  ownedColumn: string | null
}

interface SchemaCatalog {
  indexes: CatalogIndex[]
  types: CatalogType[]
  sequences: CatalogSequence[]
}

afterAll(async () => {
  await cleanupPostgresClient()
})

describe('read-replica schema catalog', () => {
  it('does not duplicate selected indexes for foreign keys from non-selected tables', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    const parentTableName = `rrcat_fk_parent_${suffix}`
    const childTableName = `rrcat_fk_child_${suffix}`
    const pool = await getPostgresClient()

    try {
      await pool.query(`
        CREATE TABLE public.${parentTableName} (
          id uuid PRIMARY KEY
        );
        CREATE TABLE public.${childTableName} (
          parent_id uuid NOT NULL REFERENCES public.${parentTableName}(id)
        )
      `)

      const result = await pool.query(READ_REPLICA_SCHEMA_CATALOG_SQL, [[parentTableName], [], [], [], []])
      const catalog = result.rows[0].catalog as SchemaCatalog
      const parentPrimaryKey = catalog.indexes.filter(index => index.table === parentTableName && index.name === `${parentTableName}_pkey`)

      expect(parentPrimaryKey).toHaveLength(1)
      expect(parentPrimaryKey[0]).toMatchObject({
        table: parentTableName,
        name: `${parentTableName}_pkey`,
        constraintOwned: true,
      })
    }
    finally {
      await pool.query(`
        DROP TABLE IF EXISTS public.${childTableName};
        DROP TABLE IF EXISTS public.${parentTableName};
      `)
    }
  })

  it('follows nested selected column types and identity-owned sequences', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    const tableName = `rrcat_${suffix}_table`
    const enumName = `rrcat_${suffix}_enum`
    const domainName = `rrcat_${suffix}_domain`
    const arrayDomainName = `rrcat_${suffix}_array_domain`
    const domainColumn = `rrcat_${suffix}_value`
    const domainArrayColumn = `rrcat_${suffix}_value_array`
    const arrayDomainColumn = `rrcat_${suffix}_array_domain`
    const identityColumn = `rrcat_${suffix}_identity`
    const pool = await getPostgresClient()

    try {
      await pool.query(`
        CREATE TYPE public.${enumName} AS ENUM ('ready', 'paused');
        CREATE DOMAIN public.${domainName} AS public.${enumName};
        CREATE DOMAIN public.${arrayDomainName} AS public.${enumName}[];
        CREATE TABLE public.${tableName} (
          ${domainColumn} public.${domainName},
          ${domainArrayColumn} public.${domainName}[],
          ${arrayDomainColumn} public.${arrayDomainName},
          ${identityColumn} bigint GENERATED ALWAYS AS IDENTITY
        );
      `)

      const result = await pool.query(READ_REPLICA_SCHEMA_CATALOG_SQL, [[tableName], [], [], [], []])
      const catalog = result.rows[0].catalog as SchemaCatalog
      const enumType = catalog.types.find(type => type.name === enumName)
      const identitySequence = catalog.sequences.find(sequence => (
        sequence.ownedTable === tableName
        && sequence.ownedColumn === identityColumn
      ))

      expect(enumType).toMatchObject({
        name: enumName,
        kind: 'e',
        definition: ['ready', 'paused'],
      })
      expect(identitySequence).toMatchObject({
        ownedTable: tableName,
        ownedColumn: identityColumn,
      })
      expect(identitySequence?.name).toBe(`${tableName}_${identityColumn}_seq`)
    }
    finally {
      await pool.query(`
        DROP TABLE IF EXISTS public.${tableName};
        DROP DOMAIN IF EXISTS public.${arrayDomainName};
        DROP DOMAIN IF EXISTS public.${domainName};
        DROP TYPE IF EXISTS public.${enumName};
      `)
    }
  })
})
