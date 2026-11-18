# Connected acceptance, isolated fixtures only

`node scripts/e2e/run-staging.mjs` executes exactly the four cases in
`e2e/live-flows.spec.ts`. It does not seed data or start services. It refuses
missing fixtures, production destinations, extra CLI arguments and unknown
`E2E_*` settings before spawning a browser or contacting a service.

Use `node scripts/e2e/run-staging.mjs --validate-only` to validate without IO.
Environment files may be loaded explicitly with Node's `--env-file` option;
this entrypoint never loads `.env.local` automatically. Do not commit fixtures,
passwords or tokens. The command forwards only approved settings to Playwright.

Required in both modes:

| Variable | Value |
| --- | --- |
| `E2E_TARGET` | `local` or `staging` |
| `E2E_STAGING_CONFIRM` | `isolated-synthetic-fixtures` |
| `E2E_LIVE` / `E2E_CREATE_ORDER` | Both explicitly `1` |
| `E2E_BASE_URL` | Exact frontend origin, without trailing slash |
| `E2E_SUPABASE_URL` | Exact API origin, without trailing slash |
| `E2E_RESTAURANT_SLUG` | Published, active synthetic restaurant, currently open |
| `E2E_PRODUCT_NAME` | Exact name of an available simple product; no required options |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | Confirmed, active synthetic operator without MFA, with one active membership |
| `E2E_ACTION_ID` | UUID of a generated/unaccepted fixture order in that restaurant |
| `E2E_RESTAURANT_ID` | Optional fixture UUID; validated when supplied |

The fixture needs pickup and a manual payment method, an affordable minimum,
and Turnstile disabled in the isolated application. The runner intentionally
blocks third-party challenge/analytics/font/image services and WhatsApp.

`local` permits only frontend `http://127.0.0.1:4188` and API
`http://127.0.0.1:54821`; `E2E_SUPABASE_PROJECT_REF` must be absent or `local`.
`staging` requires a separate HTTPS frontend plus
`E2E_SUPABASE_PROJECT_REF` (20 lowercase letters) matching
`https://<ref>.supabase.co`. The documented production project and application
domains, including subdomains of the production custom domain, are denied.
Changing a URL does not certify an environment is isolated: the operator must
provide dedicated synthetic fixtures and a separately configured backend.

Every browser HTTP/WebSocket destination must match one of those two origins.
Service workers are blocked; HTTP redirects are refused even when same-origin.
Use the canonical frontend URL. APIRequestContext permits only the fixture's
claim GET and its authorized `get_order_by_action` read, with zero redirects.
Browser/transport restrictions also apply to popups and frames. A denied
request fails the test rather than silently treating incomplete coverage as success.

Traces, screenshots and videos are disabled. The reporter emits only fixed
statuses and counts, never response bodies or raw errors. Temporary test output
is removed on normal completion/failure. Do not force-kill the runner; a process
or host crash can leave a temporary `mozzi-acceptance-*` directory requiring
private cleanup. Four passing tests, with zero skipped tests, are required for
a successful exit. Automatic test retries are disabled to avoid duplicate orders.

Safety tests use local synthetic HTTP listeners and Chromium, without a real
backend: `node --test scripts/e2e/staging-safety.test.mjs`.
