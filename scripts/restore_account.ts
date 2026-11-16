/// <reference lib="deno.ns" />
import { load } from 'https://deno.land/std@0.224.0/dotenv/mod.ts'
import pg from 'npm:pg@8'

const accountId = 'THE ACCOUNT ID TO RESTORE'

// Load environment variables from .env.prod
// Running the script: deno run --allow-read --allow-net --allow-env restore_account.ts
const envPath = new URL('../internal/cloudflare/.env.prod', import.meta.url).pathname
const env = await load({ envPath })

const databaseUrl = env.MAIN_SUPABASE_DB_URL || env.DATABASE_URL || env.SUPABASE_DB_URL || env.SUPABASE_DB_DIRECT_URL

if (!databaseUrl) {
  console.error('Missing MAIN_SUPABASE_DB_URL (or DATABASE_URL, SUPABASE_DB_URL, SUPABASE_DB_DIRECT_URL) in .env.prod')
  Deno.exit(1)
}

interface ApiKey {
  id: number
  created_at: string
  user_id: string
  key: string | null
  updated_at: string
  name: string
  expires_at: string | null
  key_hash: string | null
}

interface RemovedData {
  email: string
  apikeys: ApiKey[] | null
}

interface ToDeleteAccount {
  id: number
  account_id: string
  removal_date: string
  removed_data: RemovedData
  created_at: string
}

async function main() {
  // Supabase's pooler certificate is signed by Supabase's own CA (see scripts/script_db.ts).
  const url = new URL(databaseUrl)
  url.searchParams.delete('sslmode')
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  const db = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } })
  await db.connect()

  // Get all accounts pending deletion
  const { rows: accountsToRestore } = await db.query('SELECT * FROM public.to_delete_accounts WHERE account_id = $1', [accountId])
    .catch((fetchError: unknown) => {
      console.error('Error fetching accounts to restore:', fetchError)
      Deno.exit(1)
    })

  if (!accountsToRestore || accountsToRestore.length === 0) {
    console.log('No accounts found in to_delete_accounts table')
    Deno.exit(0)
  }

  if (accountsToRestore.length > 1) {
    console.error('More than one account found in to_delete_accounts table')
    Deno.exit(1)
  }

  console.log(`Found ${accountsToRestore.length} account(s) to restore`)

  for (const account of accountsToRestore as unknown as ToDeleteAccount[]) {
    console.log(`\nProcessing account: ${account.account_id}`)
    console.log(`  Email: ${account.removed_data?.email || 'unknown'}`)

    const apikeys = account.removed_data?.apikeys

    if (!apikeys || apikeys.length === 0) {
      console.log('  No API keys to restore for this account')
    }
    else {
      console.log(`  Found ${apikeys.length} API key(s) to restore`)

      for (const apikey of apikeys) {
        if (!apikey.key && !apikey.key_hash) {
          console.log(`  Skipping API key "${apikey.name}" - no key value or hash to restore`)
          continue
        }

        // Check if this apikey already exists by visible key or hash.
        const { rows: existingKeys } = apikey.key
          ? await db.query('SELECT id FROM public.apikeys WHERE key = $1', [apikey.key])
          : await db.query('SELECT id FROM public.apikeys WHERE key_hash = $1', [apikey.key_hash])

        if (existingKeys.length === 1) {
          console.log(`  Skipping API key "${apikey.name}" - already exists`)
          continue
        }

        // Insert the API key back
        const insertError = await db.query(
          'INSERT INTO public.apikeys (user_id, key, name, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
          [apikey.user_id, apikey.key, apikey.name, apikey.key_hash, apikey.expires_at],
        ).then(() => null, (error: unknown) => error)

        if (insertError) {
          console.error(`  Error restoring API key "${apikey.name}":`, insertError)
        }
        else {
          console.log(`  Restored API key: "${apikey.name}" (RBAC bindings must be reassigned)`)
        }
      }
    }

    // Remove the account from to_delete_accounts
    const deleteError = await db.query('DELETE FROM public.to_delete_accounts WHERE id = $1', [account.id])
      .then(() => null, (error: unknown) => error)

    if (deleteError) {
      console.error(`  Error removing account from to_delete_accounts:`, deleteError)
    }
    else {
      console.log(`  Removed account ${account.account_id} from to_delete_accounts`)
    }
  }

  await db.end()
  console.log('\nRestore complete!')
}

await main()
