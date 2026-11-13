import { defineConfig, mergeConfig } from 'vitest/config'
import pluginConfig from './vitest.config.cloudflare-plugin.ts'

/**
 * The Cloudflare plugin suite against the KV plugin state: the workers run
 * with PLUGIN_STATE_KV=on (authoritative, strict), and the setup drains the
 * state sync before every plugin request (tests/plugin-kv-state.setup.ts).
 */
export default defineConfig(env => mergeConfig(
  typeof pluginConfig === 'function' ? pluginConfig(env) : pluginConfig,
  defineConfig({
    test: {
      setupFiles: ['./tests/plugin-kv-state.setup.ts'],
      env: {
        PLUGIN_STATE_KV_TESTS: 'true',
      },
    },
  }),
))
