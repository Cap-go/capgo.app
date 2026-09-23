import { getActiveChannels } from '../api/channels'
import { formatError, getCapgoCliHttpStatus, invokeCapgoCliApi } from '../utils'

interface ChannelHttpOptions {
  apikey: string
  supaHost?: string
  supaAnon?: string
}

export async function assertChannelExists(options: ChannelHttpOptions, appId: string, channelName: string) {
  const params = new URLSearchParams({
    app_id: appId,
    channel: channelName,
    page: '0',
  })
  const { data, error } = await invokeCapgoCliApi(`channel?${params.toString()}`, {
    apikey: options.apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (error) {
    if (getCapgoCliHttpStatus(error) === 404)
      throw new Error(`Channel ${channelName} not found for app ${appId}`)
    throw new Error(`Cannot load channel ${channelName}: ${formatError(error)}`)
  }

  if (!data || (Array.isArray(data) && data.length === 0))
    throw new Error(`Channel ${channelName} not found for app ${appId}`)
}

async function setChannelPublic(
  options: ChannelHttpOptions,
  appId: string,
  channelName: string,
  publicChannel: boolean,
) {
  const { error } = await invokeCapgoCliApi('channel', {
    apikey: options.apikey,
    method: 'POST',
    body: {
      app_id: appId,
      channel: channelName,
      public: publicChannel,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (error)
    throw new Error(`Could not update channel ${channelName}: ${formatError(error)}`)
}

export async function setDefaultDownloadChannel(
  options: ChannelHttpOptions,
  appId: string,
  channelName: string,
) {
  await assertChannelExists(options, appId, channelName)
  const channels = await getActiveChannels(options, appId)

  for (const channel of channels) {
    if (channel.name === channelName) {
      if (!channel.public)
        await setChannelPublic(options, appId, channel.name, true)
      continue
    }
    if (channel.public)
      await setChannelPublic(options, appId, channel.name, false)
  }
}

export async function disableDownloadChannels(options: ChannelHttpOptions, appId: string) {
  const channels = await getActiveChannels(options, appId)
  for (const channel of channels) {
    if (channel.public)
      await setChannelPublic(options, appId, channel.name, false)
  }
}
