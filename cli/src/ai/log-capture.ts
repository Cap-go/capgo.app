import { unlinkSync } from 'node:fs'
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const DEFAULT_BASE_DIR = '/tmp/capgo-builds'

function getBaseDir(): string {
  return process.env.CAPGO_AI_LOG_BASE_DIR || DEFAULT_BASE_DIR
}

export function getLogCapturePath(jobId: string): string {
  return join(getBaseDir(), `${jobId}.log`)
}

export function getAiPromptPath(jobId: string): string {
  return join(getBaseDir(), `${jobId}.ai-prompt.txt`)
}

export function shouldCaptureLogs(): boolean {
  return process.stdout.isTTY === true
}

interface LogCaptureFileOperations {
  appendFile: typeof appendFile
  mkdir: typeof mkdir
  readFile: typeof readFile
  unlink: typeof unlink
  writeFile: typeof writeFile
}

interface CaptureState {
  pending: Promise<void>
  writeError: Error | null
}

export interface LogCaptureLifecycle {
  startCaptureForJob: (jobId: string) => Promise<void>
  appendCapturedLine: (jobId: string, line: string) => void
  flushCapturedLogs: (jobId: string) => Promise<void>
  readCapturedLog: (jobId: string) => Promise<string>
  cleanupCapturedJobFiles: (jobId: string, opts: CleanupOptions) => Promise<void>
}

const defaultFileOperations: LogCaptureFileOperations = {
  appendFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
}

function captureError(jobId: string, operation: 'write' | 'read', error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Could not ${operation} captured Builder log for job ${jobId}: ${detail}`, { cause: error })
}

/**
 * Create an isolated capture lifecycle. The optional file-operation overrides
 * make slow and failing I/O deterministic in regression tests.
 */
export function createLogCaptureLifecycle(overrides: Partial<LogCaptureFileOperations> = {}): LogCaptureLifecycle {
  const fileOperations = { ...defaultFileOperations, ...overrides }
  const captures = new Map<string, CaptureState>()

  const startCaptureForJob = async (jobId: string): Promise<void> => {
    await fileOperations.mkdir(getBaseDir(), { recursive: true })
    await fileOperations.writeFile(getLogCapturePath(jobId), '', { flag: 'w' })
    captures.set(jobId, { pending: Promise.resolve(), writeError: null })
  }

  const appendCapturedLine = (jobId: string, line: string): void => {
    const state = captures.get(jobId)
    if (!state)
      return

    // Serialize appends per job. The queue always resolves so fire-and-forget
    // callers cannot create unhandled rejections; flushCapturedLogs surfaces
    // the first write failure at the boundary where the file is consumed.
    state.pending = state.pending.then(async () => {
      try {
        await fileOperations.appendFile(getLogCapturePath(jobId), `${line}\n`)
      }
      catch (error) {
        state.writeError ??= captureError(jobId, 'write', error)
      }
    })
  }

  const flushCapturedLogs = async (jobId: string): Promise<void> => {
    const state = captures.get(jobId)
    if (!state)
      return

    // Appends are synchronous queue operations, but loop in case another line
    // is queued while the current tail is settling.
    for (;;) {
      const pending = state.pending
      await pending
      if (pending === state.pending)
        break
    }

    if (state.writeError)
      throw state.writeError
  }

  const readCapturedLog = async (jobId: string): Promise<string> => {
    await flushCapturedLogs(jobId)
    try {
      return await fileOperations.readFile(getLogCapturePath(jobId), 'utf8')
    }
    catch (error) {
      throw captureError(jobId, 'read', error)
    }
  }

  const cleanupCapturedJobFiles = async (jobId: string, opts: CleanupOptions): Promise<void> => {
    // Cleanup remains best-effort, but it must not unlink a file while queued
    // appends are still using it. A write failure is surfaced by readers/flush;
    // cleanup waits for it to settle before removing the artifact.
    try {
      await flushCapturedLogs(jobId)
    }
    catch {
      // The capture is no longer usable, but it is now safe to remove.
    }

    try {
      await fileOperations.unlink(getLogCapturePath(jobId))
    }
    catch {
      // ignore
    }
    if (!opts.keepAiPromptFile) {
      try {
        await fileOperations.unlink(getAiPromptPath(jobId))
      }
      catch {
        // ignore
      }
    }
    captures.delete(jobId)
  }

  return {
    startCaptureForJob,
    appendCapturedLine,
    flushCapturedLogs,
    readCapturedLog,
    cleanupCapturedJobFiles,
  }
}

const defaultLifecycle = createLogCaptureLifecycle()

export const startCaptureForJob = defaultLifecycle.startCaptureForJob
export const appendCapturedLine = defaultLifecycle.appendCapturedLine
export const flushCapturedLogs = defaultLifecycle.flushCapturedLogs
export const readCapturedLog = defaultLifecycle.readCapturedLog

export interface CleanupOptions {
  keepAiPromptFile: boolean
}

export const cleanupCapturedJobFiles = defaultLifecycle.cleanupCapturedJobFiles

/**
 * Register process-level cleanup handlers. Returns a function that removes
 * the handlers (call from request.ts after the build flow finishes normally).
 */
export function registerCleanupHandlers(jobId: string, getKeepPromptFile: () => boolean): () => void {
  let cleanedUp = false
  const cleanup = async (): Promise<void> => {
    if (cleanedUp)
      return
    cleanedUp = true
    await cleanupCapturedJobFiles(jobId, { keepAiPromptFile: getKeepPromptFile() })
  }
  const cleanupSynchronously = (): void => {
    if (cleanedUp)
      return
    cleanedUp = true

    try {
      unlinkSync(getLogCapturePath(jobId))
    }
    catch {
      // ignore
    }
    if (!getKeepPromptFile()) {
      try {
        unlinkSync(getAiPromptPath(jobId))
      }
      catch {
        // ignore
      }
    }
  }

  // SIGINT cleans up and yields so the build command's own first-SIGINT
  // handler can request /build/cancel/:jobId instead of terminating locally.
  // SIGTERM has no build-specific policy, so it is re-raised after cleanup to
  // preserve Node's normal signal termination and exit status.
  //
  // uncaughtException IS different: registering ANY handler suppresses Node's
  // default exit-with-code-1 behavior, and continuing after a thrown error
  // leaves the process in an unknown state. We clean up, then re-throw so the
  // default Node behavior (print + exit) takes over.
  const onBeforeExit = () => {
    void cleanup().catch(() => {})
  }
  const onExit = () => {
    cleanupSynchronously()
  }
  const onSigint = () => {
    void cleanup().catch(() => {})
  }
  const onSigterm = () => {
    void cleanup().catch(() => {}).finally(() => {
      process.removeListener('SIGTERM', onSigterm)
      try {
        process.kill(process.pid, 'SIGTERM')
      }
      catch {
        // The process may already be terminating.
      }
    })
  }
  const onUncaught = (err: Error) => {
    void cleanup().catch(() => {}).finally(() => {
      // Re-throw only after pending writes have drained and cleanup completed,
      // preserving Node's default print + non-zero exit behavior.
      setImmediate(() => {
        throw err
      })
    })
  }

  // `exit` handlers cannot await asynchronous I/O. `beforeExit` drains the
  // ordered queue during a normal shutdown, while `exit` is a final synchronous
  // fallback for explicit termination paths.
  process.once('beforeExit', onBeforeExit)
  process.once('exit', onExit)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  process.once('uncaughtException', onUncaught)

  return () => {
    process.removeListener('beforeExit', onBeforeExit)
    process.removeListener('exit', onExit)
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('uncaughtException', onUncaught)
  }
}
