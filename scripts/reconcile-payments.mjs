// Opt-in scheduled maintenance. Credentials never appear in arguments or logs.
const base = new URL(process.env.MOZZI_SUPABASE_URL ?? '')
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Configure a secure Supabase project URL')
const secret = process.env.MOZZI_MAINTENANCE_SECRET
if (!secret || secret.length < 32) throw new Error('Configure the maintenance secret in the scheduler secret store')
const response = await fetch(new URL('/functions/v1/reconcile-payments', base), {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-maintenance-secret': secret },
  body: JSON.stringify({ limit: 10 }), signal: AbortSignal.timeout(60_000), redirect: 'error',
})
if (!response.ok) throw new Error(`Payment maintenance returned HTTP ${response.status}; review server logs`)
const result = await response.json()
if (!Number.isInteger(result.reconciled) || !Number.isInteger(result.failed) || result.failed !== 0) throw new Error('Payment reconciliation did not complete successfully')
console.log(JSON.stringify({ reconciled: result.reconciled, expired: result.expired, failed: result.failed }))
