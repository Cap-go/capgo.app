import type { useDialogV2Store } from '~/stores/dialogv2'

type DialogStore = Pick<ReturnType<typeof useDialogV2Store>, 'openDialog' | 'onDialogDismiss'>

export async function confirmConsequentialChannelChange(
  dialogStore: DialogStore,
  buttonLabels: { cancel: string, confirm: string },
  options: {
    id: string
    title: string
    description: string
    confirmRole?: 'primary' | 'secondary' | 'danger' | 'cancel'
    onConfirm: () => Promise<void>
  },
) {
  let confirmInFlight = false
  dialogStore.openDialog({
    id: options.id,
    title: options.title,
    description: options.description,
    preventAccidentalClose: true,
    buttons: [
      {
        text: buttonLabels.cancel,
        role: 'cancel',
        handler: async () => {
          if (confirmInFlight)
            return false
        },
      },
      {
        text: buttonLabels.confirm,
        role: options.confirmRole ?? 'primary',
        handler: async () => {
          if (confirmInFlight)
            return false
          confirmInFlight = true
          try {
            await options.onConfirm()
          }
          finally {
            confirmInFlight = false
          }
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}
