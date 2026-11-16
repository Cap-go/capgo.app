import pg from 'npm:pg@8'

const databaseUrl = '****'
const ids = []

// bigint ids as numbers, like PostgREST returned them.
pg.types.setTypeParser(20, Number)

async function fetchAllIds(db: pg.Client) {
  let allIds: number[] = []
  let lastId = 0
  const pageSize = 1000

  while (true) {
    const { rows: data } = await db.query('SELECT id FROM public.app_versions WHERE id > $1 ORDER BY id LIMIT $2', [lastId, pageSize])
      .catch((error: unknown) => {
        console.error('Error fetching data:', error)
        return { rows: null }
      })
    if (!data)
      return []

    if (data.length === 0) {
      break
    }

    allIds = allIds.concat(data.map((item: { id: number }) => item.id))
    lastId = data[data.length - 1].id

    if (data.length < pageSize) {
      break
    }
  }

  return allIds
}

function generateInsertQuery(idsToInsert: number[]): string {
  const values = idsToInsert.map(id => `(${id})`).join(', ')
  return `INSERT INTO devices_override (id) VALUES ${values};`
}

async function main() {
  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()

  const idsInSupabase = await fetchAllIds(db)
  await db.end()
  const idsSet = new Set(ids.map(item => item.id))

  const idsInSupabaseNotInIds = idsInSupabase.filter(obj => !idsSet.has(obj.id))

  console.log('IDs in Supabase but not in ids array:', idsInSupabaseNotInIds)
  console.log('Total IDs in Supabase:', idsInSupabase.length)
  console.log('Total IDs in ids array:', ids.length)
  console.log('Total IDs in Supabase but not in ids array:', idsInSupabaseNotInIds.length)
  const insertQuery = generateInsertQuery(idsInSupabaseNotInIds)
  console.log('SQL Insert Query:', insertQuery)
}

await main()
