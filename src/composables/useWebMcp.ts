import { onUnmounted, watch } from 'vue'
import { getModelContext } from '~/services/webmcp'
import { registerConsoleWebMcpTools } from '~/services/webmcpConsoleTools'
import { useMainStore } from '~/stores/main'

export function useWebMcp(): void {
  const route = useRoute()
  const router = useRouter()
  const main = useMainStore()

  let registrationController: AbortController | null = null

  async function refreshTools(): Promise<void> {
    const modelContext = getModelContext()
    if (!modelContext)
      return

    registrationController?.abort()
    registrationController = new AbortController()
    const currentController = registrationController

    await registerConsoleWebMcpTools(modelContext, {
      route,
      router,
      authenticated: !!main.auth,
      signal: currentController.signal,
    })
  }

  watch(
    () => [route.fullPath, main.auth?.id] as const,
    () => {
      void refreshTools()
    },
    { immediate: true },
  )

  onUnmounted(() => {
    registrationController?.abort()
    registrationController = null
  })
}
