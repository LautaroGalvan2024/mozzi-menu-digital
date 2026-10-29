import { build } from 'vite'

// Public, non-secret fixture values baked only into the isolated performance
// bundle. The browser test intercepts every request to this host.
process.env.VITE_SUPABASE_URL = 'https://e2e.invalid'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_e2e_performance_not_a_real_key'
process.env.VITE_APP_BASE_URL = 'http://127.0.0.1:4174'
process.env.VITE_TURNSTILE_SITE_KEY = ''

await build({
  mode: 'performance',
  build: {
    outDir: '.tmp/performance-dist',
    emptyOutDir: true,
  },
})
