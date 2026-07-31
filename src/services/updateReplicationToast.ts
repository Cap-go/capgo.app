import type { VNode } from 'vue'
import { h } from 'vue'
import { toast } from 'vue-sonner'
import { i18n } from '~/modules/i18n'

interface DeploymentRegion {
  code: string
  label: string
}

interface DeploymentToastContext {
  eventLabel: string
  route?: string | null
  actionLabel?: string
  onAction?: () => void
}

type Timer = ReturnType<typeof setInterval>
type Timeout = ReturnType<typeof setTimeout>

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

const TOTAL_REPLICATION_MS = 60_000
const UPDATE_INTERVAL_MS = 500
const REPLICATION_TOAST_CLASSES = {
  content: 'w-full min-w-0',
  toast: 'replication-toast',
}
const REPLICATION_DONE_TOAST_STYLE = {
  '--initial-height': 'auto',
}

function getCurrentTimeZone(): string | null {
  if (typeof Intl === 'undefined')
    return null

  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
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

  if (typeof navigator !== 'undefined') {
    const language = navigator.language?.toLowerCase() || ''
    if (language.endsWith('-in'))
      return 'aws:ap-south-1'
    if (language.endsWith('-br') || language.endsWith('-ar'))
      return 'aws:sa-east-1'
    if (language.endsWith('-jp'))
      return 'aws:ap-northeast-1'
    if (language.endsWith('-za'))
      return 'gcp:africa-south1'
  }

  return null
}

function getOrderedRegions(): DeploymentRegion[] {
  const sorted = [...DEPLOYMENT_REGIONS]
  const closestCode = getClosestRegionFromTimeZone()
  if (!closestCode)
    return sorted

  const idx = sorted.findIndex(region => region.code === closestCode)
  if (idx < 0)
    return sorted

  const [closest] = sorted.splice(idx, 1)
  sorted.push(closest)
  return sorted
}

function formatDuration(seconds: number) {
  return i18n.global.t('replication-toast-time-left', { seconds })
}

function buildActionButton(actionLabel?: string, onAction?: () => void): VNode | null {
  if (!actionLabel || !onAction)
    return null

  return h('div', { class: 'mt-2 flex justify-center' }, [
    h('button', {
      class: [
        'inline-flex h-9 w-fit items-center justify-center rounded-md px-4',
        'bg-slate-900 text-sm font-medium text-white',
        'border border-transparent hover:bg-slate-800',
        'cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
        'transition-none',
      ].join(' '),
      type: 'button',
      onClick: onAction,
    }, actionLabel),
  ])
}

function buildStatusList(regions: DeploymentRegion[], completed: number): VNode[] {
  return regions.map((region, index) => {
    const isDone = index < completed
    const isActive = index === completed && completed < regions.length
    const statusClass = isDone
      ? 'bg-emerald-500 text-emerald-500'
      : isActive
        ? 'bg-amber-500 text-amber-500'
        : 'bg-slate-300 text-slate-300'

    return h('li', { class: 'flex min-w-0 w-full items-start gap-1.5 pr-0' }, [
      h('span', {
        class: [`inline-block h-2 w-2 shrink-0 rounded-full border-2 border-current ${statusClass} mt-1`].join(' '),
      }),
      h('span', {
        class: `min-w-0 flex-1 text-xs ${isDone ? 'text-green-700' : isActive ? 'text-amber-700' : 'text-slate-700'}`,
      }, region.label),
    ])
  })
}

function getToastTitle() {
  return i18n.global.t('replication-toast-title')
}

function buildDescription(
  regions: DeploymentRegion[],
  completed: number,
  remainingMs: number,
  actionLabel?: string,
  onAction?: () => void,
): VNode {
  const total = regions.length
  const safeCompleted = Math.min(completed, total)
  const percent = Math.min(100, Math.round((safeCompleted / total) * 100))
  const regionRows = buildStatusList(regions, safeCompleted)
  const actionButton = buildActionButton(actionLabel, onAction)

  return h('div', { class: 'w-full flex flex-col gap-1.5' }, [
    h('div', { class: 'text-sm text-slate-700' }, i18n.global.t('replication-toast-regions-replicated', {
      completed: safeCompleted,
      total,
    })),
    h('div', { class: 'text-xs text-slate-600' }, formatDuration(Math.max(0, Math.ceil(remainingMs / 1000)))),
    h('div', { class: 'h-1.5 w-full rounded bg-slate-200 overflow-hidden' }, [
      h('div', {
        class: 'h-full rounded bg-emerald-400 transition-all',
        style: `width: ${percent}%`,
      }),
    ]),
    h('ul', { class: 'w-full space-y-0.5 list-none pl-0 pr-0' }, regionRows),
    ...(actionButton ? [actionButton] : []),
  ])
}

function buildDoneDescription(regions: DeploymentRegion[], actionLabel?: string, onAction?: () => void): VNode {
  const actionButton = buildActionButton(actionLabel, onAction)

  return h('div', { class: 'w-full flex flex-col gap-1.5' }, [
    h('div', { class: 'text-sm text-slate-700' }, i18n.global.t('replication-toast-complete')),
    h('ul', { class: 'w-full space-y-0.5 list-none pl-0 pr-0' }, buildStatusList(regions, regions.length)),
    ...(actionButton ? [actionButton] : []),
  ])
}

function getCompletedRegionCount(elapsedMs: number, regionCount: number): number {
  if (regionCount <= 0)
    return 0
  const clampedElapsed = Math.min(Math.max(elapsedMs, 0), TOTAL_REPLICATION_MS)
  return Math.floor((clampedElapsed / TOTAL_REPLICATION_MS) * regionCount)
}

export function isUploadReplicationEvent(eventLabel: string): boolean {
  const event = eventLabel.toLowerCase()
  return event.includes('upload') && (event.includes('bundle') || event.includes('update') || event.includes('version'))
}

export function showUploadReplicationToast({
  eventLabel: _eventLabel,
  route,
  actionLabel,
  onAction,
}: DeploymentToastContext): void {
  const regions = getOrderedRegions()
  if (!regions.length)
    return

  const hasAction = route && onAction && actionLabel

  const regionCount = regions.length
  const startedAt = Date.now()
  let finished = false
  let intervalId: Timer | null = null
  let timeoutId: Timeout | null = null
  let toastId: string | number

  const update = () => {
    if (finished)
      return

    const elapsed = Date.now() - startedAt
    const remaining = Math.max(0, TOTAL_REPLICATION_MS - elapsed)
    const completed = getCompletedRegionCount(elapsed, regionCount)
    toast(getToastTitle(), {
      id: toastId,
      descriptionClass: 'w-full',
      classes: REPLICATION_TOAST_CLASSES,
      description: buildDescription(
        regions,
        completed,
        remaining,
        hasAction ? actionLabel : undefined,
        hasAction ? onAction : undefined,
      ),
      duration: remaining + 5000,
    })
  }

  const cleanup = () => {
    if (finished)
      return
    finished = true
    if (intervalId)
      clearInterval(intervalId)
    if (timeoutId)
      clearTimeout(timeoutId)
  }

  const finalize = () => {
    if (finished)
      return
    cleanup()
    toast(i18n.global.t('replication-toast-globally-available'), {
      id: toastId,
      descriptionClass: 'w-full',
      classes: REPLICATION_TOAST_CLASSES,
      style: REPLICATION_DONE_TOAST_STYLE,
      description: buildDoneDescription(
        regions,
        hasAction ? actionLabel : undefined,
        hasAction ? onAction : undefined,
      ),
      duration: 6000,
    })
  }

  const toastTitle = getToastTitle()
  toastId = toast(toastTitle, {
    descriptionClass: 'w-full',
    classes: REPLICATION_TOAST_CLASSES,
    description: buildDescription(
      regions,
      0,
      TOTAL_REPLICATION_MS,
      hasAction ? actionLabel : undefined,
      hasAction ? onAction : undefined,
    ),
    duration: TOTAL_REPLICATION_MS + 5000,
    onDismiss: cleanup,
  })

  intervalId = setInterval(update, UPDATE_INTERVAL_MS)
  timeoutId = setTimeout(() => finalize(), TOTAL_REPLICATION_MS)
}
