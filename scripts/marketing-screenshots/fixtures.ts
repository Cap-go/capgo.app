// Fake but internally consistent demo data for marketing screenshots.
// Story: 4.8.0 shipped with a native regression, 4.8.1 fixes it and rolls out
// to 25% of production, and beta 4.8.2-beta.1 needs a native build because
// @capacitor/camera changed. Every timestamp is relative to "now" so the
// screens never look stale. No customer data: teammates use @example.com.
const DAY = 86_400_000
export const NOW = Date.now()
const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()

export function labels(days: number) {
  const n = days === 1 ? 2 : days
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10))
}
const pick = <T>(arr: T[], days: number) => arr.slice(-labels(days).length)
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const wave = (n: number, base: number, amp: number, seed = 1) =>
  Array.from({ length: n }, (_, i) => Math.round(base + amp * Math.sin(i * 1.3 + seed) + amp * 0.4 * Math.cos(i * 2.1 + seed * 2)))

// 30-day backbone so every period selector stays coherent.
const L30 = 30
const launches30 = wave(L30, 21400, 1500, 1).map((v, i) => v + i * 120)
const webviews30 = launches30.map(v => Math.round(v * 0.97))
// 4.8.0 shipped 6 days ago with a native regression; 4.8.1 fixed it 3 days ago.
const issues30 = Array.from({ length: L30 }, (_, i) => (i === 24 ? 610 : i === 25 ? 940 : i === 26 ? 720 : i >= 27 ? 95 + (i % 2) * 14 : 120 + (i % 4) * 11))
const launchP5030 = wave(L30, 410, 18, 3)
const launchP9030 = Array.from({ length: L30 }, (_, i) => (i >= 24 && i <= 26 ? 1040 + (i - 24) * 60 : i >= 27 ? 720 + (i % 3) * 14 : 790 + (i % 5) * 9))
const webP5030 = wave(L30, 560, 25, 5)
const webP9030 = Array.from({ length: L30 }, (_, i) => (i >= 24 && i <= 26 ? 1480 + (i - 24) * 70 : i >= 27 ? 1090 + (i % 3) * 25 : 1180 + (i % 4) * 20))

export function nativeObserve(days: number, versionGroup = 'version') {
  const lab = labels(days)
  const launches = pick(launches30, days)
  const webview = pick(webviews30, days)
  const issues = pick(issues30, days)
  const total = launches.map((v, i) => v + webview[i] + issues[i] + Math.round(v * 0.85))
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)
  const totalDevices = Math.round(18640 * Math.min(1, 0.35 + days / 10))
  const affected = Math.round(sum(issues) / 4.6)
  const versionsBase = [
    ['4.8.1', 'production', 9820, 0.6, 712, 1060],
    ['4.8.0', 'production', 4210, 6.9, 1180, 1620],
    ['4.7.3', 'production', 3120, 1.1, 796, 1190],
    ['4.8.2-beta.1', 'beta', 860, 0.4, 698, 1010],
    ['4.7.2', 'production', 630, 1.4, 812, 1220],
  ] as const
  const versions: any[] = []
  for (const [name, channel, devices, issuePct, lp90, wp90] of versionsBase) {
    const platforms = versionGroup === 'version' ? [null] : ['ios', 'android']
    for (const p of platforms) {
      const share = p === null ? 1 : p === 'ios' ? 0.46 : 0.54
      const d = Math.round(devices * share)
      const aff = Math.round(d * issuePct / 100)
      versions.push({
        version_name: name,
        platform: p,
        channel_name: versionGroup === 'version_platform_channel' ? channel : null,
        events: d * 31,
        devices: d,
        issue_count: Math.round(aff * 3.2),
        affected_devices: aff,
        issue_free_rate: Math.round(((d - aff) / d) * 1000) / 10,
        launch_p90_ms: lp90 + (p === 'android' ? 64 : 0),
        webview_load_p90_ms: wp90 + (p === 'android' ? 90 : 0),
      })
    }
  }
  const markers = [
    { version_name: '4.8.0', channel_name: 'production', deployed_at: new Date(today - 5 * DAY + 9.5 * 3600_000).toISOString() },
    { version_name: '4.8.1', channel_name: 'production', deployed_at: new Date(today - 2 * DAY + 14.2 * 3600_000).toISOString() },
    { version_name: '4.8.2-beta.1', channel_name: 'beta', deployed_at: new Date(today - 1 * DAY + 11 * 3600_000).toISOString() },
  ].filter(m => m.deployed_at.slice(0, 10) >= lab[0])
  return {
    labels: lab,
    period: { requested_days: days, actual_days: lab.length, start: lab[0] + 'T00:00:00.000Z', end: new Date(NOW).toISOString() },
    version_group: versionGroup,
    overview: {
      total_events: sum(total),
      total_devices: totalDevices,
      issue_count: sum(issues),
      affected_devices: affected,
      issue_free_rate: Math.round(((totalDevices - affected) / totalDevices) * 1000) / 10,
      launch_timeout_count: Math.round(sum(issues) * 0.08),
      launch_p50_ms: 412,
      launch_p90_ms: days <= 3 ? 726 : 781,
      webview_load_p50_ms: 566,
      webview_load_p90_ms: days <= 3 ? 1100 : 1210,
    },
    daily: {
      total_events: total,
      issue_events: issues,
      launches,
      webview_loads: webview,
      launch_p50_ms: pick(launchP5030, days),
      launch_p90_ms: pick(launchP9030, days),
      webview_load_p50_ms: pick(webP5030, days),
      webview_load_p90_ms: pick(webP9030, days),
    },
    actionBreakdown: [
      { action: 'app_launch_ready', events: sum(launches), devices: totalDevices, p50_ms: 412, p90_ms: 781, p99_ms: 1640, is_issue: false },
      { action: 'webview_page_loaded', events: sum(webview), devices: totalDevices - 120, p50_ms: 566, p90_ms: 1210, p99_ms: 2480, is_issue: false },
      { action: 'app_moved_to_foreground', events: Math.round(sum(launches) * 1.7), devices: totalDevices - 40, p50_ms: null, p90_ms: null, p99_ms: null, is_issue: false },
      { action: 'webview_javascript_error', events: Math.round(sum(issues) * 0.38), devices: Math.round(affected * 0.44), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
      { action: 'app_crash_native', events: Math.round(sum(issues) * 0.24), devices: Math.round(affected * 0.31), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
      { action: 'app_anr', events: Math.round(sum(issues) * 0.16), devices: Math.round(affected * 0.2), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
      { action: 'app_launch_timeout', events: Math.round(sum(issues) * 0.08), devices: Math.round(affected * 0.12), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
      { action: 'app_killed_low_memory', events: Math.round(sum(issues) * 0.07), devices: Math.round(affected * 0.09), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
      { action: 'webview_render_process_gone', events: Math.round(sum(issues) * 0.04), devices: Math.round(affected * 0.05), p50_ms: null, p90_ms: null, p99_ms: null, is_issue: true },
    ],
    versions,
    releaseMarkers: markers,
  }
}

export function pluginAdoption() {
  const total = 18640
  return {
    pluginVersions: [
      { plugin_version: '8.42.3', devices: 11280, total_devices: total },
      { plugin_version: '8.41.0', devices: 4120, total_devices: total },
      { plugin_version: '8.38.2', devices: 2210, total_devices: total },
      { plugin_version: '7.34.1', devices: 1030, total_devices: total },
    ],
  }
}

const errorActions = [
  ['download_fail', 82, 21, 3, '4.8.0', 'ios-7f3a91c2'],
  ['checksum_fail', 31, 11, 2, '4.8.0', 'android-2b8e44d0'],
  ['unzip_fail', 18, 8, 1, '4.8.0', 'android-91c04f7e'],
  ['low_mem_fail', 14, 6, 2, '4.7.3', 'android-5d2a3b19'],
  ['update_fail', 11, 5, 2, '4.8.1', 'ios-c4e7aa02'],
  ['insufficient_disk_space', 7, 4, 1, '4.7.2', 'android-e1f9302b'],
] as const

export function insights(days: number, versionName?: string) {
  const lab = labels(days)
  const scale = Math.min(1, 0.3 + days / 10)
  const acts = errorActions
    .filter(a => !versionName || a[4] === versionName)
    .map(([action, total, devs, vc, ver, dev], i) => ({
      action,
      total: Math.max(1, Math.round(total * scale)),
      device_count: Math.max(1, Math.round(devs * scale)),
      version_count: vc,
      first_seen: iso((days * 24 - i * 3) * 3600_000),
      last_seen: iso((i * 47 + 12) * 60_000),
      latest_version_name: ver,
      latest_device_id: dev,
    }))
  const shape = [0.4, 0.45, 0.5, 0.42, 0.9, 1.6, 1.2, 0.6, 0.35, 0.3]
  const daily: any[] = []
  lab.forEach((date, di) => {
    const w = shape[(shape.length - lab.length + di + shape.length * 4) % shape.length]
    for (const a of acts) daily.push({ date, action: a.action, total: Math.round((a.total / lab.length) * w) })
  })
  const versions = acts.flatMap(a => [
    { action: a.action, version_name: a.latest_version_name, total: Math.round(a.total * 0.7), device_count: Math.round(a.device_count * 0.68), last_seen: a.last_seen },
    { action: a.action, version_name: '4.7.3', total: Math.round(a.total * 0.2), device_count: Math.round(a.device_count * 0.22), last_seen: iso(5 * 3600_000) },
  ])
  const devices = acts.flatMap((a, i) => [
    { action: a.action, device_id: a.latest_device_id, total: Math.max(2, 9 - i), version_name: a.latest_version_name, last_seen: a.last_seen },
    { action: a.action, device_id: `ios-${(0x3a1b + i * 977).toString(16)}e02f`, total: Math.max(1, 6 - i), version_name: a.latest_version_name, last_seen: iso((i + 2) * 3600_000) },
  ])
  const total = acts.reduce((s, a) => s + a.total, 0)
  return {
    summary: { total, device_count: Math.round(acts.reduce((s, a) => s + a.device_count, 0) * 0.8), action_count: acts.length },
    actions: acts,
    daily,
    versions,
    devices,
    period: { requested_days: days, start: lab[0] + 'T00:00:00.000Z', end: new Date(NOW).toISOString(), labels: lab },
  }
}

export function logs(rangeEnd?: number) {
  const end = rangeEnd ?? NOW
  const rows: any[] = []
  const seq: [string, string, any?][] = [
    ['app_launch_ready', '4.8.1', { duration_ms: '684' }],
    ['webview_page_loaded', '4.8.1', { duration_ms: '1032' }],
    ['get', '4.8.1'],
    ['noNew', '4.8.1'],
    ['app_moved_to_foreground', '4.8.1'],
    ['download_zip_start', '4.8.0'],
    ['download_complete', '4.8.1'],
    ['set', '4.8.1'],
    ['webview_javascript_error', '4.8.0', { message: "TypeError: Cannot read properties of undefined (reading 'cart')", source: 'checkout.js:212' }],
    ['download_fail', '4.8.0', { error: 'Network connection lost', status: '-1005' }],
    ['app_moved_to_background', '4.8.1'],
    ['app_launch_ready', '4.7.3', { duration_ms: '802' }],
    ['checksum_fail', '4.8.0', { expected: '9d4f798a', received: '44913a9f' }],
    ['get', '4.7.3'],
    ['download_complete', '4.8.1'],
    ['set', '4.8.1'],
    ['app_nav', '4.8.1', { path: '/checkout' }],
    ['app_crash_native', '4.8.0', { signal: 'SIGABRT', thread: 'main' }],
    ['webview_page_loaded', '4.7.3', { duration_ms: '1188' }],
    ['update_fail', '4.8.1', { reason: 'Bundle 4.8.1 rolled back after notifyAppReady timeout' }],
    ['get', '4.8.1'],
    ['noNew', '4.8.1'],
  ]
  const devices = ['ios-7f3a91c2', 'android-2b8e44d0', 'ios-c4e7aa02', 'android-91c04f7e', 'ios-08bd61f5', 'android-5d2a3b19']
  seq.forEach(([action, version, metadata], i) => {
    rows.push({
      app_id: 'com.demo.app',
      device_id: devices[(i * 5) % devices.length],
      action,
      version_name: version,
      metadata: metadata ?? null,
      created_at: new Date(end - (i * 71 + 9) * 1000).toISOString(),
    })
  })
  return rows
}

export function compatibilityEvents() {
  const base = {
    org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    app_id: 'com.demo.app',
    resolved_by: null,
    resolution_kind: null,
    resolution_note: null,
    resolved_at: null,
  }
  return [
    { ...base, id: 9101, source: 'channel_version_changed', platform: 'ios', channel_id: 2, channel_name: 'beta', current_version_id: 5, current_version_name: '4.8.2-beta.1', previous_version_id: 6, previous_version_name: '4.8.1', offenders: ['@capacitor/camera', '@capgo/capacitor-social-login'], change_occurred_at: iso(3 * 3600_000), created_at: iso(3 * 3600_000) },
    { ...base, id: 9102, source: 'channel_version_changed', platform: 'android', channel_id: 2, channel_name: 'beta', current_version_id: 5, current_version_name: '4.8.2-beta.1', previous_version_id: 6, previous_version_name: '4.8.1', offenders: ['@capacitor/camera'], change_occurred_at: iso(3 * 3600_000 + 1000), created_at: iso(3 * 3600_000 + 1000) },
    { ...base, id: 9090, source: 'channel_version_changed', platform: 'ios', channel_id: 3, channel_name: 'staging', current_version_id: 6, current_version_name: '4.8.1', previous_version_id: 7, previous_version_name: '4.8.0', offenders: ['@capacitor-firebase/messaging'], change_occurred_at: iso(4 * DAY), created_at: iso(4 * DAY), resolution_kind: 'auto_compatible', resolved_at: iso(4 * DAY - 2 * 3600_000) },
    { ...base, id: 9071, source: 'default_channel_version_changed', platform: 'android', channel_id: 1, channel_name: 'production', current_version_id: 7, current_version_name: '4.8.0', previous_version_id: 4, previous_version_name: '4.7.3', offenders: ['@capgo/native-purchases'], change_occurred_at: iso(11 * DAY), created_at: iso(11 * DAY), resolution_kind: 'accepted', resolution_note: 'Native build 2026.9 already shipped to both stores', resolved_by: '6aa76066-55ef-4238-ade6-0b32334a4097', resolved_at: iso(11 * DAY - 3600_000) },
    { ...base, id: 9055, source: 'channel_version_changed', platform: 'ios', channel_id: 3, channel_name: 'staging', current_version_id: 4, current_version_name: '4.7.3', previous_version_id: 3, previous_version_name: '4.7.2', offenders: ['@capacitor/push-notifications'], change_occurred_at: iso(16 * DAY), created_at: iso(16 * DAY), resolution_kind: 'auto_compatible', resolved_at: iso(15 * DAY) },
    { ...base, id: 9031, source: 'default_channel_version_changed', platform: 'android', channel_id: 1, channel_name: 'production', current_version_id: 3, current_version_name: '4.7.2', previous_version_id: null, previous_version_name: '4.7.1', offenders: ['@capgo/capacitor-native-biometric'], change_occurred_at: iso(23 * DAY), created_at: iso(23 * DAY), resolution_kind: 'accepted', resolution_note: 'Store build 2026.8 rolled out', resolved_by: '6aa76066-55ef-4238-ade6-0b32334a4097', resolved_at: iso(22 * DAY) },
  ]
}

export function releaseLive() {
  const bucketMinutes = 5
  const bucketMs = bucketMinutes * 60_000
  const end = Math.floor(NOW / bucketMs) * bucketMs
  const start = end - 36 * bucketMs
  const series = Array.from({ length: 36 }, (_, i) => {
    const ramp = Math.round(420 * Math.exp(-i / 9) + 46 + 10 * Math.sin(i))
    return { ts: new Date(start + i * bucketMs).toISOString(), get: ramp + 18, install: ramp, fail: [3, 1, 2, 0, 1, 0, 1, 0, 0, 1][i % 10] }
  })
  const install = series.reduce((s, b) => s + b.install, 0)
  const fail = series.reduce((s, b) => s + b.fail, 0)
  const get = series.reduce((s, b) => s + b.get, 0)
  const deployedAt = new Date(start).toISOString()
  return {
    release: { bundle_id: 5, version_name: '4.8.1', channel_id: 1, channel_name: 'production', deployed_at: deployedAt },
    window: { start: deployedAt, end: new Date(NOW).toISOString(), bucket_minutes: bucketMinutes, truncated: false },
    totals: { get, install, fail, success_rate: Math.round((install / (install + fail)) * 1000) / 10 },
    adoption: { devices_on_release: install, total_devices: 18640, percent: Math.round((install / 18640) * 1000) / 10 },
    failures: [
      { action: 'download_fail', count: Math.round(fail * 0.6) },
      { action: 'checksum_fail', count: Math.round(fail * 0.25) },
      { action: 'unzip_fail', count: Math.round(fail * 0.15) },
    ],
    failed_devices: { total: 21, recovered: 18, stuck: 3 },
    series,
    rollout: null,
    channel: { id: 1, name: 'production', is_default: true },
    channels: [
      { id: 1, name: 'production', is_default: true },
      { id: 2, name: 'beta', is_default: false },
    ],
    recent_deployments: [
      { version_name: '4.8.1', channel_id: 1, channel_name: 'production', deployed_at: deployedAt },
      { version_name: '4.8.2-beta.1', channel_id: 2, channel_name: 'beta', deployed_at: iso(DAY) },
      { version_name: '4.8.0', channel_id: 1, channel_name: 'production', deployed_at: iso(5 * DAY) },
    ],
    generated_at: new Date(NOW).toISOString(),
  }
}

export function bundleInstallStats(days: number) {
  const lab = labels(days)
  const bundles = [
    { version_name: '4.8.1', install: 9420, fail: 61, timing: { samples: 9420, p50_ms: 3100, p70_ms: 4200, p90_ms: 6800, p95_ms: 8900 } },
    { version_name: '4.8.0', install: 6110, fail: 284, timing: { samples: 6110, p50_ms: 3900, p70_ms: 5600, p90_ms: 9900, p95_ms: 13100 } },
    { version_name: '4.8.2-beta.1', install: 812, fail: 4, timing: { samples: 812, p50_ms: 2800, p70_ms: 3900, p90_ms: 6100, p95_ms: 7800 } },
  ].map(b => ({ ...b, success_rate: Math.round((b.install / (b.install + b.fail)) * 1000) / 10 }))
  const install = bundles.reduce((s, b) => s + b.install, 0)
  const fail = bundles.reduce((s, b) => s + b.fail, 0)
  return {
    period: { requested_days: days, actual_days: lab.length, start: lab[0] + 'T00:00:00.000Z', end: new Date(NOW).toISOString() },
    bundles,
    totals: { install, fail, success_rate: Math.round((install / (install + fail)) * 1000) / 10 },
  }
}

export function deliveryStats(days: number) {
  const lab = labels(days)
  const n = lab.length
  return {
    scope: 'app',
    labels: lab,
    period: { requested_days: days, actual_days: n, start: lab[0] + 'T00:00:00.000Z', end: new Date(NOW).toISOString() },
    overview: { samples: 16342, devices: 14980, p50_ms: 38_000, p75_ms: 96_000, p95_ms: 410_000, p99_ms: 1_380_000 },
    daily: {
      samples: wave(n, 2300, 300, 2),
      p50_ms: wave(n, 38_000, 4000, 1),
      p75_ms: wave(n, 96_000, 9000, 2),
      p95_ms: wave(n, 410_000, 40_000, 3),
      p99_ms: wave(n, 1_380_000, 120_000, 4),
    },
  }
}

function usageDatasets(lab: string[], native: boolean) {
  const n = lab.length
  const shares: Record<string, number[]> = {}
  // adoption curve: 4.8.1 ramps up from 3 days ago, 4.8.0 decays.
  const vs = ['4.8.1', '4.8.0', '4.7.3', '4.7.2']
  const curve = (i: number) => {
    const pos = n - 1 - i // days ago
    const v481 = pos > 2 ? 0 : [78, 61, 34][pos]
    const v480 = pos > 5 ? 0 : pos > 2 ? [44, 52, 58][pos - 3] : [12, 21, 38][pos]
    const v472 = Math.max(2, Math.min(6, pos))
    const v473 = Math.max(0, 100 - v481 - v480 - v472)
    return [v481, v480, v473, v472]
  }
  vs.forEach((v, vi) => { shares[v] = Array.from({ length: n }, (_, i) => curve(i)[vi]) })
  if (!native) {
    return vs.map(v => ({ label: v, data: shares[v], metaCounts: shares[v].map(p => Math.round(p * 186)) }))
  }
  return vs.flatMap(v => [
    { label: `iOS ${v}`, data: shares[v].map(p => Math.round(p * 0.46 * 10) / 10), metaCounts: shares[v].map(p => Math.round(p * 86)) },
    { label: `Android ${v}`, data: shares[v].map(p => Math.round(p * 0.54 * 10) / 10), metaCounts: shares[v].map(p => Math.round(p * 100)) },
  ])
}

export function usage(kind: 'bundle_usage' | 'native_usage', from: string, to: string) {
  const lab: string[] = []
  for (let t = new Date(from + 'T00:00:00Z').getTime(); t <= new Date(to + 'T00:00:00Z').getTime(); t += DAY)
    lab.push(new Date(t).toISOString().slice(0, 10))
  const res: any = { labels: lab, datasets: usageDatasets(lab, kind === 'native_usage'), latestVersion: { name: '4.8.1', percentage: '78' } }
  if (kind === 'native_usage') {
    res.activeDevices = { android: 10080, ios: 8560, electron: 0, unknown: 0, total: 18640 }
    res.previousPeriodActiveDevices = { android: 9410, ios: 8020, electron: 0, unknown: 0, total: 17430 }
    res.dailyPlatformActive = {
      labels: lab,
      android: lab.map((_, i) => 8900 + i * 40 + (i % 3) * 120),
      ios: lab.map((_, i) => 7600 + i * 32 + (i % 4) * 90),
      electron: lab.map(() => 0),
      unknown: lab.map(() => 0),
      total: lab.map((_, i) => 16500 + i * 72 + (i % 3) * 120 + (i % 4) * 90),
    }
  }
  return res
}

// ---------- Notifications ----------
export function notifProviders() {
  return { data: [
    { id: 'prov-ios', platform: 'ios', status: 'configured', has_secret: true, secret_ref: 'NOTIF_IOS', config: { teamId: 'A1B2C3D4E5', keyId: 'K7Q9X2M4LP', bundleId: 'com.demo.app', environment: 'production' } },
    { id: 'prov-android', platform: 'android', status: 'configured', has_secret: true, secret_ref: 'NOTIF_ANDROID', config: { projectId: 'demo-app-prod', serviceAccountEmail: 'push@demo-app-prod.iam.gserviceaccount.com' } },
  ] }
}
export function notifCampaigns() {
  const c = (id: string, name: string, kind: string, status: string, ago: number, broadcast: boolean, title: string, body: string, counters: Record<string, number>) => ({
    id, name, kind, status, created_at: iso(ago), updated_at: iso(ago - 60_000), queued_at: iso(ago - 5_000), completed_at: status === 'sent' ? iso(ago - 90_000) : null,
    audience: broadcast ? { broadcast: true, platforms: ['ios', 'android'] } : { externalIds: ['user_18422'] },
    payload: { title, body, data: { route: '/cart' } }, counters,
  })
  return { data: [
    c('cmp-1', 'Spring sale is live', 'send', 'sent', 2 * 3600_000, true, 'Spring sale is live', '20% off everything until Sunday', { targeted: 14210, sent: 14012, opened: 2318 }),
    c('cmp-2', 'Update 4.8.1 available', 'update_check', 'sent', 3 * 86_400_000, true, 'Update check', 'Silent update check for production', { targeted: 18640, sent: 18402 }),
    c('cmp-3', 'Order shipped', 'send', 'sent', 25 * 60_000, false, 'Your order is on its way', 'Track order #48213', { targeted: 1, sent: 1, opened: 1 }),
    c('cmp-4', 'Cart reminder', 'send', 'sent', 5 * 3600_000, false, 'Still thinking about it?', 'Your cart is waiting', { targeted: 1, sent: 1 }),
    c('cmp-5', 'New feature: saved items', 'send', 'scheduled', -86_400_000, true, 'Save it for later', 'Try saved items in the cart', { targeted: 0 }),
  ] }
}
export function notifStats(campaignId?: string | null) {
  if (campaignId) {
    return { data: [
      { event: 'queued', count: 14210 }, { event: 'sent', count: 14012 }, { event: 'provider_accepted', count: 13964 },
      { event: 'received', count: 13104 }, { event: 'opened', count: 2318 }, { event: 'failed', count: 198 },
    ] }
  }
  return { data: [
    { event: 'queued', count: 33218 }, { event: 'sent', count: 32860 }, { event: 'provider_accepted', count: 32604 },
    { event: 'received', count: 29870 }, { event: 'opened', count: 4127 }, { event: 'background_finished', count: 18011 }, { event: 'failed', count: 256 },
  ] }
}
export const notifSettings = { appId: 'com.demo.app', pushUpdateEnabled: true, pushUpdateInstallMode: 'next', pushUpdateChannel: 'production' }

// ---------- Devices ----------
const deviceRows = [
  ['ios-7f3a91c2', 'ios', '18.6', '4.8.1', 'US', 'production'], ['android-2b8e44d0', 'android', '15', '4.8.1', 'DE', 'production'],
  ['ios-c4e7aa02', 'ios', '18.5', '4.8.2-beta.1', 'FR', 'beta'], ['android-91c04f7e', 'android', '14', '4.8.0', 'BR', 'production'],
  ['ios-08bd61f5', 'ios', '17.7', '4.8.1', 'GB', 'production'], ['android-5d2a3b19', 'android', '15', '4.8.1', 'IN', 'production'],
  ['ios-3a1be02f', 'ios', '18.6', '4.8.0', 'CA', 'production'], ['android-e1f9302b', 'android', '13', '4.7.3', 'ES', 'production'],
  ['ios-9c2d44a1', 'ios', '18.6', '4.8.2-beta.1', 'US', 'beta'], ['android-77ab10cd', 'android', '15', '4.8.1', 'JP', 'production'],
  ['ios-51fe8d30', 'ios', '18.4', '4.8.1', 'AU', 'production'], ['android-0d9e6b42', 'android', '14', '4.8.1', 'MX', 'production'],
] as const
export function devices(body: any) {
  const rows = deviceRows.map(([device_id, platform, os, version_name, cc, ch], i) => ({
    app_id: 'com.demo.app', device_id, platform, os_version: os, version_name, version: null, version_build: platform === 'ios' ? '4.8.0 (812)' : '4.8.0 (812)',
    country_code: cc, custom_id: i % 3 === 0 ? `user_${18422 + i * 7}` : '', default_channel: ch === 'beta' ? 'beta' : null, id: 1000 + i,
    install_source: platform === 'ios' ? 'app_store' : 'play_store', is_emulator: false, is_prod: true, key_id: null, plugin_version: '8.42.3', updated_at: iso((i * 13 + 2) * 60_000),
  }))
  if (body.count) return { count: 18640 }
  const filtered = body.deviceIds ? rows.filter(r => body.deviceIds.includes(r.device_id)) : rows
  return { data: filtered, hasMore: !body.deviceIds }
}
export function deployments(deviceId: string) {
  const seq: [string, string, number][] = [['set', '4.8.1', 3 * 86_400_000 - 3600_000], ['download_fail', '4.8.1', 3 * 86_400_000], ['set', '4.8.0', 6 * 86_400_000], ['set', '4.7.3', 18 * 86_400_000], ['set', '4.7.2', 29 * 86_400_000]]
  return seq.map(([action, version_name, ago]) => ({ app_id: 'com.demo.app', device_id: deviceId, action, version_name, created_at: iso(ago) }))
}

// ---------- API keys / webhooks / SSO ----------
export function apiKeys() {
  const k = (id: number, name: string, mode: string, ago: number, expires: number | null, perms: string[]) => ({
    id, name, mode, key: null, is_hashed_key: true, created_at: iso(ago), updated_at: iso(ago), expires_at: expires ? new Date(NOW + expires).toISOString() : null,
    user_id: '6aa76066-55ef-4238-ade6-0b32334a4097', limited_to_orgs: ['046a36ac-e03c-4590-9257-bd6c9dba9ee8'], limited_to_apps: ['com.demo.app'], rbac_id: null, global_permissions: perms,
  })
  return [
    k(901, 'GitHub Actions – production upload', 'upload', 40 * 86_400_000, 50 * 86_400_000, []),
    k(902, 'Fastlane native builds', 'write', 22 * 86_400_000, 68 * 86_400_000, []),
    k(903, 'Support dashboard (read only)', 'read', 9 * 86_400_000, 81 * 86_400_000, []),
    k(904, 'Capgo MCP for Cursor', 'all', 2 * 86_400_000, 28 * 86_400_000, []),
  ]
}
export function webhooks() {
  const w = (id: string, name: string, url: string, events: string[], enabled: boolean, ago: number) => ({
    id, name, url, events, enabled, delivery_version: 'standard', created_at: iso(ago), updated_at: iso(ago), created_by: '6aa76066-55ef-4238-ade6-0b32334a4097', org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  })
  return [
    w('wh-1', 'Slack #releases', 'https://hooks.slack.com/services/T000/B000/XXXX', ['app_versions', 'channels'], true, 30 * 86_400_000),
    w('wh-2', 'Datadog events', 'https://http-intake.logs.datadoghq.com/api/v2/logs', ['app_versions', 'channels', 'apps'], true, 12 * 86_400_000),
    w('wh-3', 'Internal audit service', 'https://audit.example.com/capgo', ['org_users', 'orgs'], false, 4 * 86_400_000),
  ]
}
export function webhookDeliveries(webhookId: string) {
  const d = (i: number, status: string, code: number, event: string, ago: number) => ({
    id: `del-${webhookId}-${i}`, webhook_id: webhookId, org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', event_type: event, status, response_status: code, attempt_count: status === 'failed' ? 3 : 1,
    duration_ms: 120 + i * 37, created_at: iso(ago), completed_at: iso(ago - 400), request_payload: { event }, response_body: status === 'success' ? 'ok' : 'timeout', audit_log_id: null, max_attempts: 3, next_retry_at: null,
  })
  return { deliveries: [d(1, 'success', 200, 'channels.UPDATE', 12 * 60_000), d(2, 'success', 200, 'app_versions.INSERT', 3 * 3600_000), d(3, 'failed', 504, 'channels.UPDATE', 26 * 3600_000), d(4, 'success', 200, 'app_versions.INSERT', 3 * 86_400_000)], pagination: { page: 1, per_page: 20, total: 4, has_more: false } }
}
export function ssoProviders() {
  return [{ id: 'sso-1', org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', domain: 'example.com', provider_id: 'okta-demo', status: 'active', enforce_sso: true, metadata_url: 'https://example.okta.com/app/demo/sso/saml/metadata', dns_verification_token: null, role_mapping: null, created_at: iso(60 * 86_400_000), updated_at: iso(10 * 86_400_000) }]
}
export const ssoMetadata = { acs_url: 'https://sb.capgo.app/auth/v1/sso/saml/acs', entity_id: 'https://sb.capgo.app/auth/v1/sso/saml/metadata', nameid_format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' }

// ---------- Team / governance ----------
const ORG = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const ROLE = { super: '4130bd58-58e9-4717-93b5-3ab493297737', admin: '39eabda5-1db9-497a-93e9-cd28d19275cd', billing: 'f55bb530-3359-466c-8575-3a4296c7150d', member: '24085555-334f-408d-a7f5-4e30b07da81a' }
export const people = [
  { uid: '6aa76066-55ef-4238-ade6-0b32334a4097', email: 'demo@capgo.app', role: 'org_super_admin', roleId: ROLE.super, aid: 1 },
  { uid: '0b8e7a52-1d3f-4c2e-9a77-6f1c2d3e4a51', email: 'maya@example.com', role: 'org_admin', roleId: ROLE.admin, aid: 2 },
  { uid: '1c9f8b63-2e4a-4d3f-8b88-7a2d3e4f5b62', email: 'jordan@example.com', role: 'org_member', roleId: ROLE.member, aid: 3 },
  { uid: '2da09c74-3f5b-4e4a-9c99-8b3e4f5a6c73', email: 'priya@example.com', role: 'org_billing_admin', roleId: ROLE.billing, aid: 4 },
  { uid: '3eb1ad85-4a6c-4f5b-8daa-9c4f5a6b7d84', email: 'sam@example.com', role: 'org_member', roleId: ROLE.member, aid: 5 },
]
export function orgMembersRbac() {
  return people.map((p, i) => ({ binding_id: `b0000000-0000-4000-8000-00000000000${i}`, email: p.email, granted_at: iso((90 - i * 15) * 86_400_000), image_url: '', is_invite: i === 4, is_tmp: false, org_user_id: 100 + i, role_id: p.roleId, role_name: p.role, user_id: p.uid }))
}
export function orgMembers() {
  return people.map(p => ({ aid: p.aid, uid: p.uid, email: p.email, image_url: '', is_tmp: false, role: p.role.replace('org_', '') }))
}
export function members2fa() {
  return people.map(p => ({ user_id: p.uid, '2fa_enabled': true }))
}
export function appAccess() {
  const r = (i: number, type: string, name: string, role: string, desc: string, ago: number) => ({ id: `a0000000-0000-4000-8000-00000000000${i}`, principal_type: type, principal_id: `c0000000-0000-4000-8000-00000000000${i}`, principal_name: name, role_id: `r${i}`, role_name: role, role_description: desc, granted_at: iso(ago), granted_by: people[0].uid, expires_at: null, is_direct: true, reason: null })
  return [
    r(1, 'group', 'Mobile engineers', 'app_developer', 'Upload bundles and manage channels', 40 * 86_400_000),
    r(2, 'group', 'QA', 'app_preview', 'Preview bundles on devices', 40 * 86_400_000),
    r(3, 'group', 'Support', 'app_reader', 'Read devices, logs and stats', 32 * 86_400_000),
    r(4, 'user', 'maya@example.com', 'app_admin', 'Full control of the app', 60 * 86_400_000),
    r(5, 'user', 'jordan@example.com', 'app_uploader', 'Upload bundles only', 12 * 86_400_000),
  ]
}
export function auditLogs() {
  const a = (i: number, table: string, op: string, ago: number, actor: 'user' | 'apikey', who: string, fields: string[] | null, rec: string, oldR: any, newR: any) => ({
    id: 5000 - i, created_at: iso(ago), table_name: table, record_id: rec, operation: op, org_id: ORG, user_id: actor === 'user' ? people.find(p => p.email === who)?.uid ?? null : null,
    old_record: oldR, new_record: newR, changed_fields: fields, actor_type: actor, actor_user_id: actor === 'user' ? people.find(p => p.email === who)?.uid ?? null : null,
    actor_user_email: actor === 'user' ? who : null, actor_apikey_id: actor === 'apikey' ? 901 : null, actor_apikey_name: actor === 'apikey' ? who : null,
  })
  return [
    a(1, 'channels', 'UPDATE', 14 * 60_000, 'user', 'maya@example.com', ['rollout_percentage_bps'], '1', { name: 'production', rollout_percentage_bps: 1000 }, { name: 'production', rollout_percentage_bps: 2500 }),
    a(2, 'channels', 'UPDATE', 3 * 3600_000, 'user', 'maya@example.com', ['rollout_version', 'rollout_enabled'], '1', { name: 'production' }, { name: 'production', rollout_version: 6 }),
    a(3, 'app_versions', 'INSERT', 3 * 3600_000 + 120_000, 'apikey', 'GitHub Actions – production upload', null, '6', null, { name: '4.8.1' }),
    a(4, 'channels', 'UPDATE', 26 * 3600_000, 'user', 'jordan@example.com', ['version'], '2', { name: 'beta', version: 6 }, { name: 'beta', version: 5 }),
    a(5, 'app_versions', 'INSERT', 26 * 3600_000 + 300_000, 'apikey', 'GitHub Actions – production upload', null, '5', null, { name: '4.8.2-beta.1' }),
    a(6, 'orgs', 'UPDATE', 3 * 86_400_000, 'user', 'demo@capgo.app', ['enforcing_2fa'], ORG, { enforcing_2fa: false }, { enforcing_2fa: true }),
    a(7, 'org_users', 'INSERT', 4 * 86_400_000, 'user', 'demo@capgo.app', null, '104', null, { user_id: people[4].uid }),
    a(8, 'channels', 'UPDATE', 5 * 86_400_000, 'user', 'maya@example.com', ['auto_pause_enabled', 'auto_pause_failure_rate_bps'], '1', { auto_pause_enabled: false }, { auto_pause_enabled: true }),
    a(9, 'apps', 'UPDATE', 8 * 86_400_000, 'user', 'demo@capgo.app', ['allow_preview'], 'com.demo.app', { allow_preview: false }, { allow_preview: true }),
    a(10, 'orgs', 'UPDATE', 9 * 86_400_000, 'user', 'demo@capgo.app', ['password_policy_config'], ORG, null, null),
  ]
}
