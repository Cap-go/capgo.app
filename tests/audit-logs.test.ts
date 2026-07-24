import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeParseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'

import { BASE_URL, createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, getAuthHeaders, getSupabaseClient, TEST_EMAIL, USER_ID } from './test-utils.ts'

const ORG_ID = randomUUID()
const globalId = randomUUID()
const name = `Test Audit Organization ${globalId}`
const customerId = `cus_audit_${ORG_ID}`
const APIKEY_AUDIT_APP_ID = `com.audit.logs.${globalId.replace(/-/g, '')}`

// Schema for audit log response
const auditLogSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  table_name: z.string(),
  record_id: z.string(),
  operation: z.string(),
  user_id: z.string().nullable(),
  org_id: z.string(),
  old_record: z.unknown(),
  new_record: z.unknown(),
  changed_fields: z.array(z.string()).nullable(),
  actor_type: z.enum(['user', 'apikey', 'system', 'unknown']),
  actor_user_id: z.string().nullable(),
  actor_user_email: z.string().nullable(),
  actor_apikey_id: z.number().nullable(),
  actor_apikey_name: z.string().nullable(),
})

const auditLogsResponseSchema = z.object({
  data: z.array(auditLogSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
})

interface AuditLog {
  id: number
  created_at: string
  table_name: string
  record_id: string
  operation: string
  user_id: string | null
  org_id: string
  old_record: unknown
  new_record: unknown
  changed_fields: string[] | null
  actor_type: 'user' | 'apikey' | 'system' | 'unknown'
  actor_user_id: string | null
  actor_user_email: string | null
  actor_apikey_id: number | null
  actor_apikey_name: string | null
}

function parseAuditLogsResponse(value: unknown) {
  return safeParseSchema(auditLogsResponseSchema, value)
}

let authHeaders: Record<string, string>
let apiKeyAuthHeaders: Record<string, string>
let apiKeyId: number | null = null
let actorUserEmail: string

async function waitForAuditLog(
  url: string,
  matcher: (log: AuditLog) => boolean,
  maxAttempts = 8,
  delayMs = 200,
) {
  let lastStatus = 0
  let lastBody: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchTestRequest(url, {
      headers: authHeaders,
    })
    lastStatus = response.status
    lastBody = await response.json()

    if (response.status === 200) {
      const safe = parseAuditLogsResponse(lastBody)
      if (safe.success) {
        const matchedLog = safe.data.data.find(matcher)
        if (matchedLog)
          return matchedLog
      }
    }

    if (attempt < maxAttempts - 1)
      await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)))
  }

  throw new Error(`Audit log did not reach expected state. Last status: ${lastStatus}. Last body: ${JSON.stringify(lastBody)}`)
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()

  const { data: actorUser, error: actorUserError } = await getSupabaseClient()
    .from('users')
    .select('email')
    .eq('id', USER_ID)
    .single()
  if (actorUserError || !actorUser)
    throw actorUserError ?? new Error('Failed to load audit actor user')
  actorUserEmail = actorUser.email

  // Create stripe_info for this test org
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: customerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${globalId}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  // Create test organization (this should trigger an INSERT audit log via the trigger)
  const { error } = await getSupabaseClient().from('orgs').insert({
    id: ORG_ID,
    name,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (error)
    throw error

  // Ensure the creator is a member; org creation side-effects can be async in CI.
  // The /organization/audit endpoint requires super_admin rights.
  const { error: memberError } = await getSupabaseClient().from('org_users').insert({
    org_id: ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin',
  })
  if (memberError)
    throw memberError

  const { error: appError } = await getSupabaseClient().from('apps').insert({
    app_id: APIKEY_AUDIT_APP_ID,
    name: `Audit API App ${globalId}`,
    icon_url: 'https://example.com/icon.png',
    owner_org: ORG_ID,
  })
  if (appError)
    throw appError

  const apiKeyData = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `audit-api-key-${globalId}`,
    orgId: ORG_ID,
    roleName: 'org_admin',
    appId: APIKEY_AUDIT_APP_ID,
    appRoleName: 'app_admin',
  })
  if (!apiKeyData?.id || !apiKeyData.key) {
    throw new Error('Failed to create isolated audit API key')
  }

  apiKeyId = apiKeyData.id
  apiKeyAuthHeaders = {
    'Content-Type': 'application/json',
    'Authorization': apiKeyData.key,
  }
})

afterAll(async () => {
  // Clean up: delete audit logs first (they reference the org)
  await getSupabaseClient().from('audit_logs').delete().eq('org_id', ORG_ID)

  // Clean up test organization and stripe_info
  if (apiKeyId !== null)
    await getSupabaseClient().from('apikeys').delete().eq('id', apiKeyId)
  await getSupabaseClient().from('app_versions').delete().eq('app_id', APIKEY_AUDIT_APP_ID)
  await getSupabaseClient().from('apps').delete().eq('app_id', APIKEY_AUDIT_APP_ID)
  await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
}, 60_000)

describe('[GET] /organization/audit', () => {
  it('get audit logs for organization', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      expect(safe.data.page).toBe(0)
      expect(safe.data.limit).toBe(50)
      expect(Array.isArray(safe.data.data)).toBe(true)
    }
  })

  it('get audit logs with pagination', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&page=0&limit=10`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      expect(safe.data.page).toBe(0)
      expect(safe.data.limit).toBe(10)
    }
  })

  it('get audit logs filtered by table name', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=orgs`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      // All returned logs should be for the 'orgs' table
      for (const log of safe.data.data) {
        expect(log.table_name).toBe('orgs')
      }
    }
  })

  it('get audit logs filtered by operation', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&operation=INSERT`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      // All returned logs should be INSERT operations
      for (const log of safe.data.data) {
        expect(log.operation).toBe('INSERT')
      }
    }
  })

  it('get audit logs with combined filters', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=orgs&operation=INSERT`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      for (const log of safe.data.data) {
        expect(log.table_name).toBe('orgs')
        expect(log.operation).toBe('INSERT')
      }
    }
  })

  it('limit is capped at 100', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&limit=200`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success) {
      // Server should cap limit at 100
      expect(safe.data.limit).toBe(100)
    }
  })

  it('get audit logs with missing orgId returns error', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('get audit logs with invalid orgId returns error', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${invalidOrgId}`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_org_id')
  })

  it('audit logs keep org and user snapshots without foreign keys', async () => {
    const orphanOrgId = randomUUID()
    const orphanUserId = randomUUID()
    const rows = await executeSQL(
      `
      INSERT INTO public.audit_logs (
        table_name,
        record_id,
        operation,
        user_id,
        org_id,
        actor_type,
        actor_user_id,
        actor_user_email
      )
      VALUES ('orgs', $1::text, 'DELETE', $2::uuid, $1::uuid, 'user', $2::uuid, $3::text)
      RETURNING id, org_id, user_id, actor_type, actor_user_email
      `,
      [orphanOrgId, orphanUserId, 'deleted-user@example.com'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].org_id).toBe(orphanOrgId)
    expect(rows[0].user_id).toBe(orphanUserId)
    expect(rows[0].actor_type).toBe('user')
    expect(rows[0].actor_user_email).toBe('deleted-user@example.com')

    await executeSQL('DELETE FROM public.audit_logs WHERE id = $1', [rows[0].id])
  })
})

describe('audit log triggers', () => {
  it('organization UPDATE creates audit log with changed_fields', async () => {
    const newName = `Updated Audit Organization ${randomUUID()}`

    // Update the organization
    const { error: updateError } = await getSupabaseClient()
      .from('orgs')
      .update({ name: newName })
      .eq('id', ORG_ID)
    expect(updateError).toBeNull()

    // Wait a bit for the trigger to execute
    await new Promise(resolve => setTimeout(resolve, 100))

    // Fetch audit logs for this org
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=orgs&operation=UPDATE`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)
    if (safe.success)
      expect(safe.data.data.length).toBeGreaterThan(0)

    if (safe.success && safe.data.data.length > 0) {
      const latestUpdate = safe.data.data[0]
      expect(latestUpdate.operation).toBe('UPDATE')
      expect(latestUpdate.table_name).toBe('orgs')
      expect(latestUpdate.record_id).toBe(ORG_ID)
      expect(latestUpdate.org_id).toBe(ORG_ID)
      expect(latestUpdate.actor_type).toBe('system')
      expect(latestUpdate.actor_user_id).toBeNull()
      expect(latestUpdate.actor_user_email).toBeNull()
      // Changed fields should include 'name' and 'updated_at'
      expect(Array.isArray(latestUpdate.changed_fields)).toBe(true)
      expect(latestUpdate.changed_fields).toContain('name')
      // old_record should have the old name
      expect(latestUpdate.old_record).toBeTruthy()
      // new_record should have the new name
      expect(latestUpdate.new_record).toBeTruthy()
      if (latestUpdate.new_record && typeof latestUpdate.new_record === 'object') {
        expect((latestUpdate.new_record as Record<string, unknown>).name).toBe(newName)
      }
    }
  })

  it('org_users INSERT creates audit log', async () => {
    // Get another user to add to the org
    const { data: anotherUser, error: userError } = await getSupabaseClient()
      .from('users')
      .select('id')
      .neq('id', USER_ID)
      .limit(1)
      .single()

    expect(userError).toBeNull()
    expect(anotherUser).toBeTruthy()

    if (!anotherUser) {
      console.warn('Skipping test: Could not find another user')
      return
    }

    // Add user to org
    const { error: insertError } = await getSupabaseClient()
      .from('org_users')
      .insert({
        org_id: ORG_ID,
        user_id: anotherUser.id,
        rbac_role_name: 'org_member',
      })
    expect(insertError).toBeNull()

    // Wait a bit for the trigger to execute
    await new Promise(resolve => setTimeout(resolve, 100))

    // Fetch audit logs
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=org_users&operation=INSERT`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)

    if (safe.success && safe.data.data.length > 0) {
      const latestInsert = safe.data.data[0]
      expect(latestInsert.operation).toBe('INSERT')
      expect(latestInsert.table_name).toBe('org_users')
      expect(latestInsert.org_id).toBe(ORG_ID)
      expect(latestInsert.old_record).toBeNull() // INSERT has no old record
      expect(latestInsert.new_record).toBeTruthy()
    }

    // Clean up: delete the org_user
    await getSupabaseClient()
      .from('org_users')
      .delete()
      .eq('org_id', ORG_ID)
      .eq('user_id', anotherUser.id)
  })

  it('org_users DELETE creates audit log', async () => {
    // Get another user to add and then remove
    const { data: anotherUser, error: userError } = await getSupabaseClient()
      .from('users')
      .select('id')
      .neq('id', USER_ID)
      .limit(1)
      .single()

    expect(userError).toBeNull()
    expect(anotherUser).toBeTruthy()

    if (!anotherUser) {
      console.warn('Skipping test: Could not find another user')
      return
    }

    // Add user to org
    const { error: insertError } = await getSupabaseClient()
      .from('org_users')
      .insert({
        org_id: ORG_ID,
        user_id: anotherUser.id,
        rbac_role_name: 'org_member',
      })
    expect(insertError).toBeNull()

    // Wait for insert trigger
    await new Promise(resolve => setTimeout(resolve, 100))

    // Delete the org_user
    const { error: deleteError } = await getSupabaseClient()
      .from('org_users')
      .delete()
      .eq('org_id', ORG_ID)
      .eq('user_id', anotherUser.id)
    expect(deleteError).toBeNull()

    // Wait for delete trigger
    await new Promise(resolve => setTimeout(resolve, 100))

    // Fetch audit logs for DELETE
    const response = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=org_users&operation=DELETE`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)
    const responseData = await response.json()
    const safe = parseAuditLogsResponse(responseData)
    expect(safe.success).toBe(true)

    if (safe.success && safe.data.data.length > 0) {
      const latestDelete = safe.data.data[0]
      expect(latestDelete.operation).toBe('DELETE')
      expect(latestDelete.table_name).toBe('org_users')
      expect(latestDelete.org_id).toBe(ORG_ID)
      expect(latestDelete.new_record).toBeNull() // DELETE has no new record
      expect(latestDelete.old_record).toBeTruthy()
    }
  })
})

// These tests verify that audit logs are created when using API key authentication
// This was a bug where CLI/API users were not logged because request identity resolution missed API keys.
describe('audit logs for app_versions via API key', () => {
  const testVersionName = `99.0.0-audit-test-${randomUUID()}`
  let createdVersionId: number | null = null

  afterAll(async () => {
    // Clean up: delete the test version if it was created
    if (createdVersionId) {
      await getSupabaseClient().from('app_versions').delete().eq('id', createdVersionId)
      // Also clean up any audit logs for this version
      await getSupabaseClient().from('audit_logs').delete().eq('record_id', createdVersionId.toString())
    }
  })

  it('app_version INSERT via API creates audit log with user_id from API key', async () => {
    // Create a bundle via the API (uses API key authentication)
    const response = await fetchTestRequest(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers: apiKeyAuthHeaders,
      body: JSON.stringify({
        app_id: APIKEY_AUDIT_APP_ID,
        version: testVersionName,
        external_url: 'https://example.com/test-audit-bundle.zip',
        checksum: 'abc123def456',
      }),
    })

    expect(response.status).toBe(200)
    const responseData = await response.json() as { status: string, bundle: { id: number } }
    expect(responseData.status).toBe('success')
    expect(responseData.bundle).toBeTruthy()
    createdVersionId = responseData.bundle.id

    // Wait for the trigger to execute
    await new Promise(resolve => setTimeout(resolve, 200))

    // Fetch audit logs for the dedicated test org
    const auditResponse = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=app_versions&operation=INSERT`, {
      headers: authHeaders,
    })
    expect(auditResponse.status).toBe(200)
    const auditData = await auditResponse.json()
    const safe = parseAuditLogsResponse(auditData)
    expect(safe.success).toBe(true)

    if (safe.success) {
      // Find the audit log for our created version
      const versionAuditLog = safe.data.data.find(
        log => log.record_id === createdVersionId?.toString(),
      )

      expect(versionAuditLog).toBeTruthy()
      if (versionAuditLog) {
        expect(versionAuditLog.operation).toBe('INSERT')
        expect(versionAuditLog.table_name).toBe('app_versions')
        expect(versionAuditLog.org_id).toBe(ORG_ID)
        // This is the key assertion: user_id should be set from the API key
        expect(versionAuditLog.user_id).toBe(USER_ID)
        expect(versionAuditLog.actor_type).toBe('apikey')
        expect(versionAuditLog.actor_user_id).toBe(USER_ID)
        expect(versionAuditLog.actor_user_email).toBe(actorUserEmail)
        expect(versionAuditLog.actor_apikey_id).toBe(apiKeyId)
        expect(versionAuditLog.actor_apikey_name).toContain('audit-api-key-')
        expect(versionAuditLog.old_record).toBeNull()
        expect(versionAuditLog.new_record).toBeTruthy()
        if (versionAuditLog.new_record && typeof versionAuditLog.new_record === 'object') {
          expect((versionAuditLog.new_record as Record<string, unknown>).name).toBe(testVersionName)
          // Fat columns must stay out of audit TOAST to protect primary DB memory.
          expect((versionAuditLog.new_record as Record<string, unknown>).manifest).toBeUndefined()
          expect((versionAuditLog.new_record as Record<string, unknown>).native_packages).toBeUndefined()
        }
      }
    }
  })

  it('app_version UPDATE via API creates audit log with user_id from API key', async () => {
    // Skip if we don't have a version to update
    if (!createdVersionId) {
      console.warn('Skipping UPDATE test: no version was created')
      return
    }

    // Update the bundle via the API - note: endpoint requires version_id (number), not version name
    const response = await fetchTestRequest(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers: apiKeyAuthHeaders,
      body: JSON.stringify({
        app_id: APIKEY_AUDIT_APP_ID,
        version_id: createdVersionId,
        comment: 'Updated via API key test',
      }),
    })

    expect(response.status).toBe(200)

    const updateAuditLog = await waitForAuditLog(
      `${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=app_versions&operation=UPDATE`,
      log => log.record_id === createdVersionId?.toString() && log.changed_fields?.includes('comment') === true,
    )

    expect(updateAuditLog.operation).toBe('UPDATE')
    expect(updateAuditLog.table_name).toBe('app_versions')
    expect(updateAuditLog.org_id).toBe(ORG_ID)
    // user_id should be set from the API key
    expect(updateAuditLog.user_id).toBe(USER_ID)
    expect(updateAuditLog.actor_type).toBe('apikey')
    expect(updateAuditLog.actor_user_id).toBe(USER_ID)
    expect(updateAuditLog.actor_user_email).toBe(actorUserEmail)
    expect(updateAuditLog.actor_apikey_id).toBe(apiKeyId)
    expect(updateAuditLog.old_record).toBeTruthy()
    expect(updateAuditLog.new_record).toBeTruthy()
    // changed_fields should include 'comment'
    expect(Array.isArray(updateAuditLog.changed_fields)).toBe(true)
    expect(updateAuditLog.changed_fields).toContain('comment')
  })

  it('app_version soft-DELETE via API creates UPDATE audit log with user_id from API key', async () => {
    // Skip if we don't have a version to delete
    if (!createdVersionId) {
      console.warn('Skipping DELETE test: no version was created')
      return
    }

    const versionIdToDelete = createdVersionId

    // Delete the bundle via the API - note: this is a soft-delete (sets deleted=true)
    const response = await fetchTestRequest(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers: apiKeyAuthHeaders,
      body: JSON.stringify({
        app_id: APIKEY_AUDIT_APP_ID,
        version: testVersionName,
      }),
    })

    expect(response.status).toBe(200)

    // Wait for the trigger to execute
    await new Promise(resolve => setTimeout(resolve, 200))

    // Fetch audit logs for UPDATE operations (soft-delete creates UPDATE, not DELETE)
    const auditResponse = await fetchTestRequest(`${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=app_versions&operation=UPDATE`, {
      headers: authHeaders,
    })
    expect(auditResponse.status).toBe(200)
    const auditData = await auditResponse.json()
    const safe = parseAuditLogsResponse(auditData)
    expect(safe.success).toBe(true)

    if (safe.success) {
      // Find the audit log for our soft-deleted version:app_versions!channels_version_fkey(look for 'deleted' in changed_fields)
      const deleteAuditLog = safe.data.data.find(
        log => log.record_id === versionIdToDelete.toString()
          && log.changed_fields?.includes('deleted'),
      )

      expect(deleteAuditLog).toBeTruthy()
      if (deleteAuditLog) {
        expect(deleteAuditLog.operation).toBe('UPDATE')
        expect(deleteAuditLog.table_name).toBe('app_versions')
        expect(deleteAuditLog.org_id).toBe(ORG_ID)
        // user_id should be set from the API key
        expect(deleteAuditLog.user_id).toBe(USER_ID)
        expect(deleteAuditLog.actor_type).toBe('apikey')
        expect(deleteAuditLog.actor_user_id).toBe(USER_ID)
        expect(deleteAuditLog.actor_user_email).toBe(actorUserEmail)
        expect(deleteAuditLog.actor_apikey_id).toBe(apiKeyId)
        // Both old and new record should exist for UPDATE
        expect(deleteAuditLog.old_record).toBeTruthy()
        expect(deleteAuditLog.new_record).toBeTruthy()
        // changed_fields should include 'deleted'
        expect(deleteAuditLog.changed_fields).toContain('deleted')
        // Verify the deleted flag was set to true
        if (deleteAuditLog.new_record && typeof deleteAuditLog.new_record === 'object') {
          expect((deleteAuditLog.new_record as Record<string, unknown>).deleted).toBe(true)
        }
      }
    }
  })
})

describe('audit logs for channel promotions via API key bundle flow', () => {
  const sourceVersionName = `99.0.0-audit-channel-source-${randomUUID()}`
  const targetVersionName = `99.0.0-audit-channel-target-${randomUUID()}`
  const channelName = `audit-channel-${randomUUID()}`
  let sourceVersionId: number | null = null
  let targetVersionId: number | null = null
  let channelId: number | null = null

  beforeAll(async () => {
    const supabase = getSupabaseClient()

    const { data: insertedVersions, error: versionError } = await supabase
      .from('app_versions')
      .insert([
        {
          app_id: APIKEY_AUDIT_APP_ID,
          name: sourceVersionName,
          owner_org: ORG_ID,
        },
        {
          app_id: APIKEY_AUDIT_APP_ID,
          name: targetVersionName,
          owner_org: ORG_ID,
        },
      ])
      .select('id,name')

    if (versionError || !insertedVersions || insertedVersions.length !== 2) {
      throw new Error(`Failed to create audit channel versions: ${versionError?.message ?? 'missing versions'}`)
    }

    sourceVersionId = insertedVersions.find(version => version.name === sourceVersionName)?.id ?? null
    targetVersionId = insertedVersions.find(version => version.name === targetVersionName)?.id ?? null
    if (sourceVersionId === null || targetVersionId === null) {
      throw new Error('Failed to resolve audit channel version IDs')
    }

    const { data: insertedChannel, error: channelError } = await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APIKEY_AUDIT_APP_ID,
        version: sourceVersionId,
        created_by: USER_ID,
        owner_org: ORG_ID,
      })
      .select('id')
      .single()

    if (channelError || !insertedChannel) {
      throw new Error(`Failed to create audit channel: ${channelError?.message ?? 'missing channel'}`)
    }

    channelId = insertedChannel.id
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()

    if (channelId !== null) {
      await supabase.from('channels').delete().eq('id', channelId)
      await supabase.from('audit_logs').delete().eq('record_id', channelId.toString()).eq('table_name', 'channels')
    }

    if (sourceVersionId !== null) {
      await supabase.from('app_versions').delete().eq('id', sourceVersionId)
    }

    if (targetVersionId !== null) {
      await supabase.from('app_versions').delete().eq('id', targetVersionId)
    }
  })

  it('channel UPDATE via API key bundle promotion keeps audit user_id attribution', async () => {
    if (!channelId || !targetVersionId) {
      throw new Error('Audit channel promotion test setup did not complete')
    }
    const promotionChannelId = channelId

    const response = await fetchTestRequest(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers: apiKeyAuthHeaders,
      body: JSON.stringify({
        app_id: APIKEY_AUDIT_APP_ID,
        version_id: targetVersionId,
        channel_id: promotionChannelId,
      }),
    })

    expect(response.status).toBe(200)

    const promotionAuditLog = await waitForAuditLog(
      `${BASE_URL}/organization/audit?orgId=${ORG_ID}&tableName=channels&operation=UPDATE`,
      log => log.record_id === promotionChannelId.toString() && log.changed_fields?.includes('version') === true,
    )

    expect(promotionAuditLog.operation).toBe('UPDATE')
    expect(promotionAuditLog.table_name).toBe('channels')
    expect(promotionAuditLog.org_id).toBe(ORG_ID)
    expect(promotionAuditLog.user_id).toBe(USER_ID)
    expect(promotionAuditLog.actor_type).toBe('apikey')
    expect(promotionAuditLog.actor_user_id).toBe(USER_ID)
    expect(promotionAuditLog.actor_user_email).toBe(actorUserEmail)
    expect(promotionAuditLog.actor_apikey_id).toBe(apiKeyId)
    expect(promotionAuditLog.changed_fields).toContain('version')

    if (promotionAuditLog.new_record && typeof promotionAuditLog.new_record === 'object') {
      expect((promotionAuditLog.new_record as Record<string, unknown>).version).toBe(targetVersionId)
    }
  })
})
