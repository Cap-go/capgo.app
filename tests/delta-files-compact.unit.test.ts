import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createPgliteEngine } from 'tinbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { completeVersionManifest, deltaFileHashSql, deltaFileS3PathSql, deltaSessionJoinSql, versionManifestJsonSql, versionManifestRowsSql, versionManifestSizeRowsSql } from '../supabase/functions/_backend/plugin_runtime/utils/version_manifest_sql.ts'

const org = '2f322bd9-a7ba-47d2-92be-4e13c3dd6f6e'
const appId = 'co.example.app'
const session = '54'.repeat(370)
const sha = '9c'.repeat(32)
const fileName = 'suite/4707.2ef8.js.br'
const sessionPath = `orgs/${org}/apps/${appId}/delta/${session}/${sha}_${fileName}`
const plainPath = `orgs/${org}/apps/${appId}/delta/${sha}_${fileName}`
const legacyPath = `orgs/${org}/apps/${appId}/1.7.1/svg/rainy.svg`
const hash = '34fc'.repeat(16)

const dialect = new PgDialect()

describe('replica SQL for compacted delta_files rows', () => {
  let database: Awaited<ReturnType<typeof createPgliteEngine>>

  beforeAll(async () => {
    database = await createPgliteEngine()
    await database.exec(`
      CREATE TABLE public.delta_files (
        id integer PRIMARY KEY, app_id varchar NOT NULL, s3_path varchar NOT NULL, file_name varchar NOT NULL,
        file_hash varchar NOT NULL, path_org uuid, path_session bytea, path_sha bytea, file_hash_bin bytea, path_session_id integer, file_size bigint DEFAULT 10
      );
      CREATE TABLE public.delta_sessions (id integer PRIMARY KEY, session bytea NOT NULL);
      CREATE TABLE public.version_files (app_version_id bigint PRIMARY KEY, file_ids bigint[] NOT NULL);
    `)
    await database.query(`INSERT INTO public.delta_sessions VALUES (1, decode($1, 'hex'))`, [session])
    await database.query(
      `INSERT INTO public.delta_files VALUES
        (1, $1, '', $2, '', $3::uuid, decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), NULL),
        (2, $1, '', $2, $6, $3::uuid, NULL, decode($5, 'hex'), NULL, NULL),
        (3, $1, $7, 'svg/rainy.svg', 'uhAeBLCA==', NULL, NULL, NULL, NULL, NULL),
        (4, $1, '', $2, '', $3::uuid, NULL, decode($5, 'hex'), decode($6, 'hex'), 1),
        (5, $1, '', $2, '', $3::uuid, NULL, decode($5, 'hex'), decode($6, 'hex'), 2)`,
      [appId, fileName, org, session, sha, hash, legacyPath],
    )
    await database.exec(`INSERT INTO public.version_files VALUES (1, '{4,2,3,1}'), (2, '{4,5}'), (3, '{4,999}');`)
  })

  afterAll(async () => {
    await database?.close()
  })

  it.concurrent('rebuilds inline and shared sessions, sessionless paths and legacy text', async () => {
    const { rows } = await database.query(
      `SELECT ${deltaFileS3PathSql('df', 'ds')} AS s3_path, ${deltaFileHashSql('df')} AS file_hash
       FROM public.delta_files AS df ${deltaSessionJoinSql('df', 'ds')} WHERE df.id <= 4 ORDER BY df.id`,
    )
    expect(rows).toEqual([
      { s3_path: sessionPath, file_hash: hash },
      { s3_path: plainPath, file_hash: hash },
      { s3_path: legacyPath, file_hash: 'uhAeBLCA==' },
      { s3_path: sessionPath, file_hash: hash },
    ])
  })


  it.concurrent('serves complete manifests in upload order through both readers', async () => {
    const query = dialect.sqlToQuery(versionManifestRowsSql(1))
    const { rows } = await database.query<Parameters<typeof completeVersionManifest>[0][number]>(query.sql, query.params)
    const expected = [
      { file_name: fileName, s3_path: sessionPath, file_hash: hash },
      { file_name: fileName, s3_path: plainPath, file_hash: hash },
      { file_name: 'svg/rainy.svg', s3_path: legacyPath, file_hash: 'uhAeBLCA==' },
      { file_name: fileName, s3_path: sessionPath, file_hash: hash },
    ]
    expect(completeVersionManifest(rows)).toEqual(expected)
    const json = dialect.sqlToQuery(sql`SELECT ${versionManifestJsonSql(1)} AS entries`)
    expect((await database.query(json.sql, json.params)).rows).toEqual([{ entries: expected }])
    const sizes = await database.query(`SELECT * FROM ${versionManifestSizeRowsSql('1')} AS manifest_size`)
    expect(sizes.rows).toHaveLength(expected.length)
    expect(sizes.rows.every(row => row.file_size === 10)).toBe(true)
  })

  it.each([2, 3])('serves no partial manifest while session or file rows are missing, version %s', async (versionId) => {
    const query = dialect.sqlToQuery(versionManifestRowsSql(versionId))
    const { rows } = await database.query<Parameters<typeof completeVersionManifest>[0][number]>(query.sql, query.params)
    expect(completeVersionManifest(rows)).toEqual([])
    const json = dialect.sqlToQuery(sql`SELECT ${versionManifestJsonSql(versionId)} AS entries`)
    expect((await database.query(json.sql, json.params)).rows).toEqual([{ entries: [] }])
    const sizes = await database.query(`SELECT * FROM ${versionManifestSizeRowsSql(String(versionId))} AS manifest_size`)
    expect(sizes.rows).toEqual([])
  })
})
