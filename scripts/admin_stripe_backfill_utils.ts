import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createClient } from './db-client.ts'
import Stripe from 'stripe'

export const DEFAULT_ENV_FILE = './internal/cloudflare/.env.prod'

export function getArgValue(args: string[], prefix: string): string | null {
  const arg = args.find(value => value.startsWith(`${prefix}=`))
  if (!arg)
    return null
  return arg.slice(prefix.length + 1)
}

export async function loadEnv(filePath: string) {
  if (!existsSync(filePath))
    return {}

  const text = await readFile(filePath, 'utf8')
  const env: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0)
      continue

    const key = trimmed.slice(0, separatorIndex)
    let value = trimmed.slice(separatorIndex + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
      value = value.slice(1, -1)
    env[key] = value
  }

  return env
}

export function getRequiredEnv(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  if (!value)
    throw new Error(`Missing ${key}`)
  return value
}

export function getSupabaseServiceRoleKey(env: Record<string, string | undefined>) {
  const value = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SERVICE_KEY?.trim()
  if (!value)
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  return value
}

export function createSupabaseServiceClient(env: Record<string, string | undefined>) {
  return createClient<Database>(
    getRequiredEnv(env, 'SUPABASE_URL'),
    getSupabaseServiceRoleKey(env),
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )
}

export function createStripeClient(secretKey: string, apiBaseUrl?: string) {
  let hostConfig: Partial<Pick<NonNullable<ConstructorParameters<typeof Stripe>[1]>, 'host' | 'port' | 'protocol'>> = {}

  if (apiBaseUrl?.trim()) {
    const parsed = new URL(apiBaseUrl)
    hostConfig = {
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10),
      protocol: parsed.protocol.replace(':', '') as 'http' | 'https',
    }
  }

  type StripeApiVersion = NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
  return new Stripe(secretKey, {
    apiVersion: '2026-04-22.dahlia' as StripeApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
    ...hostConfig,
  })
}

export async function asyncPool<T>(limit: number, items: T[], iterator: (item: T) => Promise<void>) {
  const executing = new Set<Promise<void>>()

  for (const item of items) {
    const task = iterator(item).finally(() => {
      executing.delete(task)
    })
    executing.add(task)

    if (executing.size >= limit)
      await Promise.race(executing)
  }

  await Promise.all(executing)
}

export function parsePositiveInteger(value: string | null, label: string, fallback: number) {
  if (value === null)
    return fallback

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`)

  return parsed
}

export function isActionableStripeCustomerId(customerId: string | null | undefined) {
  const trimmedCustomerId = customerId?.trim()
  return !!trimmedCustomerId && !trimmedCustomerId.startsWith('pending_')
}
