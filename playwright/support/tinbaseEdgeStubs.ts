import type { Page } from '@playwright/test'

const TINBASE_URL = process.env.TINBASE_URL || process.env.SUPABASE_URL || 'http://127.0.0.1:55321'
const SERVICE_KEY = process.env.TINBASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzg5ODQ3NDYxLCJleHAiOjIxMDUyMDc0NjF9.o8a_69Jdjk-yG5ksvmS9vRWXUqCWGwz1AnCSqt4cXZA'
const TEST_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'
const ORG_ADMIN_ROLE_ID = '39eabda5-1db9-497a-93e9-cd28d19275cd'

function serviceHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

async function servicePost<T>(path: string, body: unknown): Promise<{ ok: boolean, status: number, data: T }> {
  const response = await fetch(`${TINBASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null) as T
  return { ok: response.ok, status: response.status, data }
}

export async function setupTinbaseEdgeStubs(page: Page) {
  await page.route('**/private/sso/check-enforcement', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowed: true }),
    })
  })

  await page.route('**/functions/v1/statistics/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ global: [], byApp: [] }),
    })
  })

  await page.route('**/functions/v1/app', async (route) => {
    if (route.request().method() !== 'POST')
      return route.continue()

    const body = route.request().postDataJSON() as {
      app_id: string
      name: string
      owner_org: string
      need_onboarding?: boolean
      existing_app?: boolean
      ios_store_url?: string | null
      android_store_url?: string | null
    }

    const result = await servicePost<Array<Record<string, unknown>>>('apps', {
      app_id: body.app_id,
      name: body.name,
      owner_org: body.owner_org,
      user_id: TEST_USER_ID,
      icon_url: '',
      need_onboarding: body.need_onboarding ?? true,
      existing_app: body.existing_app ?? false,
      created_from_onboarding: true,
      ios_store_url: body.ios_store_url ?? null,
      android_store_url: body.android_store_url ?? null,
    })

    if (!result.ok) {
      await route.fulfill({
        status: result.status === 409 ? 409 : 500,
        contentType: 'application/json',
        body: JSON.stringify(result.data),
      })
      return
    }

    const app = Array.isArray(result.data) ? result.data[0] : result.data
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(app),
    })
  })

  await page.route('**/functions/v1/apikey', async (route) => {
    if (route.request().method() !== 'POST')
      return route.continue()

    const body = route.request().postDataJSON() as {
      name?: string
      bindings?: Array<{ org_id: string, scope_type: string, role_name?: string, app_id?: string }>
    }

    const orgId = body.bindings?.[0]?.org_id
    if (!orgId) {
      await route.fulfill({ status: 400, body: JSON.stringify({ error: 'missing org' }) })
      return
    }

    const plainKey = `capgo_${crypto.randomUUID().replace(/-/g, '')}`
    const keyResult = await servicePost<Array<Record<string, unknown>>>('apikeys', {
      user_id: TEST_USER_ID,
      key: plainKey,
      name: body.name || 'api-key',
    })

    if (!keyResult.ok || !Array.isArray(keyResult.data) || !keyResult.data[0]) {
      await route.fulfill({ status: 500, body: JSON.stringify(keyResult.data) })
      return
    }

    const apikey = keyResult.data[0]
    const rbacId = apikey.rbac_id as string
    await servicePost('role_bindings', {
      principal_type: 'apikey',
      principal_id: rbacId,
      role_id: ORG_ADMIN_ROLE_ID,
      scope_type: 'org',
      org_id: orgId,
      granted_by: TEST_USER_ID,
    })

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...apikey, key: plainKey, global_permissions: [] }),
    })
  })
}
