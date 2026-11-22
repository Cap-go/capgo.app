export const TERMINAL_IDLE_MS = 10 * 60 * 1000
export const TERMINAL_MAX_SESSION_MINUTES = 60
export const TERMINAL_MAX_CONCURRENCY_PER_ORG = 2
export const TERMINAL_COMMAND_TIMEOUT_MS = 120_000
export const TERMINAL_OUTPUT_MAX_BYTES = 256 * 1024
export const TERMINAL_WORKSPACE_ROOT = '/workspace/project'

export const TERMINAL_EGRESS_ALLOWLIST = [
  'registry.npmjs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
] as const