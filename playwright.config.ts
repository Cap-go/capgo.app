import type { PlaywrightTestConfig } from '@playwright/test'
import { env } from 'node:process'
import { defineConfig, devices } from '@playwright/test'
import {
  getPlaywrightStripeApiBaseUrl,
  getStripeEmulatorPort,
} from './scripts/playwright-stripe'
import { getSupabaseWorktreeConfig } from './scripts/supabase-worktree-config'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// Keep local and CI Playwright runs headless so they do not steal window focus.
const headless = true
const isCi = !!env.CI
const reuseExistingServer = !isCi
const webServerTimeout = isCi ? 360_000 : 300_000
// The local Supabase edge runtime becomes unstable under parallel Chromium workers.
// Keep Playwright serial by default and allow an explicit override for debugging.
const configuredWorkers = Number(env.PLAYWRIGHT_WORKERS || '1')

const webServer: PlaywrightTestConfig['webServer'] = []
const { ports: supabasePorts } = getSupabaseWorktreeConfig()
const localSupabaseUrl = `http://127.0.0.1:${supabasePorts.api}`
const localApiDomain = `127.0.0.1:${supabasePorts.api}/functions/v1`
const localSupabaseAnonKey
  = env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const localStripeEmulatorPort = getStripeEmulatorPort(env)
const localStripeApiBaseUrl = getPlaywrightStripeApiBaseUrl(env)

if (!env.SKIP_STRIPE_EMULATOR_START) {
  webServer.push({
    command: `STRIPE_EMULATOR_PORT=${localStripeEmulatorPort} bun run stripe:emulator`,
    port: localStripeEmulatorPort,
    timeout: 60_000,
    reuseExistingServer,
    stdout: 'pipe',
  })
}
else {
  console.log('Skipping Stripe emulator server')
}

if (!env.SKIP_BACKEND_START) {
  webServer.push({
    command: `ENV=local STRIPE_SECRET_KEY=sk_test_emulator STRIPE_API_BASE_URL=${localStripeApiBaseUrl} STRIPE_WEBHOOK_SECRET=testsecret WEBAPP_URL=http://localhost:5173 bun run backend:playwright`,
    url: `${localSupabaseUrl}/functions/v1/ok`,
    timeout: webServerTimeout,
    reuseExistingServer,
  })
}
else {
  console.log('Skipping backend server')
}

if (env.SKIP_FRONTEND_START) {
  console.log('Skipping frontend server')
}
else {
  webServer.push({
    command: `ENV=local SUPA_URL=${localSupabaseUrl} SUPA_ANON=${localSupabaseAnonKey} API_DOMAIN=${localApiDomain} CAPTCHA_KEY='' bun run serve:local`,
    port: 5173,
    timeout: webServerTimeout,
    reuseExistingServer,
    stdout: 'pipe',
  })
}

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './playwright/e2e',
  /* Keep browser runs serial to avoid edge runtime CPU cancellations. */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!env.CI,
  /* Never retry, the entire thing is stateful and retries will never succeed because of the modifications to supabase in the previous attempt */
  retries: 0,
  workers: configuredWorkers,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['list', { printSteps: true }],
    ['github'],
    ['html', { outputFolder: './playwright-report/', open: 'never' }],
  ],
  use: {
    headless,
    // CI only uploads artifacts on failure, so recording passing tests just slows the run.
    trace: isCi ? 'retain-on-failure' : 'on',
    video: isCi ? 'retain-on-failure' : 'on',
    screenshot: isCi ? 'only-on-failure' : 'on',
    baseURL: 'http://localhost:5173/',
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    // storageState: 'playwright/.auth/user1.json',
  },
  expect: {
    /* CI/CD is VERY slow, I am sorry */
    timeout: 40_000,
  },
  webServer,
  // globalSetup: './tests/global-auth-setup',
  timeout: 180 * 1000,
  projects: [
    {
      name: 'chromium',
      use: {
        // storageState: 'playwright/.auth/user1.json',
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
