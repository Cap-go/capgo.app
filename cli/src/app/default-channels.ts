import { fetchCliChannels } from '../api/cli-data'
import { formatError, invokeCapgoCliApi } from '../utils'

interface ChannelHttpOptions {
  apikey: string
  apiHost?: string
}

// Channel reads use the caller-key CLI route (channel.read), not GET /channel
// (app.read_channels), so keys that could change channels before still can.
async function loadChannels(options: ChannelHttpOptions, appId: string, channelName?: string) {
  try {
    return await fetchCliChannels(options, appId, channelName)
  }
  catch (error) {
    throw new Error(`Cannot load channel${channelName ? ` ${channelName}` : 's'}: ${formatError(error)}`)
  }
}

export async function assertChannelExists(options: ChannelHttpOptions, appId: string, channelName: string) {
  const channels = await loadChannels(options, appId, channelName)
  if (!channels.some(channel => channel.name === channelName))
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
    apiHost: options.apiHost,
  })

  if (error)
    throw new Error(`Could not update channel ${channelName}: ${formatError(error)}`)
}

export async function setDefaultDownloadChannel(
  options: ChannelHttpOptions,
  appId: string,
  channelName: string,
) {
  const channels = await loadChannels(options, appId)
  const target = channels.find(channel => channel.name === channelName)
  if (!target)
    throw new Error(`Channel ${channelName} not found for app ${appId}`)

  // Enable the target first so a later failure never leaves the app without a public channel.
  if (!target.public)
    await setChannelPublic(options, appId, channelName, true)

  for (const channel of channels) {
    if (channel.name !== channelName && channel.public)
      await setChannelPublic(options, appId, channel.name, false)
  }
}

export async function disableDownloadChannels(options: ChannelHttpOptions, appId: string) {
  const channels = await loadChannels(options, appId)
  for (const channel of channels) {
    if (channel.public)
      await setChannelPublic(options, appId, channel.name, false)
  }
}
