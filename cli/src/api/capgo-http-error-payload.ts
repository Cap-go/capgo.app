export function getCapgoCliHttpStatus(error: unknown): number | undefined {
  const context = (error as { context?: { status?: number } } | null)?.context
  return typeof context?.status === 'number' ? context.status : undefined
}

export async function readCapgoCliApiErrorPayload(error: unknown): Promise<{ error?: string, message?: string, moreInfo?: Record<string, unknown> } | null> {
  const response = (error as { context?: Response } | null)?.context
  if (!response || typeof response.clone !== 'function')
    return null
  try {
    const text = await response.clone().text()
    try {
      return JSON.parse(text) as { error?: string, message?: string, moreInfo?: Record<string, unknown> }
    }
    catch {
      return text ? { message: text } : null
    }
  }
  catch {
    return null
  }
}
