import type { Context } from 'hono'
import type { PluginRegion } from '../plugin_runtime/utils/pluginRegionTargets.ts'
import { parsePluginRegions } from '../plugin_runtime/utils/pluginRegionTargets.ts'
import { existInEnv, getEnv } from './utils.ts'

const PLUGIN_REGION_TARGETS_ENV = 'PLUGIN_REGION_TARGETS'

export type { PluginRegion }

export const PLUGIN_REGIONS: PluginRegion[] = [
  { name: 'eu', envName: 'capgo_plugin-eu-prod', url: 'https://plugin.eu.capgo.app/ok' },
  { name: 'me', envName: 'capgo_plugin-me-prod', url: 'https://plugin.me.capgo.app/ok' },
  { name: 'hk', envName: 'capgo_plugin-hk-prod', url: 'https://plugin.hk.capgo.app/ok' },
  { name: 'jp', envName: 'capgo_plugin-jp-prod', url: 'https://plugin.jp.capgo.app/ok' },
  { name: 'as', envName: 'capgo_plugin-as-prod', url: 'https://plugin.as.capgo.app/ok' },
  { name: 'na', envName: 'capgo_plugin-na-prod', url: 'https://plugin.na.capgo.app/ok' },
  { name: 'af', envName: 'capgo_plugin-af-prod', url: 'https://plugin.af.capgo.app/ok' },
  { name: 'oc', envName: 'capgo_plugin-oc-prod', url: 'https://plugin.oc.capgo.app/ok' },
  { name: 'sa', envName: 'capgo_plugin-sa-prod', url: 'https://plugin.sa.capgo.app/ok' },
]

export function getConfiguredPluginRegions(c: Context) {
  if (!existInEnv(c, PLUGIN_REGION_TARGETS_ENV))
    return PLUGIN_REGIONS

  return parsePluginRegions(getEnv(c, PLUGIN_REGION_TARGETS_ENV))
}
