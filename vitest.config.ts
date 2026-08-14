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
      name: 'vitest-apikeys-route-block',
      enforce: 'pre',
      transform(_, id) {
        return id.includes('/src/pages/ApiKeys.vue?vue&type=route')
          ? 'export default { path: "/apikeys" }'
          : null
      },
    },
    vue(),
    Icons({ compiler: 'vue3' }),
  ],
  resolve: {
    alias: {
      '@capgo/cli/sdk': path.resolve(cwd(), 'cli/src/sdk.ts'),
      '~/': `${path.resolve(cwd(), 'src')}/`,
    },
  },
  test: {
    include: ['tests/*.test.ts'],
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
  },
}))
