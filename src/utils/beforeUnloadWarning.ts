export function registerBeforeUnloadWarning(enabled: boolean) {
  if (!enabled)
    return () => {}
  const handler = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    event.returnValue = true
  }
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}
