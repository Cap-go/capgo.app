import { useConsole } from '~/services/console'

// Hiding a reminder never reports CI/CD as configured or changes setup progress.
export async function setCiCdReminderDismissed(appId: string, dismissed: boolean) {
  const { data, error } = await useConsole().rpc('record_app_cicd_setup', {
    p_app_id: appId,
    p_event: dismissed ? 'dismissed' : 'restored',
  })
  if (error)
    throw error
  if (data == null)
    throw new Error('CI/CD reminder update returned no onboarding state')
  return data
}
