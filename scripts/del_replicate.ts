
import pg from 'npm:pg@8'

const databaseUrl = '***'
const ids = []

async function main() {

  // find id who are not in supabase
  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  const idsFound = await Promise.all(ids.map(async (obj) => {
    const { rows } = await db.query('SELECT id FROM public.devices_override WHERE id = $1', [obj.id])
    if (rows.length !== 1) {
      console.error(`devices_override ${obj.id}: ${rows.length} rows`)
      return obj.id
    }
    return null
  }))
  await db.end()

  const idsNotFound = idsFound.filter((id) => !!id)
  console.log('idsNotFound', idsNotFound)
}
await main()
