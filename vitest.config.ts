import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cwd } from 'node:process'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const rawIconId = '\0vitest-raw-icon'

export default defineConfig(({ mode }) => ({
  plugins: [
    {
      name: 'vitest-auth-email-templates',
      enforce: 'pre',
      async load(id) {
        if (!id.includes('/cloudflare_workers/api/email_templates/') || !/\.(?:html|txt)$/.test(id))
          return null
        return `export default ${JSON.stringify(await readFile(id, 'utf8'))}`
      },
    },
    {
      name: 'vitest-raw-icon',
      enforce: 'pre',
      resolveId(id) {
        return id.startsWith('~icons/') && id.endsWith('?raw') ? rawIconId : null
      },
      load(id) {
        return id === rawIconId ? 'export default "<svg />"' : null
      },
    },
    {
      name: 'vitest-route-block',
      enforce: 'pre',
      transform(_, id) {
        if (!id.includes('?vue&type=route'))
          return null
        return id.includes('/src/pages/ApiKeys.vue') ? 'export default { path: "/apikeys" }' : 'export default {}'
      },
    },
    vue(),
    Icons({ compiler: 'vue3' }),
  ],
  resolve: {
    // Bun keeps a stale nested Vue next to Pinia/vue-i18n. A second Vue copy
    // breaks reactivity between stores and components.
    dedupe: ['vue', '@vue/runtime-core', '@vue/runtime-dom', '@vue/reactivity', '@vue/shared'],
    alias: {
      '@capgo/cli/sdk': path.resolve(cwd(), 'cli/src/sdk.ts'),
      '~/': `${path.resolve(cwd(), 'src')}/`,
      '@capgo/capacitor-notifications': path.resolve(cwd(), 'packages/capacitor-notifications/src/index.ts'),
    },
  },
  test: {
    include: ['tests/*.test.ts'],
    setupFiles: ['./tests/happy-dom-storage.setup.ts'],
    environment: 'node',
    watch: false,
    // Let the run report all failures rather than stopping at the first one.
    bail: 0,
    testTimeout: 30_000, // Increased from 20s to handle slow edge function responses
    hookTimeout: 30_000, // Seed + edge warm under sharded CI needs headroom
    retry: 0,
    maxConcurrency: 2, // Keep edge-function load under Deno capacity in CI shards
    // Cap workers so shards do not open too many cold isolates at once (502 from Kong).
    maxWorkers: 2,
    // Vitest 4: pool options are now top-level
    isolate: true,
    fileParallelism: true,
    // Allow graceful shutdown of workers
    teardownTimeout: 15_000,
    // Sequence to reduce parallel load on edge functions
    sequence: {
      shuffle: false, // Run in predictable order
    },
    env: loadEnv(mode, cwd(), ''),
    // External node_modules resolve Vue from the package folder. Pinia still
    // points at a stale Vue 3.5.40, so store updates never reach components.
    server: {
      deps: {
        inline: ['pinia', 'vue-i18n', 'vue-router', 'vue-sonner', '@vueuse/core', '@vueuse/shared', '@vue/devtools-api'],
      },
    },
  },
}))
