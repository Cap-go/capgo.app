
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const supabaseUrl = 'https://sb.capgo.app'
const supabaseServiceRole = '***'
// Postgres URL of the same project (Database settings). Queries go straight to it.
const supabaseDbUrl = '***'
const ids = []

async function main() {

  // find id who are not in supabase
  const supabase = createClient<Database>(supabaseUrl, supabaseServiceRole, {
    databaseUrl: supabaseDbUrl,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
  const idsFound = await Promise.all(ids.map(async (obj) => {
    const { error } = await supabase.from('devices_override').select('id').eq('id', obj.id).single()
    if (error) {
      console.error(error)
      return obj.id
    }
    return null
  }))

  const idsNotFound = idsFound.filter((id) => !!id)
  console.log('idsNotFound', idsNotFound)
}
await main()
