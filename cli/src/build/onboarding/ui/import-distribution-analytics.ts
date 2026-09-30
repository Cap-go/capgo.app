type DistributionChoice = 'app_store' | 'ad_hoc' | '__cancel__'
type TrackAction = (action: 'question_shown' | 'question_answered', tags: Record<string, string>) => void

export function trackImportDistributionShown(journeyId: string, trackAction: TrackAction): void {
  try {
    trackAction('question_shown', { attempt_id: journeyId, question_id: 'ios_import_distribution' })
  }
  catch {
    // Telemetry must not interrupt onboarding.
  }
}

export async function saveImportDistributionAnswer(
  save: () => Promise<void>,
  value: DistributionChoice,
  journeyId: string,
  trackAction: TrackAction,
): Promise<void> {
  await save()
  try {
    trackAction('question_answered', {
      attempt_id: journeyId,
      question_id: 'ios_import_distribution',
      choice: value === '__cancel__' ? 'switch_to_create_new' : value,
    })
  }
  catch {
    // Telemetry must not interrupt onboarding.
  }
}
