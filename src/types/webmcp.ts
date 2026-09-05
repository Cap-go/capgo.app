export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean
  untrustedContentHint?: boolean
}

export interface WebMcpToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema?: Record<string, unknown>
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>
  annotations?: WebMcpToolAnnotations
}

export interface WebMcpRegisterToolOptions {
  signal?: AbortSignal
  exposedTo?: string[]
}

export interface WebMcpModelContext {
  registerTool: (
    tool: WebMcpToolDefinition,
    options?: WebMcpRegisterToolOptions,
  ) => Promise<void>
}

export interface WebMcpConsoleContext {
  authenticated: boolean
  path: string
  fullPath: string
  userId?: string
  email?: string
  isPlatformAdmin?: boolean
  organization?: {
    id: string
    name: string
    role: string | null
  }
  app?: {
    id: string
    name: string | null
  }
  channel?: {
    id: number
    name: string | null
  }
  bundle?: {
    id: number
    name: string | null
  }
  device?: {
    id: string
  }
}

export type WebMcpConsolePage
  = | 'dashboard'
    | 'apps'
    | 'app_overview'
    | 'app_bundles'
    | 'app_channels'
    | 'app_devices'
    | 'app_settings'
    | 'app_observe_updater'
    | 'app_observe_logs'
    | 'app_bundle_detail'
    | 'app_channel_detail'
    | 'org_settings'
    | 'account_settings'
