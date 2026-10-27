import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const supabaseUrl = 'https://sb.capgo.app'
const supabaseServiceRole = '****'
// Postgres URL of the same project (Database settings). Queries go straight to it.
const supabaseDbUrl = '***'
const ids = []

async function fetchAllIds(supabase: ReturnType<typeof createClient<Database>>) {
  let allIds: number[] = []
  let lastId = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await supabase
      .from('app_versions')
      .select('*')
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(pageSize)

    if (error) {
      console.error('Error fetching data:', error)
      return []
    }

    if (data.length === 0) {
      break
    }

    allIds = allIds.concat(data.map(item => item.id))
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
  const supabase = createClient<Database>(supabaseUrl, supabaseServiceRole, {
    databaseUrl: supabaseDbUrl,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  const idsInSupabase = await fetchAllIds(supabase)
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
