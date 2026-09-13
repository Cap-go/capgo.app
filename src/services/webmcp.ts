import type { WebMcpModelContext } from '~/types/webmcp'

export class WebMcpAuthError extends Error {
  constructor(message = 'Authentication required. Sign in to the Capgo console first.') {
    super(message)
    this.name = 'WebMcpAuthError'
  }
}

export function getModelContext(): WebMcpModelContext | null {
  const documentContext = typeof document !== 'undefined'
    ? (document as Document & { modelContext?: WebMcpModelContext }).modelContext
    : undefined
  if (documentContext && typeof documentContext.registerTool === 'function')
    return documentContext

  const navigatorContext = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { modelContext?: WebMcpModelContext }).modelContext
    : undefined
  if (navigatorContext && typeof navigatorContext.registerTool === 'function')
    return navigatorContext

  return null
}

export function isWebMcpSupported(): boolean {
  return getModelContext() !== null
}

export async function registerWebMcpTool(
  modelContext: WebMcpModelContext,
  tool: Parameters<WebMcpModelContext['registerTool']>[0],
  options?: Parameters<WebMcpModelContext['registerTool']>[1],
): Promise<void> {
  try {
    await modelContext.registerTool(tool, options)
  }
  catch (error) {
    if (options?.signal?.aborted)
      return
    console.warn(`WebMCP: failed to register tool "${tool.name}"`, error)
  }
}
