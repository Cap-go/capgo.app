import type { BuilderPlatform } from '~/services/builderOnboardingChecklist'
import { APP_ONBOARDING_OTA_V1_STEP_IDS, hasSupportedOtaTodoList, parseAppOnboarding } from '~/services/appOnboarding'
import { BUILDER_STEP_IDS, hasSupportedBuilderTodoList } from '~/services/builderOnboardingChecklist'

export type ChecklistPath = 'ota' | 'builder'
export interface ChecklistPreference {
  path?: ChecklistPath
  platform?: BuilderPlatform
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function hasDualOnboardingChecklists(value: unknown) {
  const setup = record(record(value).setup)
  return setup.todo_list_version === 4
    && hasSupportedOtaTodoList(parseAppOnboarding(value))
    && hasSupportedBuilderTodoList(value)
    && Array.isArray(setup.paths) && setup.paths.includes('ota') && setup.paths.includes('builder')
}

function progress(steps: Record<string, unknown>, ids: readonly string[]) {
  const saved = ids.map(id => record(steps[id]))
  // Pending steps (including initialized timestamps) and tab views are not work.
  const started = saved.filter(step => ['done', 'skipped', 'warning'].includes(String(step.status)))
  return {
    started: started.length > 0,
    complete: saved.every(step => step.status === 'done' || step.status === 'skipped'),
    latest: Math.max(0, ...started.map(step => typeof step.at === 'string' ? Date.parse(step.at) || 0 : 0)),
  }
}

export function resolveDualChecklistResume(value: unknown, preference: ChecklistPreference = {}) {
  const setup = record(record(value).setup)
  const steps = record(setup.steps)
  const ota = progress(record(steps.ota), APP_ONBOARDING_OTA_V1_STEP_IDS)
  const builder = record(steps.builder)
  const platforms = (['ios', 'android'] as const).map((platform) => {
    const saved = record(builder[platform])
    const state = progress(saved, BUILDER_STEP_IDS[platform])
    return { platform, ...state, complete: state.complete && record(saved.successful_cloud_build).status === 'done' }
  })
  const started = platforms.filter(platform => platform.started)
  const unfinished = started.filter(platform => !platform.complete)
  const candidates = unfinished.length ? unfinished : started
  const platform = candidates.find(entry => entry.platform === preference.platform)?.platform
    ?? candidates.find(entry => entry.platform === setup.selected_builder_platform)?.platform
    ?? [...candidates].sort((a, b) => b.latest - a.latest)[0]?.platform
    ?? preference.platform
    ?? (setup.selected_builder_platform === 'ios' || setup.selected_builder_platform === 'android' ? setup.selected_builder_platform : null)
  const builderComplete = started.length > 0 && started.every(entry => entry.complete)
  let path: ChecklistPath | null = null
  if (ota.started || started.length) {
    if (ota.complete !== builderComplete)
      path = ota.complete ? 'builder' : 'ota'
    else if (ota.started && !started.length)
      path = 'ota'
    else if (!ota.started && started.length)
      path = 'builder'
    else
      path = preference.path ?? (setup.selected_path === 'ota' || setup.selected_path === 'builder' ? setup.selected_path : ota.latest >= Math.max(...started.map(entry => entry.latest)) ? 'ota' : 'builder')
  }
  return { path, platform, otaComplete: ota.complete, builderComplete }
}

function preferenceKey(userId: string | null | undefined, appId: string) {
  return userId && appId ? `capgo:onboarding-checklist:${encodeURIComponent(userId)}:${encodeURIComponent(appId)}` : null
}

// Like dashboard exploration preferences, this is browser-local. On another
// device, authoritative step progress and valid saved setup metadata choose.
export function loadChecklistPreference(userId: string | null | undefined, appId: string): ChecklistPreference {
  const key = preferenceKey(userId, appId)
  try {
    const saved = record(JSON.parse(key ? localStorage.getItem(key) ?? '{}' : '{}'))
    return {
      ...(saved.path === 'ota' || saved.path === 'builder' ? { path: saved.path } : {}),
      ...(saved.platform === 'ios' || saved.platform === 'android' ? { platform: saved.platform } : {}),
    }
  }
  catch {
    return {}
  }
}

export function saveChecklistPreference(userId: string | null | undefined, appId: string, preference: ChecklistPreference) {
  const key = preferenceKey(userId, appId)
  try {
    if (key)
      localStorage.setItem(key, JSON.stringify(preference))
  }
  catch {
    // Selection still works when browser storage is blocked.
  }
}
