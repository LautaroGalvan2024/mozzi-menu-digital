import { defineConfig, devices } from '@playwright/test'

const localBaseURL = 'http://127.0.0.1:4173'
const externalBaseURL = process.env.E2E_BASE_URL?.trim()
const useMockEnvironment = !externalBaseURL && process.env.E2E_LIVE !== '1'

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'performance.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: externalBaseURL || localBaseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173',
        url: localBaseURL,
        // Process environment takes precedence over Vite's .env.local values.
        // Live and externally hosted suites keep their explicit configuration.
        env: useMockEnvironment
          ? {
              VITE_SUPABASE_URL: 'https://e2e.invalid',
              VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_mock_not_a_real_key',
              VITE_APP_BASE_URL: localBaseURL,
              VITE_TURNSTILE_SITE_KEY: '',
            }
          : undefined,
        // An existing server could have loaded real credentials from .env.local.
        reuseExistingServer: !useMockEnvironment && !process.env.CI,
        timeout: 120_000,
      },
})
