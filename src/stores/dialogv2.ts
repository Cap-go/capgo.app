import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, watch } from 'vue'

export interface DialogV2Button {
  text: string
  id?: string
  href?: string
  target?: '_self' | '_blank' | '_parent' | '_top'
  rel?: string
  handler?: () => void | boolean | Promise<void | boolean>
  role?: 'primary' | 'secondary' | 'danger' | 'cancel'
  preventClose?: boolean
  disabled?: boolean
  skipNavigation?: boolean
}

export interface DialogV2Options {
  id?: string
  title?: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
  buttons?: DialogV2Button[]
  preventAccidentalClose?: boolean
}

export const useDialogV2Store = defineStore('dialogv2', () => {
  const showDialog = ref(false)
  const dialogOptions = ref<DialogV2Options>({})
  const dialogCanceled = ref(false)
  const lastButtonRole = ref('')
  const pendingDialogAction = ref(false)

  const assignDialogButtonsDisabled = (disabled: boolean) => {
    const current = dialogOptions.value
    if (!current.buttons?.length)
      return
    dialogOptions.value = {
      ...current,
      buttons: current.buttons.map(button => ({ ...button, disabled })),
    }
  }

  const openDialog = (options: DialogV2Options) => {
    pendingDialogAction.value = false
    dialogOptions.value = options
    showDialog.value = true
    dialogCanceled.value = false
    lastButtonRole.value = ''
  }

  const openButtonHref = (button: DialogV2Button) => {
    if (!button.href)
      return

    if (typeof window === 'undefined')
      return

    if (button.target === '_blank') {
      const relTokens = button.rel
        ? button.rel.split(/[\s,]+/).map(token => token.toLowerCase())
        : []
      const relSet = new Set<string>()
      relSet.add('noopener')
      if (relTokens.includes('noreferrer'))
        relSet.add('noreferrer')
      const relFeatures = Array.from(relSet).join(',')
      window.open(button.href, button.target, relFeatures)
      return
    }

    if (button.target && button.target !== '_self')
      window.open(button.href, button.target)
    else
      window.location.assign(button.href)
  }

  const closeDialog = async (button?: DialogV2Button) => {
    if (!button) {
      // Modal dismissed without a button action (overlay, escape, close icon)
      dialogCanceled.value = true
      lastButtonRole.value = ''
      showDialog.value = false
      pendingDialogAction.value = false
      return
    }

    if (button.disabled || pendingDialogAction.value)
      return

    pendingDialogAction.value = true
    lastButtonRole.value = button.id ?? button.role ?? ''
    dialogCanceled.value = button.role === 'cancel'
    assignDialogButtonsDisabled(true)

    try {
      if (button.handler) {
        const result = await button.handler()
        // If handler returns false, don't close the dialog
        if (result === false) {
          if (showDialog.value)
            assignDialogButtonsDisabled(false)
          return
        }
      }

      if (!button.preventClose) {
        showDialog.value = false
        if (button.href && !button.skipNavigation)
          openButtonHref(button)
        return
      }

      if (showDialog.value)
        assignDialogButtonsDisabled(false)
    }
    catch (error) {
      if (showDialog.value)
        assignDialogButtonsDisabled(false)
      throw error
    }
    finally {
      pendingDialogAction.value = false
    }
  }

  const onDialogDismiss = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const unwatch = watch(showDialog, (val) => {
        if (!val) {
          resolve(dialogCanceled.value)
          unwatch()
        }
      })
    })
  }
  return {
    showDialog,
    dialogOptions,
    dialogCanceled,
    lastButtonRole,
    openDialog,
    closeDialog,
    onDialogDismiss,
  }
})

if (import.meta.hot)
  import.meta.hot.accept(acceptHMRUpdate(useDialogV2Store, import.meta.hot))
