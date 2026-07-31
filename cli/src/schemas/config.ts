// ============================================================================
// Capacitor Config Types
// ============================================================================

export interface CapacitorConfig {
  appId: string
  appName: string
  webDir: string
  plugins?: Record<string, any>
  android?: Record<string, any>
  [key: string]: any
}

export type ExtConfigPairs = {
  config: CapacitorConfig
  path: string
}
