import path from 'node:path'
import { cwd, env } from 'node:process'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudflareWorkerUrl } from './scripts/cloudflare-test-config.ts'

export default defineConfig(({ mode }) => ({
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
    bail: 0,
    testTimeout: env.CI ? 60_000 : 30_000, // 60s in CI, 30s locally
    hookTimeout: 10_000,
    // Very low concurrency for plugin tests that hit shared replica state
    maxConcurrency: 1, // Run tests sequentially
    maxWorkers: 1, // Single worker
    env: {
      ...loadEnv(mode, cwd(), ''),
      USE_CLOUDFLARE_WORKERS: 'true',
      CLOUDFLARE_API_URL: cloudflareWorkerUrl('CLOUDFLARE_API_URL', 8787),
      CLOUDFLARE_PLUGIN_URL: cloudflareWorkerUrl('CLOUDFLARE_PLUGIN_URL', 8788),
      CLOUDFLARE_FILES_URL: cloudflareWorkerUrl('CLOUDFLARE_FILES_URL', 8789),
    },
  },
}))
