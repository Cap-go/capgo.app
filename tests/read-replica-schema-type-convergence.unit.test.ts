import { describe, expect, it } from 'vitest'
import { planReadReplicaSchemaSync } from '../read_replicate/schema_additive_sync.ts'

const enumType = {
  name: 'stripe_status',
  kind: 'e',
  definition: ['created', 'succeeded'],
}

const compositeType = {
  name: 'manifest_entry',
  kind: 'c',
  definition: [
    { position: 1, name: 'file_name', type: 'character varying' },
    { position: 2, name: 's3_path', type: 'character varying' },
  ],
}

describe('read-replica type convergence', () => {
  it.concurrent('creates a missing selected enum from the primary catalog', () => {
    expect(planReadReplicaSchemaSync(
      { types: [enumType] },
      { types: [] },
    )).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'stripe_status',
        sql: 'CREATE TYPE public."stripe_status" AS ENUM (E\'created\', E\'succeeded\')',
      }],
      skipped: [],
    })
  })

  it.concurrent('creates a selected enum without a hard-coded type allowlist', () => {
    const selectedEnum = {
      name: 'app_release_state',
      kind: 'e',
      definition: ['draft', 'published'],
    }

    expect(planReadReplicaSchemaSync(
      { types: [selectedEnum] },
      { types: [] },
    )).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'app_release_state',
        sql: 'CREATE TYPE public."app_release_state" AS ENUM (E\'draft\', E\'published\')',
      }],
      skipped: [],
    })
  })

  it.concurrent('appends only source-trailing enum labels', () => {
    expect(planReadReplicaSchemaSync(
      { types: [enumType] },
      {
        types: [{
          ...enumType,
          definition: ['created'],
        }],
      },
    )).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'stripe_status',
        sql: 'ALTER TYPE public."stripe_status" ADD VALUE IF NOT EXISTS E\'succeeded\'',
      }],
      skipped: [],
    })
  })

  it.concurrent('keeps reordered enum labels as explicit unsafe drift', () => {
    expect(planReadReplicaSchemaSync(
      { types: [enumType] },
      {
        types: [{
          ...enumType,
          definition: ['succeeded'],
        }],
      },
    )).toEqual({
      statements: [],
      skipped: [{
        kind: 'type',
        table: 'public',
        name: 'stripe_status',
        reason: 'unsafe_enum_reconciliation',
      }],
    })
  })

  it.concurrent('creates a missing selected composite type', () => {
    expect(planReadReplicaSchemaSync(
      { types: [compositeType] },
      { types: [] },
    )).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'manifest_entry',
        sql: 'CREATE TYPE public."manifest_entry" AS ("file_name" character varying, "s3_path" character varying)',
      }],
      skipped: [],
    })
  })

  it.concurrent('adds only trailing composite attributes', () => {
    expect(planReadReplicaSchemaSync(
      { types: [compositeType] },
      {
        types: [{
          ...compositeType,
          definition: [compositeType.definition[0]],
        }],
      },
    )).toEqual({
      statements: [{
        kind: 'type',
        table: 'public',
        name: 'manifest_entry',
        sql: 'ALTER TYPE public."manifest_entry" ADD ATTRIBUTE "s3_path" character varying',
      }],
      skipped: [],
    })
  })

  it.concurrent('keeps non-prefix composite attributes as explicit unsafe drift', () => {
    expect(planReadReplicaSchemaSync(
      { types: [compositeType] },
      {
        types: [{
          ...compositeType,
          definition: [compositeType.definition[1]],
        }],
      },
    )).toEqual({
      statements: [],
      skipped: [{
        kind: 'type',
        table: 'public',
        name: 'manifest_entry',
        reason: 'unsafe_composite_reconciliation',
      }],
    })
  })

  it.concurrent('rejects malformed selected enum definitions', () => {
    expect(() => planReadReplicaSchemaSync(
      {
        types: [{
          ...enumType,
          definition: ['created', 1],
        }],
      },
      {},
    )).toThrow('Read-replica enum types must include unique string labels')
  })
})
