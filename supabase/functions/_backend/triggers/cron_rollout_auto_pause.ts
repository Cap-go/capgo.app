import type { AutoPauseAction } from '../utils/rollout.ts'
import { BRES, createHono, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { evaluateAutoPausePolicy } from '../utils/rollout.ts'
import { readStatsVersion } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { version } from '../utils/version.ts'

interface RolloutAutoPauseChannel {
  app_id: string
  auto_pause_action: string
  auto_pause_confidence: number | string
  auto_pause_cooldown_minutes: number
  auto_pause_enabled: boolean
  auto_pause_failure_rate_bps: number | null
  auto_pause_last_triggered_at: string | null
  rollout_paused_at: string | null
  auto_pause_min_attempts: number | null
  auto_pause_min_failures: number | null
  auto_pause_window_minutes: number
  id: number
  name: string
  owner_org: string
  rollout_version: number
  rollout_version_info?: { name: string } | { name: string }[] | null
}

export const app = createHono('', version)
const AUTO_PAUSE_CHANNEL_PAGE_SIZE = 1000

function normalizeAction(action: string): AutoPauseAction {
  if (action === 'rollback' || action === 'notify')
    return action
  return 'pause'
}

function getRolloutVersionName(channel: RolloutAutoPauseChannel): string | null {
  const relation = channel.rollout_version_info
  if (!relation)
    return null
  if (Array.isArray(relation))
    return relation[0]?.name ?? null
  return relation.name ?? null
}

function getWindowStart(windowMinutes: number, now: Date): string {
  const minutes = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString()
}

function buildReason(channel: RolloutAutoPauseChannel, versionName: string, result: ReturnType<typeof evaluateAutoPausePolicy>) {
  return `Auto-pause ${result.action} for ${channel.name} rollout ${versionName}: fail ${result.failureRateBps}bps, confidence lower bound ${result.lowerBoundBps}bps, threshold ${result.thresholdBps}bps, attempts ${result.attempts}.`
}

async function updateCurrentRolloutChannel(supabase: ReturnType<typeof supabaseAdmin>, channel: RolloutAutoPauseChannel, patch: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('channels')
    .update(patch as any)
    .eq('id', channel.id)
    .eq('rollout_version', channel.rollout_version)
    .eq('rollout_enabled', true)
    .gt('rollout_percentage_bps', 0)
    .is('rollout_paused_at', null)
    .select('id')
    .maybeSingle()

  if (error)
    throw error

  return Boolean(data)
}

async function evaluateChannel(c: Parameters<typeof supabaseAdmin>[0], supabase: ReturnType<typeof supabaseAdmin>, channel: RolloutAutoPauseChannel, now: Date) {
  const versionName = getRolloutVersionName(channel)
  if (!versionName)
    return { skipped: true, reason: 'missing_rollout_version_name' }

  const start = getWindowStart(channel.auto_pause_window_minutes, now)
  const stats = await readStatsVersion(c, channel.app_id, start, now.toISOString(), { id: channel.id, name: channel.name })
  const totals = stats
    .filter(row => row.version_name === versionName)
    .reduce((acc, row) => {
      acc.installs += Number(row.install ?? 0)
      acc.failures += Number(row.fail ?? 0)
      return acc
    }, { installs: 0, failures: 0 })

  const result = evaluateAutoPausePolicy({
    action: normalizeAction(channel.auto_pause_action),
    confidence: Number(channel.auto_pause_confidence ?? 0.95),
    cooldownMinutes: channel.auto_pause_cooldown_minutes ?? 60,
    enabled: channel.auto_pause_enabled,
    failureRateBps: channel.auto_pause_failure_rate_bps,
    failures: totals.failures,
    installs: totals.installs,
    lastTriggeredAt: channel.auto_pause_last_triggered_at,
    minAttempts: channel.auto_pause_min_attempts,
    minFailures: channel.auto_pause_min_failures,
    now,
  })

  if (!result.shouldTrigger) {
    const updated = await updateCurrentRolloutChannel(supabase, channel, { auto_pause_last_checked_at: now.toISOString() })
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
    return { triggered: false, reason: result.reason, result }
  }

  const reason = buildReason(channel, versionName, result)
  const basePatch = {
    auto_pause_last_checked_at: now.toISOString(),
    auto_pause_last_triggered_at: now.toISOString(),
    rollout_pause_reason: reason,
  } as any

  if (result.action === 'pause') {
    const updated = await updateCurrentRolloutChannel(supabase, channel, {
      ...basePatch,
      rollout_paused_at: now.toISOString(),
    })
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
  }
  else if (result.action === 'rollback') {
    const updated = await updateCurrentRolloutChannel(supabase, channel, {
      ...basePatch,
      rollout_enabled: false,
      rollout_percentage_bps: 0,
      rollout_version: null,
      rollout_paused_at: null,
    })
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
  }
  else {
    const updated = await updateCurrentRolloutChannel(supabase, channel, basePatch)
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
    await sendEventToTracking(c, {
      channel: 'rollout-auto-pause',
      event: 'Rollout Auto-Pause Notification',
      icon: '⚠️',
      user_id: channel.owner_org,
      groups: { organization: channel.owner_org },
      tags: {
        app_id: channel.app_id,
        channel_id: channel.id,
        channel_name: channel.name,
        rollout_version: versionName,
      },
      description: reason,
      notify: true,
    }, { background: false })
  }

  cloudlog({ requestId: c.get('requestId'), message: 'rollout auto-pause triggered', appId: channel.app_id, channelId: channel.id, action: result.action, reason })
  return { triggered: true, reason, result }
}

async function loadAutoPauseChannels(supabase: ReturnType<typeof supabaseAdmin>) {
  const channels: RolloutAutoPauseChannel[] = []
  let page = 0

  while (true) {
    const from = page * AUTO_PAUSE_CHANNEL_PAGE_SIZE
    const to = from + AUTO_PAUSE_CHANNEL_PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('channels')
      .select(`
        id,
        name,
        app_id,
        owner_org,
        rollout_version,
        auto_pause_enabled,
        auto_pause_window_minutes,
        auto_pause_failure_rate_bps,
        auto_pause_confidence,
        auto_pause_min_attempts,
        auto_pause_min_failures,
        auto_pause_action,
        auto_pause_cooldown_minutes,
        auto_pause_last_triggered_at,
        rollout_paused_at,
        rollout_version_info:app_versions!channels_rollout_version_fkey(name)
      `)
      .eq('rollout_enabled', true)
      .eq('auto_pause_enabled', true)
      .gt('rollout_percentage_bps', 0)
      .not('rollout_version', 'is', null)
      .is('rollout_paused_at', null)
      .order('id', { ascending: true })
      .range(from, to)

    if (error)
      return { data: null, error }

    const pageRows = (data ?? []) as unknown as RolloutAutoPauseChannel[]
    channels.push(...pageRows)

    if (pageRows.length < AUTO_PAUSE_CHANNEL_PAGE_SIZE)
      return { data: channels, error: null }

    page += 1
  }
}

app.post('/', middlewareAPISecret, async (c) => {
  const supabase = supabaseAdmin(c)
  const now = new Date()

  const { data, error } = await loadAutoPauseChannels(supabase)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot load rollout auto-pause channels', error })
    throw error
  }

  const channels = (data ?? []) as unknown as RolloutAutoPauseChannel[]
  let triggered = 0
  let checked = 0

  for (const channel of channels) {
    try {
      const evaluation = await evaluateChannel(c, supabase, channel, now)
      checked += 1
      if ('triggered' in evaluation && evaluation.triggered)
        triggered += 1
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause channel evaluation failed', channelId: channel.id, appId: channel.app_id, error })
    }
  }

  return c.json({ ...BRES, checked, triggered })
})

export const __rolloutAutoPauseTestUtils__ = {
  buildReason,
  getRolloutVersionName,
  getWindowStart,
  loadAutoPauseChannels,
}
