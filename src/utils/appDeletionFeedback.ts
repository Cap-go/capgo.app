export const APP_DELETION_REASONS = [
  'app_id_wrong',
  'setup_failed',
  'duplicate_test',
  'replacing_app',
  'no_longer_needed',
  'other',
] as const

export type AppDeletionReason = typeof APP_DELETION_REASONS[number]

export const APP_DELETION_DETAILS = {
  app_id_wrong: ['expected_different_id', 'capgo_changed_ending', 'entered_incorrectly', 'wrong_project', 'not_sure'],
  setup_failed: ['local_project_connection', 'cli_command_failed', 'first_bundle_failed', 'wrong_organization', 'setup_in_progress', 'not_sure'],
  duplicate_test: ['created_by_mistake', 'temporary_test', 'same_app_exists', 'onboarding_created_extra', 'not_sure'],
  replacing_app: ['fixing_app_id', 'restarting_setup', 'moving_organization', 'rebuilt_local_project', 'switching_environments', 'not_sure'],
  no_longer_needed: ['app_discontinued', 'project_paused', 'no_ota_updates', 'moving_service', 'cost', 'technical_limitations', 'not_sure'],
  other: ['something_else', 'no_feedback'],
} as const satisfies Record<AppDeletionReason, readonly string[]>

export type AppDeletionDetail = typeof APP_DELETION_DETAILS[AppDeletionReason][number]

export interface AppDeletionFeedback {
  reason: AppDeletionReason | null
  detail: AppDeletionDetail | null
  note: string
}

export function canContinueAppDeletion(feedback: Pick<AppDeletionFeedback, 'reason'>) {
  return feedback.reason !== null
}

export function isAppDeletionConfirmationValid(confirmation: string, appId: string) {
  return confirmation === appId
}

export function getAppDeletionTrackingProperties(
  feedback: AppDeletionFeedback,
  context: { appId: string, orgId?: string },
) {
  return {
    app_id: context.appId,
    ...(context.orgId ? { org_id: context.orgId } : {}),
    ...(feedback.reason ? { deletion_reason: feedback.reason } : {}),
    ...(feedback.detail ? { deletion_detail: feedback.detail } : {}),
    ...(feedback.note.trim() ? { deletion_note: feedback.note.trim() } : {}),
    feedback_opt_out: feedback.reason === 'other' && feedback.detail === 'no_feedback',
  }
}
