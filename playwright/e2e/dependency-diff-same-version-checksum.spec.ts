import type { Page, Route } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/commands'

const APP_ID = 'com.demo.app'
const CURRENT_VERSION_ID = 5000
const PREVIOUS_VERSION_ID = 4000

interface NativePackage {
  name: string
  version: string
  requested_version: string
  native: boolean
  ios_checksum: string
  android_checksum: string
}

interface AppVersion {
  id: number
  name: string
  app_id: string
  deleted: boolean
  manifest_count: number
  created_at: string
  native_packages: NativePackage[]
}

const mockVersions: AppVersion[] = [
  {
    id: CURRENT_VERSION_ID,
    app_id: APP_ID,
    name: '2.1.0',
    deleted: false,
    manifest_count: 4,
    created_at: '2026-06-17T10:00:00.000Z',
    native_packages: [
      {
        name: '@capacitor/camera',
        version: '8.1.0',
        requested_version: '8.1.x',
        native: true,
        ios_checksum: 'current-ios-hash-with-diff',
        android_checksum: 'android-stable-hash',
      },
      {
        name: '@capacitor/core',
        version: '8.1.0',
        requested_version: '8.1.0',
        native: true,
        ios_checksum: 'core-current-ios',
        android_checksum: 'core-candidate-android-hash',
      },
    ],
  },
  {
    id: PREVIOUS_VERSION_ID,
    app_id: APP_ID,
    name: '2.0.0',
    deleted: false,
    manifest_count: 4,
    created_at: '2026-06-10T10:00:00.000Z',
    native_packages: [
      {
        name: '@capacitor/camera',
        version: '8.1.0',
        requested_version: '^8.1.0',
        native: true,
        ios_checksum: 'previous-ios-hash-here',
        android_checksum: 'android-stable-hash',
      },
      {
        name: '@capacitor/core',
        version: '8.1.0',
        requested_version: '^8.1.0',
        native: true,
        ios_checksum: 'core-previous-ios',
        android_checksum: 'core-baseline-android-hash',
      },
    ],
  },
]

type FilterValue
  = { type: 'eq', value: string }
    | { type: 'neq', value: string }
    | { type: 'ilike', value: string }
    | { type: 'isNotNull', value: true }
    | { type: 'isNull', value: true }
    | { type: 'in', value: number[] }
    | { type: 'raw', value: string }

function getFilterValue(params: URLSearchParams, key: string): FilterValue | undefined {
  const value = params.get(key)
  if (!value)
    return undefined
  if (value.startsWith('eq.'))
    return { type: 'eq', value: value.slice(3) }
  if (value.startsWith('neq.'))
    return { type: 'neq', value: value.slice(4) }
  if (value.startsWith('ilike.'))
    return { type: 'ilike', value: value.slice(6) }
  if (value === 'not.is.null')
    return { type: 'isNotNull', value: true }
  if (value === 'is.null')
    return { type: 'isNull', value: true }
  if (value.startsWith('in.(') && value.endsWith(')')) {
    const parsed = value
      .slice(3, -1)
      .split(',')
      .map(part => Number(part.trim()))
      .filter(value => !Number.isNaN(value))
    return { type: 'in', value: parsed }
  }
  return { type: 'raw', value }
}

function filterAppVersions(requestUrl: string, acceptHeader: string) {
  const url = new URL(requestUrl)
  const params = url.searchParams
  let rows = [...mockVersions]

  const appFilter = getFilterValue(params, 'app_id')
  if (appFilter?.type === 'eq')
    rows = rows.filter(row => row.app_id === appFilter.value)

  const idFilter = getFilterValue(params, 'id')
  if (idFilter?.type === 'eq')
    rows = rows.filter(row => row.id === Number(idFilter.value))
  if (idFilter?.type === 'neq')
    rows = rows.filter(row => row.id !== Number(idFilter.value))
  if (idFilter?.type === 'in')
    rows = rows.filter(row => idFilter.value.includes(row.id))

  const deletedFilter = getFilterValue(params, 'deleted')
  if (deletedFilter?.type === 'eq')
    rows = rows.filter(row => row.deleted === (deletedFilter.value === 'true'))

  const nativeFilter = getFilterValue(params, 'native_packages')
  if (nativeFilter?.type === 'isNotNull')
    rows = rows.filter(row => row.native_packages !== null)

  const nameFilter = getFilterValue(params, 'name')
  if (nameFilter?.type === 'ilike') {
    const pattern = nameFilter.value.replaceAll('%', '')
    rows = rows.filter(row => row.name.includes(pattern))
  }

  const order = params.get('order')
  if (order?.startsWith('created_at.')) {
    const direction = order.endsWith('.desc') ? 'desc' : 'asc'
    rows = [...rows].sort((a, b) => {
      return direction === 'desc'
        ? b.created_at.localeCompare(a.created_at)
        : a.created_at.localeCompare(b.created_at)
    })
  }

  const limit = params.get('limit')
  if (limit)
    rows = rows.slice(0, Number(limit))

  const isSingle = acceptHeader.includes('application/vnd.pgrst.object+json')
  if (isSingle)
    return rows[0] ?? null

  return rows
}

function routeToObject(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload ?? []),
  })
}

function mockRestTable(page: Page) {
  return page.route('**/private/console/query', async (route) => {
    const query = route.request().postDataJSON()
    let data: unknown
    if (query.kind === 'rpc' && query.name === 'is_not_deleted') {
      data = true
    }
    else if (query.kind === 'table' && query.name === 'app_versions') {
      const url = new URL('https://fixture.example/app_versions')
      let accept = ''
      for (const { method, args } of query.operations) {
        if (['eq', 'neq', 'ilike', 'is'].includes(method))
          url.searchParams.set(args[0], `${method}.${args[1]}`)
        else if (method === 'not')
          url.searchParams.set(args[0], `not.${args[1]}.${args[2]}`)
        else if (method === 'in')
          url.searchParams.set(args[0], `in.(${args[1].join(',')})`)
        else if (method === 'order')
          url.searchParams.set('order', `${args[0]}.${args[1]?.ascending === false ? 'desc' : 'asc'}`)
        else if (method === 'limit')
          url.searchParams.set('limit', String(args[0]))
        else if (['single', 'maybeSingle'].includes(method))
          accept = 'application/vnd.pgrst.object+json'
      }
      data = filterAppVersions(url.href, accept)
    }
    else if (query.kind === 'table' && ['channels', 'deploy_history'].includes(query.name)) {
      data = []
    }
    else {
      return route.fallback()
    }
    return routeToObject(route, { data, error: null, count: null, status: 200 })
  })
}

test('captures same-version native checksum diff reasons in dependency diff table', async ({ page }) => {
  await mockRestTable(page)
  await page.login('test@capgo.app', 'testtest')
  await page.goto(`/app/${APP_ID}/bundle/${CURRENT_VERSION_ID}/dependencies?compare=${PREVIOUS_VERSION_ID}`)

  await expect(page.getByRole('heading', { name: 'Native Dependencies' })).toBeVisible()
  await expect(page.getByText('Version text is unchanged').first()).toBeVisible()
  await expect(page.getByText(/iOS checksum changed:/).first()).toBeVisible()
  await expect(page.getByText(/Android checksum changed:/).first()).toBeVisible()
  await expect(page.getByText('Declared package constraint changed').first()).toBeVisible()

  const screenshotDir = join(process.cwd(), 'artifacts')
  if (!existsSync(screenshotDir))
    mkdirSync(screenshotDir, { recursive: true })

  await page.screenshot({
    path: join(screenshotDir, 'dependency-diff-same-version-checksum.png'),
    fullPage: true,
  })
})
