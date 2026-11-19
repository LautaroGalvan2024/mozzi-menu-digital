import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checksum, validateCheckpoint } from '../database/backup-core.mjs'
import { pgBinary, run } from '../database/connection.mjs'

const managedTable = /^\d+; \d+ \d+ TABLE DATA (auth|storage) (\w+) \w+$/
const mfaFactorsTable = 'auth.mfa_factors'
const restoreTables = new Set(['auth.users', 'auth.identities', mfaFactorsTable, 'storage.buckets'])
const runtimeAuthTables = new Set([
  'sessions', 'refresh_tokens', 'mfa_challenges', 'mfa_amr_claims', 'flow_state',
  'one_time_tokens', 'schema_migrations', 'webauthn_challenges', 'saml_relay_states', 'oauth_client_states',
])
const managedDdl = /^\d+; \d+ \d+ (?:TRIGGER auth users on_auth_user_created supabase_auth_admin|POLICY storage objects restaurant_assets_(?:admin_delete|admin_insert|admin_update|public_read) supabase_storage_admin|PUBLICATION TABLE public supabase_realtime (?:order_events|orders) postgres)$/
const platformTriggers = new Set([
  'realtime subscription tr_check_filters supabase_realtime_admin',
  'storage buckets enforce_bucket_name_length_trigger supabase_storage_admin',
  'storage buckets enforce_versioning_status_transition supabase_storage_admin',
  'storage buckets protect_active_lifecycle_states supabase_storage_admin',
  'storage buckets protect_bucket_control_insert supabase_storage_admin',
  'storage buckets protect_bucket_control_update supabase_storage_admin',
  'storage buckets protect_bucket_control_update_role supabase_storage_admin',
  'storage buckets protect_buckets_delete supabase_storage_admin',
  'storage buckets wake_lifecycle_on_policy_write supabase_storage_admin',
  'storage buckets wake_lifecycle_on_versioning_enable supabase_storage_admin',
  'storage objects protect_objects_delete supabase_storage_admin',
  'storage objects update_objects_updated_at supabase_storage_admin',
])
const publicGrants = /^GRANT USAGE ON SCHEMA public TO (postgres|anon|authenticated|service_role);\r?$/gm

class RestorePreparationError extends Error {}

function check(condition, message) {
  if (!condition) throw new RestorePreparationError(message)
}

function readBackup(directory) {
  const project = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
  check(/^[a-z]{20}$/.test(project), 'El proyecto Supabase de origen no está identificado.')
  const state = JSON.parse(readFileSync(path.join(directory, 'snapshot-checkpoint.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  check(manifest.complete === true && manifest.formatVersion === 2 && manifest.source === project
    && manifest.snapshotCapturedAt === state.snapshotCapturedAt && state.assets.length === state.objects.length
    && ['counts', 'files', 'assets'].every((key) => JSON.stringify(manifest[key]) === JSON.stringify(state[key])),
  'Se necesita un manifiesto completo del mismo corte que el respaldo.')
  try {
    validateCheckpoint(state, project, (relative, hash) => {
      const file = path.resolve(directory, relative)
      return file.startsWith(directory + path.sep) && file === realpathSync(file) && checksum(file) === hash
    })
  } catch {
    throw new RestorePreparationError('El checkpoint no coincide con los archivos respaldados.')
  }
  return state.counts
}

function renderArchive(binary, archive, args) {
  const result = spawnSync(binary, [...args, '--file=-', archive], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  check(result.status === 0, 'pg_restore falló al leer el archivo. El diagnóstico se omitió para proteger los datos.')
  return result.stdout.toString('utf8')
}

export function copyCounts(sql) {
  const counts = new Map()
  let table = ''
  for (const line of sql.split(/\r?\n/)) {
    if (table) {
      if (line === '\\.') table = ''
      else counts.set(table, counts.get(table) + 1)
      continue
    }
    const header = /^COPY (\S+) \([^)]+\) FROM stdin;$/.exec(line)
    if (header) {
      table = header[1]
      check(!counts.has(table), 'El respaldo contiene bloques COPY repetidos.')
      counts.set(table, 0)
    }
  }
  check(!table, 'El respaldo contiene un bloque COPY incompleto.')
  return counts
}

export function selectManagedRestoreEntries(entries, { renewMfaOnLogin = false } = {}) {
  const data = []
  const selectedTables = new Set()
  const reviewAuth = []
  const ddl = []
  for (const line of entries) {
    const table = managedTable.exec(line)
    const tableName = table && `${table[1]}.${table[2]}`
    if (tableName && restoreTables.has(tableName)) {
      check(!selectedTables.has(tableName), 'El respaldo repite una tabla gestionada.')
      selectedTables.add(tableName)
      if (!renewMfaOnLogin || tableName !== mfaFactorsTable) data.push(line)
    } else if (table?.[1] === 'auth' && !runtimeAuthTables.has(table[2])) {
      reviewAuth.push(line)
    }

    if (managedDdl.test(line)) {
      ddl.push(line)
      continue
    }
    const trigger = /^\d+; \d+ \d+ TRIGGER ((?:auth|storage|realtime) .+)$/.exec(line)
    check((!trigger || platformTriggers.has(trigger[1]))
      && !/^\d+; \d+ \d+ POLICY (?:auth|storage|realtime) /.test(line)
      && !/^\d+; \d+ \d+ PUBLICATION TABLE public supabase_realtime /.test(line),
    'Las personalizaciones y tablas gestionadas difieren del alcance revisado.')
  }
  check(selectedTables.size === restoreTables.size && ddl.length === 7,
    'Las personalizaciones y tablas gestionadas difieren del alcance revisado.')
  return { data, reviewAuth, ddl }
}

function preflight() {
  return String.raw`\set ON_ERROR_STOP on
\set VERBOSITY terse
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $target$
BEGIN
  IF current_database() <> 'postgres' OR session_user <> 'supabase_admin'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR current_setting('data_directory') <> '/var/lib/postgresql/data'
     OR pg_is_in_recovery()
     OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN
    RAISE EXCEPTION 'Se requiere Supabase Postgres 17 aislado y supabase_admin.';
  END IF;
  IF to_regnamespace('private') IS NOT NULL OR to_regnamespace('supabase_migrations') IS NOT NULL
     OR to_regclass('public.restaurants') IS NOT NULL OR EXISTS (SELECT FROM auth.users)
     OR EXISTS (SELECT FROM auth.identities) OR EXISTS (SELECT FROM auth.mfa_factors)
     OR EXISTS (SELECT FROM auth.sessions) OR EXISTS (SELECT FROM auth.refresh_tokens)
     OR EXISTS (SELECT FROM storage.buckets) OR EXISTS (SELECT FROM storage.objects) THEN
    RAISE EXCEPTION 'Se requiere un entorno nuevo con Auth y Storage inicializados.';
  END IF;
  IF NOT has_database_privilege('postgres', current_database(), 'CREATE')
     OR NOT has_schema_privilege('postgres', 'public', 'CREATE')
     OR NOT has_schema_privilege('postgres', 'auth', 'USAGE')
     OR NOT has_table_privilege('postgres', 'auth.users', 'SELECT')
     OR NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'supabase_realtime')
     OR EXISTS (
       SELECT FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       JOIN pg_roles r ON r.oid = a.grantee
       WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
         AND r.rolname IN ('anon', 'authenticated', 'service_role')
     ) THEN
    RAISE EXCEPTION 'Revisar los privilegios base y la publicacion de Realtime.';
  END IF;
END
$target$;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
SET LOCAL ROLE postgres;`
}

export function restoreVerificationSql(appCounts, authCounts, { renewMfaOnLogin = false } = {}) {
  const expectedAuthCounts = new Map(authCounts)
  if (renewMfaOnLogin) expectedAuthCounts.set(mfaFactorsTable, 0)
  const rowChecks = [...appCounts, ...expectedAuthCounts]
    .map(([table, count]) => `(SELECT count(*) FROM ${table}) <> ${count}`).join('\n     OR ')
  return `DO $verification$
BEGIN
  IF ${rowChecks}
     OR EXISTS (SELECT FROM auth.sessions) OR EXISTS (SELECT FROM auth.refresh_tokens)
     OR EXISTS (SELECT FROM storage.objects) THEN
    RAISE EXCEPTION 'Los conteos del destino difieren del respaldo.';
  END IF;
  IF EXISTS (SELECT FROM auth.identities i LEFT JOIN auth.users u ON u.id = i.user_id WHERE u.id IS NULL)
     OR EXISTS (SELECT FROM auth.mfa_factors f LEFT JOIN auth.users u ON u.id = f.user_id WHERE u.id IS NULL)
     OR EXISTS (
       SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'private', 'supabase_migrations') AND c.relowner <> 'postgres'::regrole
     )
     OR EXISTS (
       SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'private') AND p.proowner <> 'postgres'::regrole
     )
     OR NOT has_function_privilege('anon', 'public.get_public_menu(text)', 'execute')
     OR has_function_privilege('anon', 'public.create_order_transaction(jsonb,text,text,text)', 'execute')
     OR has_function_privilege('authenticated', 'public.create_order_transaction(jsonb,text,text,text)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.create_order_transaction(jsonb,text,text,text)', 'execute')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname IN ('restaurant_assets_admin_delete', 'restaurant_assets_admin_insert',
                            'restaurant_assets_admin_update', 'restaurant_assets_public_read')) <> 4
     OR (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename IN ('order_events', 'orders')) <> 2
     OR NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass
         AND tgname = 'on_auth_user_created' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Los permisos, objetos o dependencias del destino difieren del respaldo.';
  END IF;
END
$verification$;
COMMIT;`
}

function secureRestoreDirectory(directory) {
  const output = mkdtempSync(path.join(path.dirname(directory), `restore-${path.basename(directory)}-`))
  if (process.platform === 'win32') {
    const identity = run('whoami.exe', []).trim()
    run('icacls.exe', [output, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'])
  } else {
    chmodSync(output, 0o700)
  }
  return output
}

function main() {
  const [input, ...flags] = process.argv.slice(2)
  check(input && !input.startsWith('--'), 'Indicá el directorio del respaldo completo de origen.')
  check(flags.length === 0 || (flags.length === 1 && flags[0] === '--renew-mfa-on-login'),
    'La única opción de restauración admitida es --renew-mfa-on-login.')
  const renewMfaOnLogin = flags.includes('--renew-mfa-on-login')
  const directory = realpathSync(input)
  const repository = realpathSync(process.cwd())
  check(directory !== repository && !directory.startsWith(repository + path.sep),
    'El respaldo y el SQL generado deben quedar fuera del repositorio.')
  const expected = readBackup(directory)
  const executable = pgBinary(process.env, 'pg_restore')
  const appArchive = path.join(directory, 'application.dump')
  const fullArchive = path.join(directory, 'database.dump')
  const list = (archive) => renderArchive(executable, archive, ['--list']).split(/\r?\n/).filter((line) => /^\d+;/.test(line))
  const appEntries = list(appArchive)
  const fullEntries = list(fullArchive)
  const publicSchema = /^\d+; \d+ \d+ SCHEMA - public pg_database_owner$/
  check(appEntries.filter((line) => publicSchema.test(line)).length === 1
    && appEntries.every((line) => / (public|private|supabase_migrations) /.test(line)
      && !/^\d+; \d+ \d+ (?:DATABASE|EXTENSION|EVENT TRIGGER|PUBLICATION|SUBSCRIPTION|FOREIGN SERVER|USER MAPPING|SECURITY LABEL|BLOB) /.test(line)),
  'El esquema de aplicación contiene entradas fuera del alcance revisado.')
  const managed = selectManagedRestoreEntries(fullEntries, { renewMfaOnLogin })

  const output = secureRestoreDirectory(directory)
  const restore = (archive, label, entries, mode) => {
    const listPath = path.join(output, `${label}.list`)
    writeFileSync(listPath, entries.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    try {
      return renderArchive(executable, archive, [mode, '--exit-on-error', '--use-list', listPath])
        .replace(/^SET lock_timeout = 0;(?=\r?$)/gm, "SET lock_timeout = '10s';")
    } finally {
      unlinkSync(listPath)
    }
  }
  const app = appEntries.filter((line) => !publicSchema.test(line))
  const appPre = restore(appArchive, 'app-pre', app, '--section=pre-data')
  const appData = restore(appArchive, 'app-data', app, '--section=data')
  const appPost = restore(appArchive, 'app-post', app, '--section=post-data')
  const authData = restore(fullArchive, 'managed-data', managed.data, '--data-only')
  const customDdl = restore(fullArchive, 'managed-ddl', managed.ddl, '--schema-only')
  if (managed.reviewAuth.length > 0) {
    const review = restore(fullArchive, 'auth-review', managed.reviewAuth, '--data-only')
    check([...copyCounts(review).values()].every((count) => count === 0),
      'Hay datos de Auth fuera del alcance revisado. Ajustá la restauración antes de continuar.')
  }

  const appCounts = copyCounts(appData)
  const authCounts = copyCounts(authData)
  const checkpointTables = [
    ['public.restaurants', expected.restaurants],
    ['public.products', expected.products],
    ['public.orders', expected.orders],
    ['supabase_migrations.schema_migrations', expected.migrations],
  ]
  const grants = appPre.match(publicGrants) ?? []
  const expectedManagedTables = [...restoreTables].filter((name) => !renewMfaOnLogin || name !== mfaFactorsTable)
  check(appCounts.size > 0 && [...appCounts.keys()].every((name) => /^(public|private|supabase_migrations)\.\w+$/.test(name))
    && checkpointTables.every(([name, count]) => appCounts.get(name) === count)
    && authCounts.size === expectedManagedTables.length && expectedManagedTables.every((name) => authCounts.has(name))
    && authCounts.get('auth.users') === expected.auth_users && new Set(grants).size === 4,
  'La restauración no coincide con los conteos, las tablas o los permisos revisados.')

  const sql = [
    preflight(), appPre.replace(publicGrants, ''), 'RESET ROLE;', ...grants,
    'SET LOCAL session_replication_role = replica;', authData, appData,
    'SET LOCAL session_replication_role = origin;', appPost, customDdl,
    restoreVerificationSql(appCounts, authCounts, { renewMfaOnLogin }), '',
  ].join('\n\n')
  const destination = path.join(output, 'restore-admin.sql')
  writeFileSync(destination, sql, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ file: destination, sha256: checksum(destination) }))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof RestorePreparationError ? error.message : 'No se pudo preparar el SQL. El diagnóstico se omitió para proteger los datos.')
    process.exitCode = 1
  }
}
