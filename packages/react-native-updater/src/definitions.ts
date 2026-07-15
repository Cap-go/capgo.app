export interface ManifestEntry {
  file_name: string | null
  file_hash: string | null
  download_url: string | null
}

export interface LatestVersion {
  version: string
  url?: string
  sessionKey?: string
  checksum?: string | null
  manifest?: ManifestEntry[]
  error?: string
  message?: string
  kind?: string
}

export interface BundleInfo {
  id: string
  version: string
  downloaded: string
  checksum?: string
  status: 'success' | 'error' | 'pending' | 'downloading' | 'deleted'
}

export interface DownloadOptions {
  url: string
  version: string
  sessionKey?: string
  checksum?: string
  manifest?: ManifestEntry[]
}

export interface CapgoRNUpdaterConfig {
  appId: string
  updateUrl?: string
  statsUrl?: string
  channelUrl?: string
  defaultChannel?: string
  publicKey?: string
  version?: string
  autoUpdate?: boolean
  appReadyTimeout?: number
}

export type CapgoRNUpdaterEvent =
  | 'download'
  | 'downloadComplete'
  | 'downloadFailed'
  | 'updateAvailable'
  | 'noNeedUpdate'
  | 'updateFailed'
  | 'appReady'

export interface DownloadEvent {
  percent: number
  bundle: BundleInfo
}

export interface CapgoRNUpdater {
  notifyAppReady(): Promise<BundleInfo>
  getLatest(options?: { channel?: string }): Promise<LatestVersion>
  download(options: DownloadOptions): Promise<BundleInfo>
  set(options: { id: string }): Promise<BundleInfo>
  next(options: { id: string }): Promise<BundleInfo>
  reset(options?: { toLastSuccessful?: boolean }): Promise<BundleInfo>
  current(): Promise<BundleInfo>
  list(): Promise<{ bundles: BundleInfo[] }>
  getDeviceId(): Promise<{ deviceId: string }>
  getPluginVersion(): Promise<{ version: string }>
  setChannel(options: { channel: string }): Promise<{ channel: string, status?: string }>
  getChannel(): Promise<{ channel?: string, status?: string }>
  addListener(
    eventName: CapgoRNUpdaterEvent,
    listener: (event: DownloadEvent | BundleInfo | LatestVersion | { error?: string }) => void,
  ): { remove: () => void }
}
