export type BuildCancellationResult
  = | { ok: true }
    | { ok: false, message: string }

// npx can deliver one physical Ctrl+C to the CLI twice: once through the
// foreground process group and once when its wrapper forwards SIGINT.
export const DUPLICATE_SIGINT_WINDOW_MS = 500

export interface BuildCancellationRequestOptions {
  url: string
  headers: Record<string, string>
  appId: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function requestBuildCancellation(options: BuildCancellationRequestOptions): Promise<BuildCancellationResult> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? 4_000)

  try {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify({ app_id: options.appId }),
      signal: abortController.signal,
    })
    if (!response.ok) {
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      return { ok: false, message: `Build cancellation request failed: HTTP ${status}` }
    }
    return { ok: true }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Build cancellation request failed: ${message}` }
  }
  finally {
    clearTimeout(timeout)
  }
}

export interface BuildCancellationSignalHandlerOptions {
  requestCancellation: () => Promise<BuildCancellationResult>
  onCancellationStarted: () => void
  onCancellationResult: (result: BuildCancellationResult) => void
  abortLogStream: () => void
  forceExit: (code: number) => void
  now?: () => number
  duplicateSignalWindowMs?: number
}

export function createBuildCancellationSignalHandler(options: BuildCancellationSignalHandlerOptions): () => Promise<void> {
  const now = options.now ?? Date.now
  const duplicateSignalWindowMs = options.duplicateSignalWindowMs ?? DUPLICATE_SIGINT_WINDOW_MS
  let firstSignalAt: number | null = null

  return async () => {
    const signalAt = now()
    if (firstSignalAt !== null) {
      if (signalAt - firstSignalAt <= duplicateSignalWindowMs)
        return
      options.forceExit(1)
      return
    }

    firstSignalAt = signalAt
    options.onCancellationStarted()
    const result = await options.requestCancellation()
    options.onCancellationResult(result)
    options.abortLogStream()
  }
}
