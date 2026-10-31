import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const GIB = 1024 ** 3
const metricNames = [
  'node_memory_MemTotal_bytes',
  'node_memory_MemAvailable_bytes',
  'node_memory_Committed_AS_bytes',
  'node_memory_CommitLimit_bytes',
  'node_memory_SwapTotal_bytes',
  'node_memory_SwapFree_bytes',
  'node_vmstat_oom_kill',
  'node_vmstat_pswpin',
  'node_vmstat_pswpout',
  'node_boot_time_seconds',
] as const

type MetricName = typeof metricNames[number]

/** Read only database-host gauges; never include labels or unrelated metrics in the report. */
export function memoryReport(metrics: string, capturedAt: string | null = null) {
  const values = new Map<MetricName, number>()
  for (const line of metrics.split('\n')) {
    if (line.startsWith('#') || !line.trim())
      continue
    const match = /^(\w+)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\d+)?$/.exec(line)
    if (!match || !metricNames.includes(match[1] as MetricName))
      continue
    const [, name, labels = '', rawValue] = match
    if (!/(?:^|,)\s*service_type="db"(?:,|$)/.test(labels))
      continue
    const value = Number(rawValue)
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Invalid value for ${name}`)
    const metricName = name as MetricName
    if (values.has(metricName))
      throw new Error(`Multiple database hosts found for ${name}; capture one host at a time`)
    values.set(metricName, value)
  }
  const required = (name: MetricName) => {
    const value = values.get(name)
    if (value === undefined)
      throw new Error(`Missing database-host metric: ${name}`)
    return value
  }
  const optional = (name: MetricName) => values.get(name) ?? null
  const physicalBytes = required('node_memory_MemTotal_bytes')
  const availableBytes = required('node_memory_MemAvailable_bytes')
  const committedBytes = required('node_memory_Committed_AS_bytes')
  if (!physicalBytes || availableBytes > physicalBytes)
    throw new Error('Invalid physical or available memory')
  const thresholdsBytes = {
    warning: physicalBytes * 0.5 + GIB,
    problematic: physicalBytes * 0.8 + GIB,
    severe: physicalBytes * 0.9 + GIB,
  }
  const commitmentZone = committedBytes >= thresholdsBytes.severe
    ? 'severe'
    : committedBytes >= thresholdsBytes.problematic
      ? 'problematic'
      : committedBytes >= thresholdsBytes.warning ? 'warning' : 'below-warning'
  const swapTotalBytes = optional('node_memory_SwapTotal_bytes')
  const swapFreeBytes = optional('node_memory_SwapFree_bytes')
  if (swapTotalBytes !== null && swapFreeBytes !== null && swapFreeBytes > swapTotalBytes)
    throw new Error('Invalid free swap')

  return {
    capturedAt,
    physicalBytes,
    availableBytes,
    committedBytes,
    kernelCommitLimitBytes: optional('node_memory_CommitLimit_bytes'),
    thresholdsBytes,
    commitmentZone,
    swapUsedBytes: swapTotalBytes !== null && swapFreeBytes !== null ? swapTotalBytes - swapFreeBytes : null,
    oomKillsSinceBoot: optional('node_vmstat_oom_kill'),
    swapInPagesSinceBoot: optional('node_vmstat_pswpin'),
    swapOutPagesSinceBoot: optional('node_vmstat_pswpout'),
    hostBootTimeSeconds: optional('node_boot_time_seconds'),
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'metrics-file': { type: 'string' },
      'project-ref': { type: 'string' },
      'captured-at': { type: 'string' },
    },
  })
  let metrics: string
  let capturedAt: string | null = null
  if (values['metrics-file']) {
    if (values['project-ref'])
      throw new Error('Choose either --metrics-file or --project-ref')
    if (values['captured-at']) {
      const timestamp = values['captured-at']
      if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
        throw new Error('--captured-at must be an ISO timestamp with a timezone')
      capturedAt = new Date(timestamp).toISOString()
    }
    metrics = await readFile(values['metrics-file'], 'utf8')
  }
  else {
    if (values['captured-at'])
      throw new Error('--captured-at is only for an existing --metrics-file')
    const projectRef = values['project-ref']
    if (!projectRef || !/^[a-z]{20}$/.test(projectRef))
      throw new Error('Use --project-ref <ref> or --metrics-file <private-prometheus-file>')
    const token = process.env.SUPABASE_ACCESS_TOKEN
    if (!token)
      throw new Error('SUPABASE_ACCESS_TOKEN is required for a live metrics snapshot')
    const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/metrics`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    if (!response.ok)
      throw new Error(`Metrics request failed (HTTP ${response.status})`)
    metrics = await response.text()
    capturedAt = new Date().toISOString()
  }
  console.log(JSON.stringify(memoryReport(metrics, capturedAt), null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    // Do not print raw response bodies, request headers, or metrics labels.
    console.error(error instanceof Error ? error.message : 'Memory snapshot failed')
    process.exitCode = 1
  })
}
