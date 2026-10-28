import { createPgliteEngine } from 'tinbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deltaFileS3Path } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { deltaFileHashSql, deltaFileS3PathSql } from '../supabase/functions/_backend/plugin_runtime/utils/version_manifest_sql.ts'

const org = '2f322bd9-a7ba-47d2-92be-4e13c3dd6f6e'
const appId = 'co.example.app'
const session = '54764a39523d3d3a4e72'
const sha = '9c'.repeat(32)
const fileName = 'suite/4707.2ef8.js.br'
const sessionPath = `orgs/${org}/apps/${appId}/delta/${session}/${sha}_${fileName}`
const plainPath = `orgs/${org}/apps/${appId}/delta/${sha}_${fileName}`
const legacyPath = `orgs/${org}/apps/${appId}/1.7.1/svg/rainy.svg`
const hash = '34fc'.repeat(16)

describe('deltaFileS3Path', () => {
  const compacted = { s3_path: '', app_id: appId, file_name: fileName, path_org: org, path_session: `\\x${session}`, path_sha: `\\x${sha}` }

  it('rebuilds a compacted path from PostgREST bytea values', () => {
    expect(deltaFileS3Path(compacted)).toBe(sessionPath)
    expect(deltaFileS3Path({ ...compacted, path_session: null })).toBe(plainPath)
  })

  it('returns the stored path of a row that is not compacted', () => {
    expect(deltaFileS3Path({ s3_path: legacyPath, app_id: appId, file_name: 'svg/rainy.svg', path_org: null, path_session: null, path_sha: null })).toBe(legacyPath)
  })
})

describe('replica SQL for compacted delta_files rows', () => {
  let database: Awaited<ReturnType<typeof createPgliteEngine>>

  beforeAll(async () => {
    database = await createPgliteEngine()
    await database.exec(`
      CREATE TABLE delta_file (
        id integer PRIMARY KEY, app_id varchar NOT NULL, s3_path varchar NOT NULL, file_name varchar NOT NULL,
        file_hash varchar NOT NULL, path_org uuid, path_session bytea, path_sha bytea, file_hash_bin bytea
      );
    `)
    await database.query(
      `INSERT INTO delta_file VALUES
        (1, $1, '', $2, '', $3::uuid, decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex')),
        (2, $1, '', $2, $6, $3::uuid, NULL, decode($5, 'hex'), NULL),
        (3, $1, $7, 'svg/rainy.svg', 'uhAeBLCA==', NULL, NULL, NULL, NULL)`,
      [appId, fileName, org, session, sha, hash, legacyPath],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  it('rebuilds the stored path and hash of every row', async () => {
    const { rows } = await database.query(
      `SELECT ${deltaFileS3PathSql('delta_file')} AS s3_path, ${deltaFileHashSql('delta_file')} AS file_hash FROM delta_file ORDER BY id`,
    )
    expect(rows).toEqual([
      { s3_path: sessionPath, file_hash: hash },
      { s3_path: plainPath, file_hash: hash },
      { s3_path: legacyPath, file_hash: 'uhAeBLCA==' },
    ])
  })
})
