import type { DiffLine } from './diff-utils.js'
import type { BuildScriptChoice, PackageManager } from './workflow-generator.js'
import { resolveOwnerOrgId } from '../../analytics/org-resolver.js'
import { findSavedKeySilent, sendEvent } from '../../utils.js'

export type BuildOnboardingWorkflowEvent
  = | 'workflow-preview-prepared'
    | 'workflow-preview-action'
    | 'workflow-diff-opened'
    | 'workflow-diff-closed'
    | 'workflow-file-written'

export type BuildOnboardingWorkflowDecision = 'write' | 'view' | 'cancel' | 'escape' | 'close'
export type BuildOnboardingWorkflowState = 'new' | 'replace' | 'identical'

export interface WorkflowDiffTelemetry {
  workflowState: BuildOnboardingWorkflowState
  diffLines: number
  diffAdded: number
  diffRemoved: number
}

interface TrackBuildOnboardingWorkflowOptions extends WorkflowDiffTelemetry {
  event: BuildOnboardingWorkflowEvent
  appId: string
  platform: 'ios' | 'android'
  apikey?: string
  /** Correlation id tying every event from one onboarding run together. */
  journeyId?: string
  decision?: BuildOnboardingWorkflowDecision
  packageManager?: PackageManager
  buildScriptType?: BuildScriptChoice['type']
}

const WORKFLOW_EVENT_NAMES: Record<BuildOnboardingWorkflowEvent, string> = {
  'workflow-preview-prepared': 'Build onboarding workflow preview prepared',
  'workflow-preview-action': 'Build onboarding workflow preview action',
  'workflow-diff-opened': 'Build onboarding workflow diff opened',
  'workflow-diff-closed': 'Build onboarding workflow diff closed',
  'workflow-file-written': 'Build onboarding workflow file written',
}

export function getWorkflowDiffTelemetry(lines: DiffLine[], isNew: boolean): WorkflowDiffTelemetry {
  const diffAdded = lines.filter(line => line.kind === 'add').length
  const diffRemoved = lines.filter(line => line.kind === 'del').length
  const workflowState = lines.length > 0 && diffAdded === 0 && diffRemoved === 0
    ? 'identical'
    : (isNew ? 'new' : 'replace')

  return {
    workflowState,
    diffLines: lines.length,
    diffAdded,
    diffRemoved,
  }
}

export function trackBuildOnboardingWorkflowEvent(options: TrackBuildOnboardingWorkflowOptions): void {
  void trackBuildOnboardingWorkflowEventAsync(options)
}

async function trackBuildOnboardingWorkflowEventAsync(options: TrackBuildOnboardingWorkflowOptions): Promise<void> {
  const apikey = options.apikey?.trim() || findSavedKeySilent()
  if (!apikey)
    return

  const orgId = await resolveOwnerOrgId(apikey, options.appId)
  const tags: Record<string, string | number | boolean> = {
    'app-id': options.appId,
    'platform': options.platform,
    'workflow-state': options.workflowState,
    'diff-lines': options.diffLines,
    'diff-added': options.diffAdded,
    'diff-removed': options.diffRemoved,
  }

  if (options.journeyId)
    tags.journey_id = options.journeyId
  if (options.decision)
    tags.decision = options.decision
  if (options.packageManager)
    tags['package-manager'] = options.packageManager
  if (options.buildScriptType)
    tags['build-script-type'] = options.buildScriptType

  await sendEvent(apikey, {
    channel: 'native-builder',
    event: WORKFLOW_EVENT_NAMES[options.event],
    org_id: orgId,
    tracking_version: 2,
    tags,
  })
}
