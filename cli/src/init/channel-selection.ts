import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { formatError } from '../utils'
import { isChannelAlreadyExistsError } from './channel-conflict'

interface OnboardingChannel {
  name: string
  public: boolean
}

interface ChannelSelectionPrompts {
  reuseChannel: (name: string) => Promise<boolean>
  chooseName: (existingNames: string[]) => Promise<string>
  createChannel: (name: string) => Promise<void>
}

export async function selectOnboardingChannel(
  supabase: SupabaseClient<Database>,
  appId: string,
  preferredName: string,
  prompts: ChannelSelectionPrompts,
): Promise<string> {
  const { data, error } = await supabase
    .from('channels')
    .select('name, public')
    .eq('app_id', appId)
    .order('name')

  if (error)
    throw new Error(`Cannot check existing channels: ${formatError(error)}`)

  const channels: OnboardingChannel[] = data ?? []
  const existingChannel = channels.find(channel => channel.name === preferredName)
    ?? channels.find(channel => channel.public)
    ?? channels[0]

  if (existingChannel && await prompts.reuseChannel(existingChannel.name))
    return existingChannel.name

  const existingNames = channels.map(channel => channel.name)
  while (true) {
    const name = await prompts.chooseName(existingNames)
    if (existingNames.includes(name)) {
      if (await prompts.reuseChannel(name))
        return name
      continue
    }

    try {
      await prompts.createChannel(name)
      return name
    }
    catch (error) {
      if (!isChannelAlreadyExistsError(error))
        throw error

      existingNames.push(name)
      if (await prompts.reuseChannel(name))
        return name
    }
  }
}
