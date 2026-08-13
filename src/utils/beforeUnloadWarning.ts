import { onBeforeUnmount, onMounted } from 'vue'

function registerBeforeUnloadWarning() {
  const handler = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    event.returnValue = true
  }
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}
export function useBeforeUnloadWarning(enabled: boolean) {
  let cleanup = () => {}
  onMounted(() => enabled && (cleanup = registerBeforeUnloadWarning()))
  onBeforeUnmount(() => cleanup())
  return () => cleanup()
}
