import process from 'node:process'
import { log, spinner as spinnerC } from '@clack/prompts'

interface DeploymentRegion {
  code: string
  label: string
}

export interface ReplicationProgressReporter {
  info: (message: string) => void
  spinner: () => {
    start: (message: string) => void
    message: (message: string) => void
    stop: (message: string) => void
  }
}

const clackReplicationReporter: ReplicationProgressReporter = {
  info: message => log.info(message),
  spinner: spinnerC,
}

export interface ReplicationProgressOptions {
  interactive?: boolean
  totalMs?: number
  updateIntervalMs?: number
  title?: string
  completeMessage?: string
  reporter?: ReplicationProgressReporter
}

const DEPLOYMENT_REGIONS: DeploymentRegion[] = [
  { code: 'aws:eu-central-1', label: 'EU (Frankfurt)' },
  { code: 'gcp:me-central1', label: 'Middle East (Riyadh)' },
  { code: 'gcp:asia-east2', label: 'Hong Kong' },
  { code: 'aws:ap-northeast-1', label: 'Japan (Tokyo)' },
  { code: 'aws:ap-south-1', label: 'India (Mumbai)' },
  { code: 'aws:us-east-1', label: 'North America (Virginia)' },
  { code: 'gcp:africa-south1', label: 'Africa (South Africa)' },
  { code: 'aws:ap-southeast-2', label: 'Oceania (Sydney)' },
  { code: 'aws:sa-east-1', label: 'South America (São Paulo)' },
]

const DEFAULT_TOTAL_REPLICATION_MS = 60_000
const DEFAULT_UPDATE_INTERVAL_MS = 1_000
const PROGRESS_BAR_WIDTH = 20

function getCurrentTimeZone(): string | null {
  if (typeof Intl === 'undefined')
    return null

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone || null
}

function getClosestRegionFromTimeZone(): string | null {
  const tz = getCurrentTimeZone()
  if (!tz)
    return null

  if (/^America\//.test(tz))
    return 'aws:us-east-1'
  if (/^Europe\//.test(tz) || /^Atlantic\//.test(tz))
    return 'aws:eu-central-1'
  if (/^Africa\//.test(tz))
    return 'gcp:africa-south1'

  if (/^Asia\//.test(tz)) {
    const region = (tz.split('/')[1] ?? '').toLowerCase()
    if (['tokyo', 'osaka', 'seoul', 'pyongyang'].includes(region))
      return 'aws:ap-northeast-1'
    if (['kolkata', 'mumbai', 'calcutta', 'chennai', 'bangalore', 'hyderabad', 'delhi', 'dhaka', 'colombo', 'karachi'].includes(region))
      return 'aws:ap-south-1'
    if (['hong_kong', 'singapore', 'manila', 'jakarta', 'kuala_lumpur', 'beijing', 'shanghai', 'hongkong', 'taipei'].includes(region))
      return 'gcp:asia-east2'
    if (['sydney', 'melbourne', 'canberra', 'perth', 'brisbane', 'darwin', 'adelaide'].includes(region))
      return 'aws:ap-southeast-2'
    return 'gcp:asia-east2'
  }

  if (/^Pacific\//.test(tz) || /^Australia\//.test(tz))
    return 'aws:ap-southeast-2'

  return null
}

function getOrderedRegions(): DeploymentRegion[] {
  const sorted = [...DEPLOYMENT_REGIONS]
  const closestCode = getClosestRegionFromTimeZone()
  if (!closestCode)
    return sorted

  const index = sorted.findIndex(region => region.code === closestCode)
  if (index < 0)
    return sorted

  const [closest] = sorted.splice(index, 1)
  sorted.push(closest)
  return sorted
}

function getCompletedRegionCount(elapsedMs: number, total: number, totalMs: number): number {
  const clampedElapsed = Math.min(Math.max(elapsedMs, 0), totalMs)
  return Math.floor((clampedElapsed / totalMs) * total)
}

function buildProgressBar(percent: number) {
  const safePercent = Math.min(Math.max(percent, 0), 100)
  const filled = Math.round((safePercent / 100) * PROGRESS_BAR_WIDTH)
  return `${'█'.repeat(filled)}${'░'.repeat(PROGRESS_BAR_WIDTH - filled)}`
}

function formatDuration(seconds: number) {
  return `${Math.max(0, seconds)}s`
}

export function showReplicationProgress({
  interactive = process.stdout.isTTY && process.stderr.isTTY,
  totalMs = DEFAULT_TOTAL_REPLICATION_MS,
  updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
  title = 'Replicating your bundle in all regions...',
  completeMessage = 'Your update is now available worldwide.',
  reporter,
}: ReplicationProgressOptions = {}): Promise<void> {
  if (!interactive || totalMs <= 0)
    return Promise.resolve()

  const regions = getOrderedRegions()
  if (!regions.length)
    return Promise.resolve()

  const progressReporter = reporter ?? clackReplicationReporter
  progressReporter.info(title)
  progressReporter.info(`Regions: ${regions.map(r => r.label).join(' • ')}`)

  const spinner = progressReporter.spinner()
  const startedAt = Date.now()
  const totalRegions = regions.length
  let intervalId: ReturnType<typeof setInterval> | null = null

  return new Promise((resolve) => {
    const render = () => {
      const elapsed = Date.now() - startedAt
      const remaining = Math.max(0, totalMs - elapsed)
      const completed = getCompletedRegionCount(elapsed, totalRegions, totalMs)
      const percent = Math.min(100, Math.round((elapsed / totalMs) * 100))
      const bar = buildProgressBar(percent)
      const nextRegion = completed < totalRegions ? regions[completed]?.label || 'Finalizing' : 'Complete'
      const message = `${completed}/${totalRegions} regions updated • ${formatDuration(Math.ceil(remaining / 1000))} left • ${bar} • Next: ${nextRegion}`
      spinner.message(message)
    }

    spinner.start(title)
    render()
    intervalId = setInterval(render, updateIntervalMs)

    setTimeout(() => {
      if (intervalId)
        clearInterval(intervalId)
      spinner.stop(completeMessage)
      resolve()
    }, totalMs)
  })
}
