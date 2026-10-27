import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInstallationSql, parseArguments, validateConfiguration, validateLinkedConnection } from './configure-commerce-maintenance.mjs'

const projectRef = 'abcdefghijklmnopqrst'
const maintenanceSecret = 'synthetic_only_0123456789_0123456789'
const valid = { projectRef, linkedProjectRef: projectRef, projectUrl: `https://${projectRef}.supabase.co`, maintenanceSecret }
const rejectsWith = (action, code) => assert.throws(action, error => error.code === code)

test('installation requires a specific project and explicit scheduler exclusion', () => {
  assert.deepEqual(parseArguments([`--project-ref=${projectRef}`]), { projectRef, apply: false })
  assert.deepEqual(parseArguments([`--project-ref=${projectRef}`, '--apply', '--github-workflow-disabled']), { projectRef, apply: true })
  rejectsWith(() => parseArguments(['--apply']), 'INVALID_ARGUMENTS')
  rejectsWith(() => parseArguments([`--project-ref=${projectRef}`, '--apply']), 'DUPLICATE_SCHEDULER')
  rejectsWith(() => parseArguments([`--project-ref=${projectRef}`, '--apply', '--apply']), 'INVALID_ARGUMENTS')
  rejectsWith(() => parseArguments([`--project-ref=${projectRef}`, '--unexpected']), 'INVALID_ARGUMENTS')
})

test('URL and local Supabase link must point at the requested project', () => {
  assert.equal(validateConfiguration(valid).origin, valid.projectUrl)
  for (const projectUrl of [`http://${projectRef}.supabase.co`, `${valid.projectUrl}/other`, `${valid.projectUrl}?secret=x`, `https://user:password@${projectRef}.supabase.co`, 'https://different-project.supabase.co']) {
    rejectsWith(() => validateConfiguration({ ...valid, projectUrl }), 'PROJECT_MISMATCH')
  }
  rejectsWith(() => validateConfiguration({ ...valid, linkedProjectRef: 'zyxwvutsrqponmlkjihg' }), 'PROJECT_MISMATCH')
  rejectsWith(() => validateConfiguration({ ...valid, githubEnabled: 'true' }), 'DUPLICATE_SCHEDULER')
})

test('COPY input rejects multiline data and psql command injection', () => {
  for (const secret of ['short', `${maintenanceSecret}\n\\.\nselect 1;`, `${maintenanceSecret}\tvalue`, `${maintenanceSecret}\\`, `${maintenanceSecret}'`]) {
    rejectsWith(() => validateConfiguration({ ...valid, maintenanceSecret: secret }), 'INVALID_SECRET')
  }
})

test('linked credentials are bound to the expected project and Supabase host', () => {
  validateLinkedConnection({ PGHOST: `db.${projectRef}.supabase.co`, PGUSER: 'postgres', PGDATABASE: 'postgres', PGPORT: '5432' }, projectRef)
  const pool = { PGHOST: 'aws-1-us-east-1.pooler.supabase.com', PGUSER: `postgres.${projectRef}`, PGDATABASE: 'postgres', PGPORT: '6543' }
  validateLinkedConnection(pool, projectRef)
  validateLinkedConnection({ ...pool, PGUSER: `cli_login_postgres.${projectRef}` }, projectRef)
  for (const override of [{ PGHOST: 'localhost' }, { PGUSER: 'postgres.differentproject' }, { PGDATABASE: 'other' }, { PGPORT: '1234' }, { PGHOST: 'aws-1-us-east-1.pooler.supabase.com.evil.test' }]) {
    rejectsWith(() => validateLinkedConnection({ ...pool, ...override }, projectRef), 'DATABASE_MISMATCH')
  }
})

test('secret is transported once as COPY data and never appears in helper or cron SQL', () => {
  const sql = buildInstallationSql(validateConfiguration(valid), maintenanceSecret)
  const expectedCopy = `copy pg_temp.commerce_maintenance_input(secret) from stdin;\n${maintenanceSecret}\n\\.`
  assert.ok(sql.includes(expectedCopy))
  assert.equal(sql.split(maintenanceSecret).length, 2)
  const publicSql = sql.replace(expectedCopy, 'COPY_DATA_REDACTED')
  assert.ok(!publicSql.includes(maintenanceSecret))
  assert.match(publicSql, /security definer set search_path = ''/)
  assert.match(publicSql, /timeout_milliseconds := 60000/)
  assert.match(publicSql, /body := '\{"limit":10\}'::jsonb/)
  assert.match(publicSql, /cron\.schedule\('mozzi-commerce-reconcile','\*\/5 \* \* \* \*','select private\.invoke_commerce_maintenance\(\);'\)/)
  assert.match(publicSql, /cron\.alter_job\(job_id/)
  assert.match(publicSql, /vault\.update_secret\(secret_id, secret_value/)
  assert.ok(publicSql.indexOf('$permissions$;') < publicSql.indexOf('COPY_DATA_REDACTED'))
  assert.match(publicSql, /has_any_column_privilege/)
  assert.match(publicSql, /r\.rolname='cli_login_postgres' and pg_catalog\.pg_has_role\(r\.oid,'postgres','USAGE'\)/)
  assert.match(publicSql, /revoke all on function private\.invoke_commerce_maintenance\(\) from public, anon, authenticated, service_role/)
  assert.ok(!/create extension|alter schema|revoke all on schema|drop extension/i.test(publicSql))
})
