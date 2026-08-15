import { expect, test } from 'vitest'
import { isAppDashboardPath } from '../src/utils/appDashboardPath'

test('isAppDashboardPath only matches the app overview and its subtabs', () => {
  expect(isAppDashboardPath('/app/com.demo.app')).toBe(true)
  expect(isAppDashboardPath('/app/com.demo.app/')).toBe(true)
  expect(isAppDashboardPath('/app/com.demo.app/native')).toBe(true)
  expect(isAppDashboardPath('/app/com.demo.app/installs')).toBe(true)
  expect(isAppDashboardPath('/app/com.demo.app/active-bundle')).toBe(true)

  expect(isAppDashboardPath('/app/new')).toBe(false)
  expect(isAppDashboardPath('/app/modules')).toBe(false)
  expect(isAppDashboardPath('/app/com.demo.app/observe/native')).toBe(false)
  expect(isAppDashboardPath('/app/com.demo.app/settings')).toBe(false)
  expect(isAppDashboardPath('/app/com.demo.app/bundles')).toBe(false)
  expect(isAppDashboardPath('/app/com.demo.app/getting-started')).toBe(false)
})
