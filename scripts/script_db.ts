// Direct Postgres access for admin scripts that used to go through PostgREST.
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB_URL_ENV_KEYS = ['MAIN_SUPABASE_DB_URL', 'DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_DB_DIRECT_URL'] as const

const INT8_OID = 20
const TIMESTAMP_OID = 1114
const TIMESTAMPTZ_OID = 1184

// Keep the row shapes PostgREST returned: bigint as a number, timestamps as
// ISO strings instead of pg's bigint strings and Date objects.
function toIsoTimestamp(value: string) {
  return value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
}

const postgrestLikeTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === INT8_OID)
      return (value: string) => Number(value)
    if (oid === TIMESTAMP_OID || oid === TIMESTAMPTZ_OID)
      return toIsoTimestamp
    return pg.types.getTypeParser(oid, format)
  }) as typeof pg.types.getTypeParser,
}

export function getDatabaseUrl(env: Record<string, string | undefined>): string {
  for (const key of DB_URL_ENV_KEYS) {
    const value = env[key]?.trim()
    if (value)
      return value
  }
  throw new Error(`Missing Postgres URL. Set one of: ${DB_URL_ENV_KEYS.join(', ')}`)
}

// Supabase's database and pooler certificates are signed by Supabase's own root
// CA (Dashboard > Database > SSL), so remote connections verify against it.
// `sslmode` is dropped from the URL because pg lets it override `ssl`.
const SUPABASE_CA = readFileSync(new URL('./supabase-prod-ca-2021.crt', import.meta.url), 'utf8')

export async function connectScriptDb(databaseUrl: string): Promise<pg.Client> {
  const url = new URL(databaseUrl)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  url.searchParams.delete('sslmode')
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: local ? false : { ca: SUPABASE_CA },
    types: postgrestLikeTypes,
  })
  await client.connect()
  return client
}
