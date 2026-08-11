import path from 'node:path'
import { cwd } from 'node:process'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const rawSearchIconId = '\0vitest-raw-search-icon'

export default defineConfig(({ mode }) => ({
  plugins: [
    {
      name: 'vitest-raw-search-icon',
      enforce: 'pre',
      resolveId(id) {
        return id === '~icons/ic/round-search?raw' ? rawSearchIconId : null
      },
      load(id) {
        return id === rawSearchIconId ? 'export default "<svg />"' : null
      },
    },
    {
      name: 'vitest-vue-route-block',
      enforce: 'pre',
      transform(_, id) {
        return id.includes('vue&type=route') ? 'export default {}' : null
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
