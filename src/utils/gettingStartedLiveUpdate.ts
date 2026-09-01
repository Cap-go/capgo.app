export interface LiveUpdateChannelRef {
  id: number
  name: string
  public: boolean
}

export function pickProductionChannel<T extends LiveUpdateChannelRef>(channels: T[]): T | null {
  return channels.find(channel => channel.public) ?? channels.find(channel => channel.name.toLowerCase() === 'production') ?? null
}

export function liveUpdateChannelPath(appId: string, channelId: number | null | undefined): string {
  if (channelId)
    return `/app/${encodeURIComponent(appId)}/channel/${channelId}`
  return `/app/${encodeURIComponent(appId)}/channels`
}

export function liveUpdateUploadPath(appId: string): string {
  return `/app/${encodeURIComponent(appId)}/bundles/new?guide=live-update`
}

export function isLiveUpdateGuide(value: unknown): boolean {
  return value === 'live-update'
}
