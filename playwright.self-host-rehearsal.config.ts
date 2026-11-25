import { defineConfig, devices } from '@playwright/test'
import { rehearsalEnvironment } from './e2e/self-host-rehearsal-env'

const env = rehearsalEnvironment()

export default defineConfig({
  testDir: './e2e',
  testMatch: 'self-host-rehearsal.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: env.web.origin,
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${env.web.port} --strictPort`,
    url: env.web.origin,
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: env.api.origin,
      VITE_SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
      VITE_APP_BASE_URL: env.web.origin,
      VITE_TURNSTILE_SITE_KEY: '',
    },
    timeout: 120_000,
  },
})
