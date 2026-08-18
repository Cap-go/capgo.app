import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  getSupabaseClient,
  headers,
  ORG_ID,
  resetAppData,
  USER_ID_2,
} from './test-utils'

describe('app creation permission tests', () => {
  // Test creating app with a non-existent organization
  describe('creating app with non-existent organization', () => {
    const id = randomUUID()
    const appName = `com.permission.test.${id}`
    const nonExistentOrgId = randomUUID()

    afterAll(async () => {
      await resetAppData(appName)
    })

    it('should fail to create app with non-existent organization', async () => {
      const response = await fetch(`${BASE_URL}/app`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          app_id: appName, // Added app_id for validation
          owner_org: nonExistentOrgId,
          name: appName,
          icon: 'https://cdn.example/test-icon.png',
        }),
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('cannot_access_organization')
    })
  })

  // Test with organization where user has no membership
  describe('creating app with organization user is not a member of', () => {
    let unauthorizedOrgId = ''
    const id = randomUUID()
    const appName = `com.permission.test.${id}`

    // Create a test organization where our test user is not a member
    beforeAll(async () => {
      // Create a new organization with a different owner
      const supabase = getSupabaseClient()
      const { data, error } = await supabase
        .from('orgs')
        .insert({
          name: `Unauthorized Org ${id}`,
          // Use a different user as owner - assuming this is an admin or another test user
          created_by: USER_ID_2, // Different from the user associated with our test API key
          management_email: `test-${id}@example.com`,
        })
        .select()
        .single()

      if (error) {
        console.error('Failed to create test organization:', error)
      }

      if (data) {
        unauthorizedOrgId = data.id
      }
    })

    afterAll(async () => {
      // Clean up
      await resetAppData(appName)

      if (unauthorizedOrgId) {
        const supabase = getSupabaseClient()
        await supabase
          .from('orgs')
          .delete()
          .eq('id', unauthorizedOrgId)
      }
    })

    it('should fail to create app with organization where user is not a member', async () => {
      expect(unauthorizedOrgId).toBeTruthy()

      const response = await fetch(`${BASE_URL}/app`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          app_id: appName, // Added app_id for validation
          owner_org: unauthorizedOrgId,
          name: appName,
          icon: 'https://cdn.example/test-icon.png',
        }),
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('cannot_access_organization')
    })
  })

  // Test with valid organization permissions
  describe('creating app with valid organization permissions', () => {
    const id = randomUUID()
    const appName = `com.permission.test.${id}`

    afterAll(async () => {
      await resetAppData(appName)
    })

    it('should successfully create app with valid organization permissions', async () => {
      const response = await fetch(`${BASE_URL}/app`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          owner_org: ORG_ID, // Using the default test org where the test user has permissions
          name: `App ${appName}`,
          app_id: appName,
          icon: 'https://cdn.example/test-icon.png',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { app_id: string }
      expect(data.app_id).toBe(appName)
    })
  })

  // Test creating app without specifying an organization
  describe('creating app without specifying an organization', () => {
    const id = randomUUID()
    const appName = `com.permission.test.${id}`

    afterAll(async () => {
      await resetAppData(appName)
    })

    it('should fail to create app without organization', async () => {
      const response = await fetch(`${BASE_URL}/app`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          app_id: appName, // Added app_id for validation
          name: appName,
          icon: 'https://cdn.example/test-icon.png',
          // Omitting owner_org
        }),
      })

      expect(response.status).toBe(400)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('missing_owner_org')
    })
  })
})
