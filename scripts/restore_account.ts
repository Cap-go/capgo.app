/// <reference lib="deno.ns" />
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { createClient } from './db-client.ts'
import { load } from 'https://deno.land/std@0.224.0/dotenv/mod.ts'

const accountId = 'THE ACCOUNT ID TO RESTORE'

// Load environment variables from .env.prod
// Running the script: deno run --allow-read --allow-net --allow-env restore_account.ts
const envPath = new URL('../internal/cloudflare/.env.prod', import.meta.url).pathname
const env = await load({ envPath })

const supabaseUrl = env.SUPABASE_URL
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.prod')
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
  const supabase = createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  // Get all accounts pending deletion
  const { data: accountsToRestore, error: fetchError } = await supabase
    .from('to_delete_accounts')
    .select('*')
    .eq('account_id', accountId)

  if (fetchError) {
    console.error('Error fetching accounts to restore:', fetchError)
    Deno.exit(1)
  }

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
        let existingKeyQuery = supabase
          .from('apikeys')
          .select('id')

        existingKeyQuery = apikey.key
          ? existingKeyQuery.eq('key', apikey.key)
          : existingKeyQuery.eq('key_hash', apikey.key_hash)

        const { data: existingKey } = await existingKeyQuery.single()

        if (existingKey) {
          console.log(`  Skipping API key "${apikey.name}" - already exists`)
          continue
        }

        // Insert the API key back
        const { error: insertError } = await supabase
          .from('apikeys')
          .insert({
            user_id: apikey.user_id,
            key: apikey.key,
            name: apikey.name,
            key_hash: apikey.key_hash,
            expires_at: apikey.expires_at,
          })

        if (insertError) {
          console.error(`  Error restoring API key "${apikey.name}":`, insertError)
        }
        else {
          console.log(`  Restored API key: "${apikey.name}" (RBAC bindings must be reassigned)`)
        }
      }
    }

    // Remove the account from to_delete_accounts
    const { error: deleteError } = await supabase
      .from('to_delete_accounts')
      .delete()
      .eq('id', account.id)

    if (deleteError) {
      console.error(`  Error removing account from to_delete_accounts:`, deleteError)
    }
    else {
      console.log(`  Removed account ${account.account_id} from to_delete_accounts`)
    }
  }

  console.log('\nRestore complete!')
}

await main()
