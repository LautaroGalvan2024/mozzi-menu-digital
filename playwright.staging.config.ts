import { defineConfig, devices } from '@playwright/test'
import { validateAcceptanceEnvironment } from './scripts/e2e/staging-safety.mjs'

const stagingSafety = validateAcceptanceEnvironment(process.env)
if (!/^[a-f0-9]{64}$/.test(process.env.MOZZI_ACCEPTANCE_LAUNCH ?? '') || !process.env.MOZZI_ACCEPTANCE_OUTPUT) {
  throw new Error('Use scripts/e2e/run-staging.mjs; direct invocation is refused')
}

export default defineConfig({
  testDir: './e2e', testMatch: 'live-flows.spec.ts', fullyParallel: false,
  forbidOnly: true, workers: 1, retries: 0, repeatEach: 1,
  timeout: 60_000, globalTimeout: 300_000, maxFailures: 1,
  reporter: './scripts/e2e/staging-reporter.mjs',
  outputDir: process.env.MOZZI_ACCEPTANCE_OUTPUT, preserveOutput: 'never',
  use: {
    ...devices['Desktop Chrome'], baseURL: stagingSafety.appOrigin,
    trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block',
    acceptDownloads: false, ignoreHTTPSErrors: false,
    launchOptions: { args: ['--disable-background-networking', '--dns-prefetch-disable', '--no-pings'] },
    stagingSafety,
  },
  projects: [{ name: 'isolated-acceptance' }],
})
