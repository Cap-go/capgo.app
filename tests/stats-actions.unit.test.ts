import { describe, expect, it } from 'vitest'
import { actionToFilter, filterToAction, statsActionFilters } from '~/services/statsActions'
import { ALLOWED_STATS_ACTIONS } from '../supabase/functions/_backend/plugin_runtime/plugins/stats_actions.ts'

const HEALTH_STATS_ACTIONS = [
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'app_memory_warning',
  'app_launch_start',
  'app_launch_ready',
  'app_launch_timeout',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
  'webview_dom_content_loaded',
  'webview_page_loaded',
] as const

const NATIVE_VERSION_STATS_ACTIONS = [
  'os_version_changed',
  'native_app_version_changed',
] as const

describe('stats action filters', () => {
  it('keeps the frontend action filters in sync with the backend action enum', () => {
    const frontendFilterKeys = statsActionFilters.map(([filterKey]) => filterKey)
    const frontendActions = statsActionFilters.map(([, action]) => action)

    expect(new Set(frontendFilterKeys).size).toBe(frontendFilterKeys.length)
    expect(new Set(frontendActions).size).toBe(frontendActions.length)
    expect([...frontendActions].sort()).toEqual([...ALLOWED_STATS_ACTIONS].sort())
  })

  it('keeps every app and WebView health action accepted and filterable', () => {
    expect(ALLOWED_STATS_ACTIONS).toEqual(expect.arrayContaining([...HEALTH_STATS_ACTIONS]))

    for (const action of HEALTH_STATS_ACTIONS) {
      const filterKey = actionToFilter[action]

      expect(filterKey).toBeTruthy()
      expect(filterToAction[filterKey]).toBe(action)
    }
  })

  it('keeps native version change actions accepted and filterable', () => {
    expect(ALLOWED_STATS_ACTIONS).toEqual(expect.arrayContaining([...NATIVE_VERSION_STATS_ACTIONS]))

    for (const action of NATIVE_VERSION_STATS_ACTIONS) {
      const filterKey = actionToFilter[action]

      expect(filterKey).toBeTruthy()
      expect(filterToAction[filterKey]).toBe(action)
    }
  })
})
