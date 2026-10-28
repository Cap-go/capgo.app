import { describe, expect, it } from 'vitest'
import { completeVersionManifest } from '../supabase/functions/_backend/plugin_runtime/utils/version_manifest_sql.ts'

const row = (name: string, expected: number) => ({ file_name: name, file_hash: `${name}-hash`, s3_path: `orgs/o/apps/a/delta/${name}`, expected })

describe('completeVersionManifest', () => {
  it('returns the entries in order without the expected count', () => {
    expect(completeVersionManifest([row('a.js', 2), row('b.js', 2)])).toEqual([
      { file_name: 'a.js', file_hash: 'a.js-hash', s3_path: 'orgs/o/apps/a/delta/a.js' },
      { file_name: 'b.js', file_hash: 'b.js-hash', s3_path: 'orgs/o/apps/a/delta/b.js' },
    ])
  })

  it('serves nothing while a replica is still copying some files', () => {
    expect(completeVersionManifest([row('a.js', 3), row('b.js', 3)])).toEqual([])
    expect(completeVersionManifest([])).toEqual([])
  })

  it('accepts the count as a string, as bigint-like driver values arrive', () => {
    expect(completeVersionManifest([{ ...row('a.js', 1), expected: '1' as unknown as number }])).toHaveLength(1)
  })
})
