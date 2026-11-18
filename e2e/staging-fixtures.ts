import { test as base, expect } from '@playwright/test'
import { guardedRequestContext, installBrowserGuard } from '../scripts/e2e/staging-safety.mjs'

type Safety = { target: 'local' | 'staging'; appOrigin: string; apiOrigin: string; actionId: string }

// The normal runner retains its existing configuration and fixtures. Only the
// dedicated validated acceptance configuration supplies this option.
export const test = base.extend<{ stagingSafety: Safety | null }>({
  stagingSafety: [null, { option: true }],
  context: async ({ context, stagingSafety }, run) => {
    const verify = stagingSafety ? await installBrowserGuard(context, stagingSafety) : undefined
    await run(context)
    verify?.()
  },
  request: async ({ request, stagingSafety }, run) => {
    await run(stagingSafety ? guardedRequestContext(request, stagingSafety) : request)
  },
})

export { expect }
