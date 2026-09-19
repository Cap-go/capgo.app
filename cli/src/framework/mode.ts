export const CLI_PROJECT_MODES = ['cordova'] as const

export function isCordovaMode(mode?: string): boolean {
  return mode === 'cordova'
}
