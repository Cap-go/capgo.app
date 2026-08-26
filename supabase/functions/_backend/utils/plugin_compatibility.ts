export {
  bucketPluginVersionBreakdown,
  CHANNEL_SELF_STORE_CUTOFF_CAPTION,
  CHANNEL_SELF_STORE_MIN_V5,
  CHANNEL_SELF_STORE_MIN_V6,
  CHANNEL_SELF_STORE_MIN_V7,
  CHANNEL_SELF_STORE_MIN_V8,
  CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION,
  ENCRYPTION_KEY_ID_CUTOFF_CAPTION,
  ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION,
  hasPluginVersionBreakdown,
  isLegacyChannelSelfStorePluginVersion,
  isLegacyEncryptionKeyIdPluginVersion,
  usesCurrentEncryptionKeyIdFormat,
} from '../plugin_runtime/utils/plugin_compatibility.ts'

export type { PluginVersionCompatibilityBucket } from '../plugin_runtime/utils/plugin_compatibility.ts'
