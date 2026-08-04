import type { GitHubProfile } from '~/services/githubProfile'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { getGitHubProfile, GitHubProfileError } from '~/services/githubProfile'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'

export function useGitHubProfileDialog(dialogId = 'github-profile') {
  const { t } = useI18n()
  const supabase = useSupabase()
  const main = useMainStore()
  const dialogStore = useDialogV2Store()

  const githubUsername = ref(main.user?.github_username ?? '')
  const githubUsernameInput = ref('')
  const githubProfile = ref<GitHubProfile | null>(null)
  const githubProfileLoading = ref(false)
  const githubProfileSaving = ref(false)
  const githubProfileError = ref('')
  let githubProfileLookupGeneration = 0

  watch(() => main.user?.github_username, (value) => {
    githubUsername.value = value ?? ''
  })

  function resetGitHubProfileDialog() {
    githubProfileLookupGeneration += 1
    githubProfile.value = null
    githubProfileError.value = ''
    githubProfileLoading.value = false
  }

  function closeGitHubProfileDialog() {
    resetGitHubProfileDialog()
    dialogStore.closeDialog({ text: t('button-cancel'), role: 'cancel' })
  }

  function openGitHubProfileDialog() {
    resetGitHubProfileDialog()
    githubUsernameInput.value = githubUsername.value
    dialogStore.openDialog({
      id: dialogId,
      title: t('github-username'),
      description: t('github-username-dialog-description'),
      size: 'sm',
      buttons: [],
      preventAccidentalClose: true,
    })
  }

  async function findGitHubProfile() {
    const username = githubUsernameInput.value.trim()
    if (githubProfileLoading.value || !username)
      return

    const lookupGeneration = githubProfileLookupGeneration
    githubUsernameInput.value = username
    githubProfileError.value = ''
    githubProfileLoading.value = true
    try {
      const profile = await getGitHubProfile(username)
      if (lookupGeneration === githubProfileLookupGeneration)
        githubProfile.value = profile
    }
    catch (error) {
      if (lookupGeneration !== githubProfileLookupGeneration)
        return

      githubProfile.value = null
      if (error instanceof GitHubProfileError)
        githubProfileError.value = t(`github-username-error-${error.code}`)
      else
        githubProfileError.value = t('github-username-error-request_failed')
    }
    finally {
      if (lookupGeneration === githubProfileLookupGeneration)
        githubProfileLoading.value = false
    }
  }

  async function confirmGitHubProfile() {
    if (!githubProfile.value || !main.user?.id || githubProfileSaving.value)
      return

    const userId = main.user.id
    const dialogGeneration = githubProfileLookupGeneration
    githubProfileSaving.value = true
    const { data: user, error } = await supabase
      .from('users')
      .update({
        github_id: githubProfile.value.id,
        github_username: githubProfile.value.login,
      })
      .eq('id', userId)
      .select()
      .single()

    githubProfileSaving.value = false
    if (main.user?.id !== userId)
      return

    if (error || !user) {
      githubProfile.value = null
      githubProfileError.value = t('account-error')
      return
    }

    main.user = user
    githubUsername.value = user.github_username ?? ''
    if (dialogGeneration !== githubProfileLookupGeneration)
      return

    toast.success(t('account-updated-succ'))
    dialogStore.closeDialog({ text: t('confirm'), role: 'primary' })
    resetGitHubProfileDialog()
  }

  async function clearGitHubProfile() {
    if (!main.user?.id || githubProfileSaving.value)
      return

    const userId = main.user.id
    githubProfileSaving.value = true
    const { data: user, error } = await supabase
      .from('users')
      .update({
        github_id: null,
        github_username: null,
      })
      .eq('id', userId)
      .select()
      .single()

    githubProfileSaving.value = false
    if (main.user?.id !== userId)
      return

    if (error || !user) {
      githubProfileError.value = t('account-error')
      return
    }

    main.user = user
    githubUsername.value = ''
    toast.success(t('account-updated-succ'))
    dialogStore.closeDialog({ text: t('button-remove'), role: 'danger' })
    resetGitHubProfileDialog()
  }

  return {
    dialogId,
    dialogStore,
    githubUsername,
    githubUsernameInput,
    githubProfile,
    githubProfileLoading,
    githubProfileSaving,
    githubProfileError,
    openGitHubProfileDialog,
    closeGitHubProfileDialog,
    findGitHubProfile,
    confirmGitHubProfile,
    clearGitHubProfile,
  }
}
