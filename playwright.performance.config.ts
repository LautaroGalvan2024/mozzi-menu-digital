import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4174'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'performance.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results/performance',
  reporter: process.env.CI
    ? [['html', { open: 'never', outputFolder: 'playwright-report/performance' }], ['github']]
    : 'list',
  timeout: 45_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    // Tracing records every protocol event and distorts the timings this suite measures.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-performance.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
