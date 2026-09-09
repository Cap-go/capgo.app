import type { Context } from 'hono'
import type { StandardSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import type { DeviceLink } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_parser.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import type { AppInfos, AppStats } from '../supabase/functions/_backend/utils/types.ts'
import { bench, describe } from 'vitest'
import { convertQueryToBody, makeDevice, parsePluginBody } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_parser.ts'
import { channelSelfGetRequestSchema, channelSelfRequestSchema, statsRequestSchema, updateRequestSchema } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_validation.ts'
import { getUpdateResponseKind, resToVersion } from '../supabase/functions/_backend/plugin_runtime/utils/update.ts'

interface ChannelSelfPayload extends AppInfos {
  channel: string
}

const postContext = { req: { method: 'POST' } } as Context
const getContext = { req: { method: 'GET' } } as Context
const channelSelfGetSchema = channelSelfGetRequestSchema as StandardSchema<DeviceLink>

const updatePayload: AppInfos = {
  app_id: 'com.capgo.bench',
  device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  platform: 'ios',
  plugin_version: '8.45.0',
  version_name: '1.0.0',
  version_build: '1.0.0',
  version_os: '18.2',
  defaultChannel: 'production',
  is_prod: true,
  is_emulator: false,
  key_id: 'abcdefghijklmnopqrst',
}

const statsPayload: AppStats = {
  ...updatePayload,
  device_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  platform: 'android',
  action: 'set',
}

const channelSelfPayload: ChannelSelfPayload = {
  ...updatePayload,
  device_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  channel: 'production',
}

const channelSelfQuery = {
  app_id: updatePayload.app_id,
  device_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  platform: 'ios',
  plugin_version: '8.45.0',
  version_name: '1.0.0',
  version_build: '1.0.0',
  version_os: '18.2',
  defaultChannel: 'production',
  channel: 'production',
  custom_id: 'customer-42',
  is_emulator: 'false',
  is_prod: 'true',
  key_id: 'abcdefghijklmnopqrst',
}

const manifestEntries = Array.from({ length: 25 }, (_, index) => ({
  file_name: `assets/chunk-${index}.js`,
  file_hash: `hash-${index}`,
  s3_path: `apps/com.capgo.bench/1.2.3/chunk-${index}.js`,
  download_url: `https://files.capgo.app/chunk-${index}.js`,
}))

const appVersion = {
  name: '1.2.3',
  session_key: 'session-key',
  checksum: 'sha256-checksum',
  link: 'https://capgo.app/changelog/1.2.3',
  comment: 'Benchmark release',
} as Database['public']['Tables']['app_versions']['Row']

const updateErrorCodes = [
  'no_new_version_available',
  'already_on_builtin',
  'disable_auto_update_to_major',
  'disable_device',
  'key_id_mismatch',
  'semver_error',
  'no_channel',
]

describe('plugin endpoint request parsing', () => {
  bench('/updates payload validation', () => {
    parsePluginBody(postContext, { ...updatePayload }, updateRequestSchema)
  })

  bench('/stats payload validation', () => {
    parsePluginBody(postContext, { ...statsPayload }, statsRequestSchema)
  })

  bench('/channel_self set payload validation', () => {
    parsePluginBody(postContext, { ...channelSelfPayload }, channelSelfRequestSchema)
  })

  bench('/channel_self GET query normalization', () => {
    parsePluginBody(getContext, convertQueryToBody(channelSelfQuery), channelSelfGetSchema, false)
  })

  bench('device row normalization', () => {
    makeDevice(statsPayload)
  })
})

describe('plugin endpoint response shaping', () => {
  bench('/updates manifest response with metadata', () => {
    resToVersion('8.45.0', 'https://files.capgo.app/bundle.zip', appVersion, manifestEntries, true)
  })

  bench('/updates error kind classification', () => {
    for (const code of updateErrorCodes)
      getUpdateResponseKind(code)
  })
})
