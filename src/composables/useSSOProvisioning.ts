import type { Session } from '~/services/consoleClient'
import { ref } from 'vue'
import { provisionSsoUser } from '~/services/ssoProvisioning'

export function useSSOProvisioning() {
  const isProvisioning = ref(false)
  const error = ref<string | null>(null)

  async function provisionUser(session: Session): Promise<{ merged: boolean, alreadyMember: boolean }> {
    isProvisioning.value = true
    error.value = null

    try {
      const result = await provisionSsoUser(session)
      if (result.error) {
        console.error('SSO provisioning failed', result.error)
        error.value = result.error
      }
      return {
        merged: result.merged,
        alreadyMember: result.alreadyMember,
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : 'SSO provisioning failed'
      console.error('SSO provisioning error:', message)
      error.value = message
      return { merged: false, alreadyMember: false }
    }
    finally {
      isProvisioning.value = false
    }
  }

  return { isProvisioning, error, provisionUser }
}
