export const CLI_PROJECT_MODES = ['cordova'] as const

export type CliProjectMode = typeof CLI_PROJECT_MODES[number]

export function isCordovaMode(mode?: string): boolean {
  return mode === 'cordova'
}
