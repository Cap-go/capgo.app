export const LOG_DEBUGGING_DOC_BASE = 'https://capgo.app/docs/plugins/updater/debugging/'

export function getLogDocAnchor(action: string): string {
  return action.toLowerCase()
}

export function getLogDocUrl(action: string): string {
  return `${LOG_DEBUGGING_DOC_BASE}#${getLogDocAnchor(action)}`
}
