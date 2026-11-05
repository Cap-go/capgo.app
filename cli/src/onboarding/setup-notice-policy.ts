export const ONBOARDING_CHECK_GRACE_MS = 5_000

export interface NoticeOutputOptions {
  json?: boolean
  outputText?: boolean
  quiet?: boolean
  silent?: boolean
  format?: string
}

let commandAllowsNotices = true

function allowsNoticeOutput(options: NoticeOutputOptions): boolean {
  return !options.json && !options.outputText && !options.quiet && !options.silent && !options.format
}

export function setNoticeOutputOptions(options: NoticeOutputOptions): void {
  commandAllowsNotices = allowsNoticeOutput(options)
}

export function shouldPrintNotice(options: NoticeOutputOptions): boolean {
  return commandAllowsNotices && allowsNoticeOutput(options)
}

// Explicit setup flows already display their own checklist. Machine output and
// account-wide commands must not acquire an unrelated project's setup footer.
const noticeCommands = new Set([
  'doctor',
  'get-qr',
  'app add',
  'app debug',
  'app set',
  'bundle upload',
  'bundle compatibility',
  'bundle delete',
  'bundle list',
  'bundle cleanup',
  'bundle zip',
  'channel add',
  'channel delete',
  'channel list',
  'channel currentBundle',
  'channel set',
  'channel promote',
  'build request',
])
const mutatingCommands = new Set([
  'app add',
  'app set',
  'bundle upload',
  'bundle delete',
  'bundle cleanup',
  'channel add',
  'channel delete',
  'channel set',
  'channel promote',
  'build request',
])

export function shouldEvaluateSetupNotice(command: string, options: Record<string, unknown>): boolean {
  return noticeCommands.has(command) && shouldPrintNotice(options)
}

export function shouldRefreshSetupProgress(command: string): boolean {
  return mutatingCommands.has(command)
}
