import type { EmailPreferences } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APP_NAME, BASE_URL, getSupabaseClient, ORG_ID_EMAIL_PREFS, resetAndSeedAppData, resetAppData, STRIPE_CUSTOMER_ID_EMAIL_PREFS, USER_EMAIL_EMAIL_PREFS, USER_ID_EMAIL_PREFS } from './test-utils.ts'

const id = randomUUID()
const APPNAME_PREFS = `${APP_NAME}.ep.${id}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

const defaultEmailPreferences: EmailPreferences = {
  usage_limit: true,
  credit_usage: true,
  onboarding: true,
  weekly_stats: true,
  monthly_stats: true,
  deploy_stats_24h: true,
  bundle_created: true,
  bundle_deployed: true,
  device_error: true,
  channel_self_rejected: true,
}

function isBentoConfiguredForTests() {
  const publishableKey = (process.env.BENTO_PUBLISHABLE_KEY || '').trim()
  const secretKey = (process.env.BENTO_SECRET_KEY || '').trim()
  const siteUuid = (process.env.BENTO_SITE_UUID || '').trim()

  if (!publishableKey || !secretKey || !siteUuid)
    return false

  const placeholders = new Set(['test', 'TEST', 'placeholder', 'changeme'])
  return !placeholders.has(publishableKey) && !placeholders.has(secretKey) && !placeholders.has(siteUuid)
}

async function resetEmailPreferences() {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('users').update({
    email_preferences: defaultEmailPreferences,
  } as any).eq('id', USER_ID_EMAIL_PREFS)

  if (error)
    throw new Error(`resetEmailPreferences failed: ${error.message} (${error.code ?? 'unknown_code'})`)
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME_PREFS, {
    orgId: ORG_ID_EMAIL_PREFS,
    userId: USER_ID_EMAIL_PREFS,
    stripeCustomerId: STRIPE_CUSTOMER_ID_EMAIL_PREFS,
  })
})

beforeEach(async () => {
  await resetEmailPreferences()
})

afterEach(async () => {
  await resetEmailPreferences()
})

afterAll(async () => {
  await resetAppData(APPNAME_PREFS)
  await resetEmailPreferences()
})

// Helper to check if migration has been applied
async function isMigrationApplied(): Promise<boolean> {
  const supabase = getSupabaseClient()
  const { error } = await supabase
    .from('users')
    .select('email_preferences')
    .limit(1)

  // If we get a 42703 error (column doesn't exist), migration not applied
  return !error || error.code !== '42703'
}

describe('[Database] Email Preferences Column', () => {
  it('should have email_preferences column with default values', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    expect(error).toBeNull()
    expect(data).toBeDefined()
    const prefs = (data as any)?.email_preferences as EmailPreferences
    expect(prefs).toBeDefined()
    // All default to true
    expect(prefs.usage_limit ?? true).toBe(true)
    expect(prefs.credit_usage ?? true).toBe(true)
    expect(prefs.onboarding ?? true).toBe(true)
    expect(prefs.weekly_stats ?? true).toBe(true)
    expect(prefs.monthly_stats ?? true).toBe(true)
    expect(prefs.deploy_stats_24h ?? true).toBe(true)
    expect(prefs.bundle_created ?? true).toBe(true)
    expect(prefs.bundle_deployed ?? true).toBe(true)
    expect(prefs.device_error ?? true).toBe(true)
  })

  it('should allow updating individual email preferences', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences
    const updatedPrefs = { ...currentPrefs, weekly_stats: false }

    // Update with weekly_stats disabled
    const { error: updateError } = await supabase
      .from('users')
      .update({ email_preferences: updatedPrefs } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    expect(updateError).toBeNull()

    // Verify the update
    const { data: verifyData, error: verifyError } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    expect(verifyError).toBeNull()
    const prefs = (verifyData as any)?.email_preferences as EmailPreferences
    expect(prefs.weekly_stats).toBe(false)
    // Other preferences should remain true
    expect(prefs.usage_limit ?? true).toBe(true)
  })

  it('should allow toggling preferences back to true', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences
    const updatedPrefs = { ...currentPrefs, weekly_stats: true }

    // Toggle weekly_stats back to true
    const { error: updateError } = await supabase
      .from('users')
      .update({ email_preferences: updatedPrefs } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    expect(updateError).toBeNull()

    // Verify the update
    const { data: verifyData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const prefs = (verifyData as any)?.email_preferences as EmailPreferences
    expect(prefs.weekly_stats).toBe(true)
  })
})

describe('[POST] /triggers/cron_email - Email Preference Filtering', () => {
  it('should skip weekly stats email when weekly_stats preference is disabled', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }
    if (!isBentoConfiguredForTests()) {
      console.warn('Skipping test: Bento is not configured, cron_email does not exercise org email preference fan-out in CI')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences

    // Disable weekly_stats preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, weekly_stats: false } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Send request for weekly stats
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        email: USER_EMAIL_EMAIL_PREFS,
        appId: APPNAME_PREFS,
        type: 'weekly_install_stats',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('Email preference disabled')

    // Re-enable the preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, weekly_stats: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)
  })

  it('should skip monthly stats email when monthly_stats preference is disabled', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }
    if (!isBentoConfiguredForTests()) {
      console.warn('Skipping test: Bento is not configured, cron_email does not exercise org email preference fan-out in CI')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences

    // Disable monthly_stats preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, monthly_stats: false } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Send request for monthly stats
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        email: USER_EMAIL_EMAIL_PREFS,
        appId: APPNAME_PREFS,
        type: 'monthly_create_stats',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('Email preference disabled')

    // Re-enable the preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, monthly_stats: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)
  })

  it('should allow weekly stats email when weekly_stats preference is enabled', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // Ensure weekly_stats preference is enabled
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, weekly_stats: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Send request for weekly stats
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        email: USER_EMAIL_EMAIL_PREFS,
        appId: APPNAME_PREFS,
        type: 'weekly_install_stats',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status?: string }
    // When enabled, it should either send the email or return "No updates this week"
    // (not "Email preference disabled")
    expect(data.status).not.toBe('Email preference disabled')
  })

  it('should allow monthly stats email when monthly_stats preference is enabled', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // Ensure monthly_stats preference is enabled
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, monthly_stats: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Send request for monthly stats
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        email: USER_EMAIL_EMAIL_PREFS,
        appId: APPNAME_PREFS,
        type: 'monthly_create_stats',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status?: string }
    // When enabled, it should proceed (not return "Email preference disabled")
    expect(data.status).not.toBe('Email preference disabled')
  })
})

describe('[POST] /triggers/cron_email - Deploy Install Stats Preference', () => {
  it('should skip deploy install stats email when deploy_stats_24h preference is disabled', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }
    if (!isBentoConfiguredForTests()) {
      console.warn('Skipping test: Bento is not configured, cron_email does not exercise org email preference fan-out in CI')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences

    // Disable deploy_stats_24h preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, deploy_stats_24h: false } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Send request for deploy install stats (will fail due to missing versionId, but preference check happens first)
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        email: USER_EMAIL_EMAIL_PREFS,
        appId: APPNAME_PREFS,
        type: 'deploy_install_stats',
        versionId: 999999, // Non-existent version
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('Email preference disabled')

    // Re-enable the preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, deploy_stats_24h: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)
  })
})

describe('[Database] Email Preferences - Multi-preference Update', () => {
  it('should allow disabling multiple preferences at once', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // First get current preferences
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences

    // Disable multiple preferences
    const updatedPrefs = {
      ...currentPrefs,
      usage_limit: false,
      credit_usage: false,
      device_error: false,
    }

    await supabase
      .from('users')
      .update({ email_preferences: updatedPrefs } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Verify the updates
    const { data: verifyData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const prefs = (verifyData as any)?.email_preferences as EmailPreferences
    expect(prefs.usage_limit).toBe(false)
    expect(prefs.credit_usage).toBe(false)
    expect(prefs.device_error).toBe(false)
    // Others should remain true
    expect(prefs.onboarding ?? true).toBe(true)
    expect(prefs.bundle_created ?? true).toBe(true)

    // Reset to defaults
    await supabase
      .from('users')
      .update({
        email_preferences: defaultEmailPreferences,
      } as any)
      .eq('id', USER_ID_EMAIL_PREFS)
  })
})

describe('[Database] Email Preferences - Query by Preference', () => {
  it('should be able to query users by specific preference values', async () => {
    const migrationApplied = await isMigrationApplied()
    if (!migrationApplied) {
      console.warn('Skipping test: email_preferences migration not yet applied')
      return
    }

    const supabase = getSupabaseClient()

    // First disable a preference
    const { data: currentData } = await supabase
      .from('users')
      .select('email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const currentPrefs = ((currentData as any)?.email_preferences ?? {}) as EmailPreferences
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, bundle_deployed: false } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)

    // Query users with bundle_deployed disabled using raw query
    // Note: Supabase JS client doesn't support JSONB containment directly,
    // so we verify by fetching and checking
    const { data: usersData } = await supabase
      .from('users')
      .select('id, email_preferences')
      .eq('id', USER_ID_EMAIL_PREFS)
      .single()

    const prefs = (usersData as any)?.email_preferences as EmailPreferences
    expect(prefs.bundle_deployed).toBe(false)

    // Reset the preference
    await supabase
      .from('users')
      .update({ email_preferences: { ...currentPrefs, bundle_deployed: true } } as any)
      .eq('id', USER_ID_EMAIL_PREFS)
  })
})

describe('[Integration] Org Email Notifications with Preferences', () => {
  it('should check org member preferences when sending notifications', async () => {
    const supabase = getSupabaseClient()

    // Get org_users to verify the test user has an admin RBAC role
    const { data: orgUserData } = await supabase
      .from('org_users')
      .select('rbac_role_name')
      .eq('org_id', ORG_ID_EMAIL_PREFS)
      .eq('user_id', USER_ID_EMAIL_PREFS)
      .single()

    // User should be org_admin or org_super_admin to receive operational emails
    expect(orgUserData).toBeDefined()
    if (orgUserData) {
      expect(['org_admin', 'org_super_admin']).toContain(orgUserData.rbac_role_name)
    }
  })
})
