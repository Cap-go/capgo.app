// Backfill metadata size for deleted app versions.
import { connectScriptDb } from './script_db.ts'

const databaseUrl = '***'

async function fix_apps() {
  const db = await connectScriptDb(databaseUrl)

  const { rows: data } = await db.query('SELECT * FROM public.app_versions WHERE deleted = true')

  if (!data || !data.length) {
    console.error('No apps_versions found')
    return
  }

  const all = []
  for (const version of data) {
    all.push(db.query('UPDATE public.app_versions_meta SET size = 0 WHERE app_id = $1 AND id = $2', [version.app_id, version.id])
      .then(() => {
        console.log('versions', version.app_id, version.id)
      }, (error) => {
        console.log('versions', version.app_id, version.id)
        console.log('res', error)
      }))
  }
  await Promise.all(all)
  await db.end()
}

fix_apps()
