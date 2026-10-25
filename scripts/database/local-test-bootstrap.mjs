// Isolated PostgreSQL substrate for SQL tests. Does not start Auth, Storage, Edge or Realtime services.
// Credentials stay in the ignored local environment file; no remote/linked connection is used.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const databaseArgument = process.argv.find(value => value.startsWith('--database='))
if (databaseArgument) env.PGDATABASE = databaseArgument.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE)) throw new Error('Invalid isolated database name')
const bin = env.PG_BIN
const psql = path.join(bin, 'psql.exe')
const sql = (statement, database = env.PGDATABASE) => run(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', database], { env, input: statement })
const version = sql('show server_version;', 'postgres').trim()
if (!version.startsWith('17.')) throw new Error('This test substrate requires PostgreSQL 17')
const source = path.join(process.env.LOCALAPPDATA, 'mozzi-tools', 'postgres17', 'pgtap', 'pgTAP-1.3.4')
const share = run(path.join(bin, 'pg_config.exe'), ['--sharedir'], { env }).trim()
const extension = path.join(share, 'extension')
mkdirSync(extension, { recursive: true })
copyFileSync(path.join(source, 'pgtap.control'), path.join(extension, 'pgtap.control'))
// Official pgTAP 1.3.4 Makefile uses NUMVERSION=1.3 and these substitutions on PG17.
const pgTap = readFileSync(path.join(source, 'sql', 'pgtap.sql.in'), 'utf8')
  .replaceAll('MODULE_PATHNAME', 'pgtap').replaceAll('__OS__', 'Windows').replaceAll('__VERSION__', '1.3')
writeFileSync(path.join(extension, 'pgtap--1.3.4.sql'), pgTap)

sql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;`, 'postgres')

if (sql(`select count(*) from pg_database where datname='${env.PGDATABASE}';`, 'postgres').trim() === '0') {
  sql(`CREATE DATABASE "${env.PGDATABASE}";`, 'postgres')
}
sql('create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists pgtap with schema extensions;')

const managedArgument = process.argv.find(value => value.startsWith('--managed-schema='))
if (!managedArgument) {
  console.log(JSON.stringify({ database: env.PGDATABASE, version, pgTap: '1.3.4', prepared: true, substrate: 'pending managed schema' }))
  process.exit(0)
}
const managed = path.resolve(managedArgument.slice('--managed-schema='.length))
if (!existsSync(managed)) throw new Error('Managed schema file does not exist')
if (sql("select count(*) from information_schema.tables where table_schema in ('auth','storage');").trim() !== '0') {
  throw new Error('Auth/Storage substrate already exists; this bootstrap never resets a database')
}
let substrate = readFileSync(managed, 'utf8')
// pg_dump also includes app-owned hooks/policies on managed schemas. Their own migrations
// recreate them after private functions exist. All managed definitions remain unchanged.
const statementsRemoved = []
substrate = substrate.replace(/CREATE TRIGGER on_auth_user_created[\s\S]*?;\s*/g, () => {
  statementsRemoved.push('application auth profile trigger'); return ''
})
substrate = substrate.replace(/CREATE POLICY restaurant_assets_[\s\S]*?;\s*/g, () => {
  statementsRemoved.push('application Storage policy'); return ''
})
substrate = substrate.replace(/COMMENT ON POLICY restaurant_assets_\w+ ON storage\.objects IS '(?:''|[^'])*';\s*/g, '')
sql(`BEGIN;\n${substrate}\nCOMMIT;`)
// The dump excludes ACLs by design. Model only the normal SQL roles needed by policy tests;
// these grants do not claim certification of managed HTTP services or their ownership model.
sql(`GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, storage TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
GRANT SELECT ON storage.objects TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA auth,storage TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO service_role;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`)
console.log(JSON.stringify({ database: env.PGDATABASE, version, pgTap: '1.3.4', substrate: 'managed schema without data', appOwnedDefinitionsDeferred: statementsRemoved.length }))

const through = process.argv.find(value => value.startsWith('--through='))?.slice('--through='.length)
const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && (!through || file <= through)).sort()
for (const migration of migrations) {
  sql(`BEGIN;\n${readFileSync(path.join('supabase/migrations', migration), 'utf8')}\nCOMMIT;`)
  console.log(`Applied ${migration}`)
}
