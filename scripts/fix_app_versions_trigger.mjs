// Backfill app_stats device counts for recently active apps.
import { connectScriptDb } from './script_db.ts'

const databaseUrl = '***'

async function fix_apps() {
  const db = await connectScriptDb(databaseUrl)

  const { rows: data } = await db.query('SELECT * FROM public.apps')

  // if (!data || !data.length) {
  //   console.error('No apps_versions found')
  //   return
  // }
  const d = new Date()
  d.setDate(d.getDate() - 5)
  const today_id = d.toISOString().slice(0, 10)
  console.log('today_id', today_id)
  const all = []
  for (const app of data) {
    all.push(db.query('UPDATE public.app_stats SET devices_real = 1 WHERE app_id = $1 AND date_id = $2', [app.app_id, today_id])
      .then(() => {
        console.log('app', app.app_id)
      }, (error) => {
        console.log('app', app.app_id)
        console.log('res', error)
      }))
  }
  await Promise.all(all)
  await db.end()
}

fix_apps()
