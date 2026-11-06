import { writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { env } from 'node:process'
import { parentPort, threadId } from 'node:worker_threads'

function emit(line: string): void {
  try {
    if (parentPort)
      parentPort.postMessage({ type: 'setup-debug', line })
    else
      writeSync(2, `${line}\n`)
  }
  catch {
    // Diagnostics must never affect the foreground command or worker lifetime.
  }
}

export function setupDebug(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  if (env.CAPGO_SETUP_DEBUG !== '1')
    return
  const details = Object.entries({ thread: threadId, ...fields }).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(' ')
  emit(`[setup-debug +${Math.round(performance.now())}ms] ${event} ${details}`)
}

export function relaySetupDebug(message: { type?: string, line?: unknown }): void {
  if (env.CAPGO_SETUP_DEBUG === '1' && message?.type === 'setup-debug' && typeof message.line === 'string' && message.line.startsWith('[setup-debug '))
    emit(message.line)
}

export function setupError(error: unknown): string {
  // Never log raw errors, request headers, URLs or response bodies (may contain keys).
  const name = error instanceof Error ? error.name : ''
  const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined
  const code = cause?.code
  const safeCode = typeof code === 'string' && ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : undefined
  return [(['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'Error'].includes(name) ? name : 'unknown'), safeCode].filter(Boolean).join(':')
}
