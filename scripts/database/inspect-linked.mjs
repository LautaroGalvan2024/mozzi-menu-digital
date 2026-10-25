// Explicit read-only inspection of the linked project. Outputs only aggregate
// counts, schema/privilege metadata and migration versions: never rows or secrets.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { linkedDatabaseEnvironment, readEnvironment, run } from './connection.mjs'

let stage = 'configuration'
try {
  const bin = process.env.PG_BIN ?? (existsSync('.env.database.local') ? readEnvironment('.env.database.local').PG_BIN : undefined)
  if (!bin) throw new Error('PostgreSQL binaries are not configured')
  stage = 'linked connection'
  const env = linkedDatabaseEnvironment()
  // Prevent inherited libpq settings from redirecting the explicitly linked host.
  delete env.PGSERVICE
  delete env.PGSERVICEFILE
  delete env.PGHOSTADDR
  env.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000'
  const query = sql => {
    const output = run(path.join(bin, process.platform === 'win32' ? 'psql.exe' : 'psql'),
      ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password'], {
        env,
        input: `begin isolation level repeatable read read only; set local role postgres; ${sql}; rollback;`,
      }).trim()
    return JSON.parse(output)
  }
  stage = 'schema and privilege metadata'
  const metadata = query(`select jsonb_build_object(
    'serverVersion',current_setting('server_version'),
    'transactionReadOnly',current_setting('transaction_read_only'),
    'migrationVersions',(select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations),
    'publicTables',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) order by c.relname),'[]') from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    'hasInventoryPolicy',exists(select 1 from information_schema.columns where table_schema='public' and table_name='restaurants' and column_name='inventory_mode'),
    'privateSchemaUsage',jsonb_build_object('anon',has_schema_privilege('anon','private','usage'),'authenticated',has_schema_privilege('authenticated','private','usage')),
    'publicFunctionPermissions',(select coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'securityDefiner',p.prosecdef,'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),'serviceExecute',has_function_privilege('service_role',p.oid,'execute')) order by p.oid::regprocedure::text),'[]') from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'databaseBytes',pg_database_size(current_database())::text
  )`)
  const allowedTables = [
    'profiles', 'platform_user_roles', 'restaurants', 'restaurant_members',
    'categories', 'products', 'product_option_groups', 'product_options',
    'business_hours', 'special_hours', 'payment_methods', 'delivery_zones',
    'restaurant_order_counters', 'image_assets', 'orders', 'order_items',
    'order_item_options', 'order_events', 'audit_logs', 'product_quantity_prices',
    'inventory_balances', 'inventory_operations', 'inventory_movements',
    'order_inventory_lines', 'inventory_counts',
  ]
  const present = new Set(metadata.publicTables.map(table => table.name))
  const countQueries = allowedTables.filter(name => present.has(name))
    .map(name => `select '${name}' as name,count(*)::text as count from public.${name}`)
  countQueries.push("select 'auth_users',count(*)::text from auth.users", "select 'storage_objects',count(*)::text from storage.objects")
  stage = 'aggregate table counts'
  const tableCounts = query(`select jsonb_object_agg(name,count) from (${countQueries.join(' union all ')}) totals`)
  stage = 'active option-group validation counts'
  const invalidActiveGroups = query(`with active as (
    select g.min_select,g.max_select,g.required,
      (select count(*) from public.product_options o where o.option_group_id=g.id and o.active) active_options
    from public.product_option_groups g where g.active
  ) select jsonb_build_object(
    'activeGroups',count(*),
    'invalidGroups',count(*) filter(where max_select not between 1 and 20 or min_select<0 or max_select<min_select or (required and min_select<1) or min_select>active_options),
    'maxOutsideSupportedRange',count(*) filter(where max_select not between 1 and 20),
    'minimumExceedsActiveOptions',count(*) filter(where min_select>active_options),
    'invalidRequiredMinimum',count(*) filter(where required and min_select<1),
    'invalidBounds',count(*) filter(where min_select<0 or max_select<min_select)
  ) from active`)
  stage = 'aggregate inventory policies'
  const inventoryModes = metadata.hasInventoryPolicy
    ? query(`select coalesce(jsonb_object_agg(mode,count),'{}') from (select inventory_mode::text mode,count(*)::text count from public.restaurants group by inventory_mode) modes`)
    : null
  const localVersions = readdirSync('supabase/migrations').filter(name => /^\d+_.+\.sql$/.test(name)).map(name => name.split('_')[0]).sort()
  const deployed = new Set(metadata.migrationVersions)
  console.log(JSON.stringify({
    inspectedAt: new Date().toISOString(), readOnly: true, ...metadata,
    tableCounts, invalidActiveGroups, inventoryModes,
    latestMigrationVersions: metadata.migrationVersions.slice(-10),
    localVersionsNotDeployed: localVersions.filter(version => !deployed.has(version)),
  }, null, 2))
} catch {
  // CLI/libpq diagnostics can contain connection details: never echo them here.
  console.error(JSON.stringify({ inspectionFailed: true, stage, detail: 'Read-only inspection failed; raw diagnostics withheld to protect credentials and personal data.' }))
  process.exitCode = 1
}
