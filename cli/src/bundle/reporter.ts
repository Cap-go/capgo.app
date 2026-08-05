import { AsyncLocalStorage } from 'node:async_hooks'
import { intro, log, outro, spinner } from '@clack/prompts'

export interface UploadSpinner {
  start: (message: string) => void
  message: (message: string) => void
  stop: (message?: string) => void
  error: (message: string) => void
}

export interface UploadReporter {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  success: (message: string) => void
  intro: (message: string) => void
  outro: (message: string) => void
  spinner: () => UploadSpinner
}

export const clackUploadReporter: UploadReporter = {
  info: message => log.info(message),
  warn: message => log.warn(message),
  error: message => log.error(message),
  success: message => log.success(message),
  intro,
  outro,
  spinner,
}

const uploadReporterStorage = new AsyncLocalStorage<UploadReporter>()

export function getUploadReporter(): UploadReporter {
  return uploadReporterStorage.getStore() ?? clackUploadReporter
}

/**
 * Returns the reporter only while an internal upload explicitly supplies one.
 * Shared helpers use this to preserve normal Clack output outside the Ink flow.
 */
export function getActiveUploadReporter(): UploadReporter | undefined {
  const reporter = uploadReporterStorage.getStore()
  return reporter === clackUploadReporter ? undefined : reporter
}

export function runWithUploadReporter<T>(reporter: UploadReporter | undefined, action: () => Promise<T>): Promise<T> {
  if (!reporter)
    return action()
  return uploadReporterStorage.run(reporter, action)
}
