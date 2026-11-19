import { createPgliteEngine, Database } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'
import { describe, expect, it } from 'vitest'

describe('read_replica_commit_marker privileges', () => {
  it('denies anon and authenticated select, insert, update, delete, truncate, and function execute', async () => {
    const project = await loadSupabaseProject(process.cwd())
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.runMigrations(project.migrations)

      const [privileges] = (await database.query(`
        SELECT
          has_table_privilege('anon', 'public.read_replica_commit_marker', 'SELECT') AS anon_select,
          has_table_privilege('anon', 'public.read_replica_commit_marker', 'INSERT') AS anon_insert,
          has_table_privilege('anon', 'public.read_replica_commit_marker', 'UPDATE') AS anon_update,
          has_table_privilege('anon', 'public.read_replica_commit_marker', 'DELETE') AS anon_delete,
          has_table_privilege('anon', 'public.read_replica_commit_marker', 'TRUNCATE') AS anon_truncate,
          has_table_privilege('authenticated', 'public.read_replica_commit_marker', 'SELECT') AS authenticated_select,
          has_table_privilege('authenticated', 'public.read_replica_commit_marker', 'INSERT') AS authenticated_insert,
          has_table_privilege('authenticated', 'public.read_replica_commit_marker', 'UPDATE') AS authenticated_update,
          has_table_privilege('authenticated', 'public.read_replica_commit_marker', 'DELETE') AS authenticated_delete,
          has_table_privilege('authenticated', 'public.read_replica_commit_marker', 'TRUNCATE') AS authenticated_truncate,
          has_function_privilege('anon', 'public.touch_read_replica_commit_marker()', 'EXECUTE') AS anon_touch,
          has_function_privilege('authenticated', 'public.touch_read_replica_commit_marker()', 'EXECUTE') AS authenticated_touch
      `)).rows as [{
        anon_select: boolean
        anon_insert: boolean
        anon_update: boolean
        anon_delete: boolean
        anon_truncate: boolean
        authenticated_select: boolean
        authenticated_insert: boolean
        authenticated_update: boolean
        authenticated_delete: boolean
        authenticated_truncate: boolean
        anon_touch: boolean
        authenticated_touch: boolean
      }]

      expect(privileges).toEqual({
        anon_select: false,
        anon_insert: false,
        anon_update: false,
        anon_delete: false,
        anon_truncate: false,
        authenticated_select: false,
        authenticated_insert: false,
        authenticated_update: false,
        authenticated_delete: false,
        authenticated_truncate: false,
        anon_touch: false,
        authenticated_touch: false,
      })

      await expect(database.exec('SET ROLE anon; SELECT 1 FROM public.read_replica_commit_marker')).rejects.toThrow()
      await expect(database.exec('SET ROLE anon; INSERT INTO public.read_replica_commit_marker DEFAULT VALUES')).rejects.toThrow()
      await expect(database.exec('SET ROLE anon; TRUNCATE public.read_replica_commit_marker')).rejects.toThrow()
      await expect(database.exec('SET ROLE authenticated; SELECT 1 FROM public.read_replica_commit_marker')).rejects.toThrow()
    }
    finally {
      await database.close()
    }
  })
})