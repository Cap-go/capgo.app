type TrackSkip = (
  action: 'question_skipped',
  tags: { attempt_id: string, question_id: string, choice: string, reason: string },
  step: 'setup-method-select',
) => void

export function routeFreshIosSetupMethod(
  onMac: boolean,
  journeyId: string,
  trackAction: TrackSkip,
): 'setup-method-select' | 'api-key-instructions' {
  if (onMac)
    return 'setup-method-select'

  trackAction('question_skipped', {
    attempt_id: journeyId,
    question_id: 'ios_setup_method',
    choice: 'create-new',
    reason: 'non_macos_auto_create_new',
  }, 'setup-method-select')
  return 'api-key-instructions'
}
