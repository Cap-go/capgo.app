export const WAIT_LOG_LOOKBACK_MS = 5 * 60 * 1000
export const WAIT_LOG_POLL_MS = 5000
export const WAIT_LOG_CONTINUE_HINT = 'Press C to continue if you already verified the update in the Capgo dashboard'

export interface WaitLogQuery {
  appId: string
  devicesId?: string[]
  order: { key: string, sortable: 'asc' | 'desc' }[]
  rangeStart: string
}

export function buildWaitLogQuery(appId: string, deviceId: string | undefined, now = new Date(), lookbackMs = WAIT_LOG_LOOKBACK_MS): WaitLogQuery {
  return {
    appId,
    // Only filter by a real device id. Passing an org UUID here matches nothing
    // and the wait loop never sees dashboard logs.
    devicesId: deviceId ? [deviceId] : undefined,
    order: [{
      key: 'created_at',
      sortable: 'desc',
    }],
    rangeStart: new Date(now.getTime() - lookbackMs).toISOString(),
  }
}

export function isWaitLogContinueKey(input: string, ctrl = false): boolean {
  if (ctrl)
    return false
  const key = input.replace(/\r|\n/g, '')
  return key === 'c' || key === 'C'
}
