import type { DialogV2Button, useDialogV2Store } from '~/stores/dialogv2'

export function openOnboardingResumeDialog(
  dialogStore: Pick<ReturnType<typeof useDialogV2Store>, 'openDialog' | 'onDialogDismiss'>,
  translate: (key: string) => string,
  options: { id?: string, onRestart?: NonNullable<DialogV2Button['handler']> } = {},
) {
  dialogStore.openDialog({
    id: options.id,
    title: translate('onboarding-resume-title'),
    description: translate('onboarding-resume-description'),
    preventAccidentalClose: true,
    buttons: [
      { text: translate('onboarding-resume-restart'), id: 'onboarding-resume-restart', role: 'secondary', handler: options.onRestart },
      { text: translate('onboarding-resume-continue'), id: 'onboarding-resume-continue', role: 'primary' },
    ],
  })
  return dialogStore.onDialogDismiss()
}
