// Backfill first-day app statistics from stored app versions.
import { connectScriptDb } from './script_db.ts'

const databaseUrl = '***'

async function updateOrAppStats(db, increment, date_id, user_id) {
  const { rows: [dataAppStats] } = await db.query(
    'SELECT * FROM public.app_stats WHERE app_id = $1 AND date_id = $2',
    [increment.app_id, date_id],
  )
  if (dataAppStats) {
    await db.query(
      `SELECT public.increment_stats(app_id => $1, date_id => $2, bandwidth => $3, mlu => $4, mlu_real => $5,
         devices => $6, version_size => $7, channels => $8, shared => $9, versions => $10)`,
      [increment.app_id, increment.date_id, increment.bandwidth, increment.mlu, increment.mlu_real,
        increment.devices, increment.version_size, increment.channels, increment.shared, increment.versions],
    ).catch(error => console.error('increment_stats', error))
  }
  else {
    const newDay = {
      ...increment,
      user_id,
    }
    const columns = Object.keys(newDay)
    await db.query(
      `INSERT INTO public.app_stats (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(newDay),
    ).catch(error => console.error('Cannot create app_stats', error))
  }
}

async function fix_apps() {
  const db = await connectScriptDb(databaseUrl)

  const { rows: data } = await db.query('SELECT * FROM public.apps')

  if (!data || !data.length) {
    console.error('No apps found')
    await db.end()
    return
  }

  const all = []
  for (const app of data) {
    console.log('app', app.app_id)
    if (!app.app_id)
      break
    // Objects directly under the versions folder of the `apps` bucket, like a Storage list.
    const folder = `${app.user_id}/${app.app_id}/versions`
    const { rows: versions } = await db.query(
      `SELECT name, metadata FROM storage.objects
       WHERE bucket_id = 'apps' AND starts_with(name, $1 || '/') AND strpos(substr(name, length($1) + 2), '/') = 0`,
      [folder],
    )
    console.log('versions', versions)
    const versionSize = versions.reduce((acc, cur) => acc + (cur.metadata?.size ?? 0), 0)
    if (new Date().getDate() === 1) {
      const today_id = new Date().toISOString().slice(0, 10)
      const increment = {
        app_id: app.app_id,
        date_id: '2023-01-01',
        bandwidth: 0,
        mlu: 0,
        mlu_real: 0,
        devices: 0,
        version_size: versionSize,
        channels: 0,
        shared: 0,
        versions: 0,
      }
      all.push(updateOrAppStats(db, increment, today_id, app.user_id))
    }
  }
  await Promise.all(all)
  await db.end()
}

fix_apps()
