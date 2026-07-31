// src/init/mcp/progress.ts
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import tmp from 'tmp'
import { getConfigWriteTarget } from '../../config'

export interface LiveUpdateProgress {
  step_done: number
  appId?: string
  channelName?: string
  platform?: 'ios' | 'android'
  currentVersion?: string
  delta?: boolean
  encryptionEnabled?: boolean
}

function progressPath(): string {
  const configTarget = getConfigWriteTarget()
  const suffix = configTarget
    ? `-${createHash('sha256').update(configTarget).digest('hex')}`
    : ''
  return join(tmp.tmpdir, `capgocli-live-update-progress${suffix}.json`)
}

export function loadLiveUpdateProgress(): LiveUpdateProgress | null {
  try {
    const raw = readFileSync(progressPath(), 'utf8')
    if (!raw)
      return null
    const parsed = JSON.parse(raw) as LiveUpdateProgress
    if (!Number.isInteger(parsed.step_done) || parsed.step_done < 0)
      return null
    return parsed
  }
  catch {
    return null
  }
}

export function saveLiveUpdateProgress(data: LiveUpdateProgress): void {
  writeFileSync(progressPath(), JSON.stringify(data))
}

export function clearLiveUpdateProgress(): void {
  try {
    rmSync(progressPath())
  }
  catch {
    // ignore
  }
}
