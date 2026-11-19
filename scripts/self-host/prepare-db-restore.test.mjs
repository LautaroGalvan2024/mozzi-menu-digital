import assert from 'node:assert/strict'
import test from 'node:test'
import { copyCounts, restoreVerificationSql, selectManagedRestoreEntries } from './prepare-db-restore.mjs'

const entries = [
  'TABLE DATA auth users supabase_auth_admin',
  'TABLE DATA auth identities supabase_auth_admin',
  'TABLE DATA auth mfa_factors supabase_auth_admin',
  'TABLE DATA auth sessions supabase_auth_admin',
  'TABLE DATA auth webauthn_credentials supabase_auth_admin',
  'TABLE DATA storage buckets supabase_storage_admin',
  'TABLE DATA storage objects supabase_storage_admin',
  'TRIGGER auth users on_auth_user_created supabase_auth_admin',
  'TRIGGER storage objects protect_objects_delete supabase_storage_admin',
  'POLICY storage objects restaurant_assets_admin_delete supabase_storage_admin',
  'POLICY storage objects restaurant_assets_admin_insert supabase_storage_admin',
  'POLICY storage objects restaurant_assets_admin_update supabase_storage_admin',
  'POLICY storage objects restaurant_assets_public_read supabase_storage_admin',
  'PUBLICATION TABLE public supabase_realtime order_events postgres',
  'PUBLICATION TABLE public supabase_realtime orders postgres',
].map((entry, index) => `${index + 1}; 0 0 ${entry}`)

test('selects application customizations and excludes session and object rows', () => {
  const result = selectManagedRestoreEntries(entries)
  assert.equal(result.data.length, 4)
  assert.equal(result.ddl.length, 7)
  assert.equal(result.reviewAuth.length, 1)
  assert.match(result.reviewAuth[0], /webauthn_credentials/)
  assert(result.data.some((entry) => /TABLE DATA auth mfa_factors /.test(entry)))
  assert(!result.data.some((entry) => /sessions|storage objects/.test(entry)))
})

test('renewing MFA keeps users and identities and excludes only the old factor data from restore', () => {
  const ordinary = selectManagedRestoreEntries(entries)
  const renewed = selectManagedRestoreEntries(entries, { renewMfaOnLogin: true })
  assert.deepEqual(renewed.data, ordinary.data.filter((entry) => !entry.includes('auth mfa_factors')))
  assert.deepEqual(renewed.ddl, ordinary.ddl)
  assert.deepEqual(renewed.reviewAuth, ordinary.reviewAuth)
  assert.throws(() => selectManagedRestoreEntries(entries.filter((entry) => !entry.includes('auth mfa_factors')), {
    renewMfaOnLogin: true,
  }), /alcance revisado/)
})

test('verifies zero factors after MFA renewal and the released order transaction privileges', () => {
  const appCounts = new Map([['public.orders', 1]])
  const authCounts = new Map([['auth.users', 2], ['auth.identities', 2]])
  const renewed = restoreVerificationSql(appCounts, authCounts, { renewMfaOnLogin: true })
  assert.match(renewed, /\(SELECT count\(\*\) FROM auth\.mfa_factors\) <> 0/)
  assert.match(renewed, /\(SELECT count\(\*\) FROM auth\.users\) <> 2/)
  assert.match(renewed, /\(SELECT count\(\*\) FROM auth\.identities\) <> 2/)
  assert.match(renewed, /OR has_function_privilege\('anon', 'public\.create_order_transaction\(jsonb,text,text,text\)', 'execute'\)/)
  assert.match(renewed, /OR has_function_privilege\('authenticated', 'public\.create_order_transaction\(jsonb,text,text,text\)', 'execute'\)/)
  assert.match(renewed, /OR NOT has_function_privilege\('service_role', 'public\.create_order_transaction\(jsonb,text,text,text\)', 'execute'\)/)
  const ordinary = restoreVerificationSql(appCounts, new Map([...authCounts, ['auth.mfa_factors', 1]]))
  assert.match(ordinary, /\(SELECT count\(\*\) FROM auth\.mfa_factors\) <> 1/)
})

test('fails closed when a new policy or trigger appears in a managed schema', () => {
  assert.throws(() => selectManagedRestoreEntries([
    ...entries, '99; 0 0 POLICY auth users different_policy supabase_auth_admin',
  ]), /alcance revisado/)
  assert.throws(() => selectManagedRestoreEntries([
    ...entries, '99; 0 0 TRIGGER storage buckets different_trigger supabase_storage_admin',
  ]), /alcance revisado/)
})

test('summarizes COPY rows identically for LF and CRLF', () => {
  const lines = [
    'COPY public.products (id, name) FROM stdin;',
    '1\tArtículo de prueba',
    '2\tEjemplo',
    '\\.',
    'COPY public.orders (id) FROM stdin;',
    '\\.',
  ]
  const expected = new Map([['public.products', 2], ['public.orders', 0]])
  assert.deepEqual(copyCounts(lines.join('\n')), expected)
  assert.deepEqual(copyCounts(lines.join('\r\n')), expected)
})

test('rejects broken COPY boundaries without showing fixture values', () => {
  assert.throws(() => copyCounts('COPY public.products (id) FROM stdin;\n1'), {
    message: 'El respaldo contiene un bloque COPY incompleto.',
  })
})
