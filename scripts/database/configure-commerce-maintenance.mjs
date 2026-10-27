// Explicit, project-bound installation. Never run this from a frontend build.
// The default validates local configuration only; --apply connects to the linked DB.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { linkedDatabaseEnvironment, readEnvironment } from './connection.mjs'

export const JOB_NAME = 'mozzi-commerce-reconcile'
export const HELPER = 'private.invoke_commerce_maintenance'
const MARKER = 'mozzi-commerce-maintenance:v1'
const COMMAND = `select ${HELPER}();`
const SCHEDULE = '*/5 * * * *'
const ERROR_CODES = new Set([
  'INVALID_ARGUMENTS', 'PROJECT_MISMATCH', 'INVALID_SECRET', 'DUPLICATE_SCHEDULER',
  'DATABASE_MISMATCH', 'MISSING_EXTENSIONS', 'UNSUPPORTED_SIGNATURE',
  'OBJECT_COLLISION', 'UNSAFE_PRIVILEGES', 'INSTALL_FAILED', 'CONFIGURATION_FAILED',
])

class MaintenanceError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new MaintenanceError(code) }

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  if (args.some(arg => !arg.startsWith('--project-ref=') && !['--apply', '--github-workflow-disabled'].includes(arg))) fail('INVALID_ARGUMENTS')
  if (new Set(args).size !== args.length || args.filter(arg => arg.startsWith('--project-ref=')).length !== 1) fail('INVALID_ARGUMENTS')
  const projectRef = args.find(arg => arg.startsWith('--project-ref=')).slice('--project-ref='.length)
  if (!/^[a-z]{20}$/.test(projectRef)) fail('INVALID_ARGUMENTS')
  const apply = args.includes('--apply')
  if (apply && !args.includes('--github-workflow-disabled')) fail('DUPLICATE_SCHEDULER')
  return { projectRef, apply }
}

export function validateConfiguration({ projectRef, linkedProjectRef, projectUrl, maintenanceSecret, githubEnabled }) {
  if (!/^[a-z]{20}$/.test(projectRef) || linkedProjectRef !== projectRef) fail('PROJECT_MISMATCH')
  let url
  try { url = new URL(projectUrl) } catch { fail('PROJECT_MISMATCH') }
  const origin = `https://${projectRef}.supabase.co`
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('PROJECT_MISMATCH')
  // COPY text input below accepts one base64/base64url/hex line, never SQL or psql commands.
  if (typeof maintenanceSecret !== 'string' || !/^[A-Za-z0-9+/_=-]{32,512}$/.test(maintenanceSecret)) fail('INVALID_SECRET')
  if (githubEnabled?.toLowerCase() === 'true') fail('DUPLICATE_SCHEDULER')
  return { projectRef, origin, secretName: `mozzi-commerce-maintenance-${projectRef}` }
}

export function validateLinkedConnection(env, projectRef) {
  const direct = env.PGHOST === `db.${projectRef}.supabase.co` && env.PGUSER === 'postgres'
  const pooled = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(env.PGHOST ?? '')
    && [`postgres.${projectRef}`, `cli_login_postgres.${projectRef}`].includes(env.PGUSER)
  if ((!direct && !pooled) || env.PGDATABASE !== 'postgres' || !['5432', '6543'].includes(String(env.PGPORT))) fail('DATABASE_MISMATCH')
}

// All interpolated configuration has a strict allowlist above. The secret itself
// is sent ONLY as COPY data, never as a SQL literal, CLI argument or saved file.
export function buildInstallationSql(config, maintenanceSecret) {
  validateConfiguration({ ...config, linkedProjectRef: config.projectRef, projectUrl: config.origin, maintenanceSecret })
  const { projectRef, origin } = config
  const secretName = `mozzi-commerce-maintenance-${projectRef}`
  const description = `${MARKER}:${projectRef}`
  return String.raw`\set ECHO none
\set VERBOSITY terse
set role postgres;
begin;
set local search_path = '';
set local client_min_messages = warning;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
do $guard$
begin
  if current_database() <> 'postgres' or current_user <> 'postgres' then
    raise exception 'MOZZI_MAINTENANCE_DATABASE_MISMATCH';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('${JOB_NAME}', 0));
  if (select count(*) from pg_catalog.pg_extension where extname in ('pg_cron','pg_net','supabase_vault')) <> 3
    or pg_catalog.to_regclass('net.http_request_queue') is null
    or pg_catalog.to_regclass('vault.secrets') is null
    or pg_catalog.to_regclass('vault.decrypted_secrets') is null
    or pg_catalog.to_regclass('cron.job') is null
    or pg_catalog.to_regnamespace('private') is null then
    raise exception 'MOZZI_MAINTENANCE_MISSING_EXTENSIONS';
  end if;
  if (select count(*) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')) <> 3
    or pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null
    or pg_catalog.to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    raise exception 'MOZZI_MAINTENANCE_UNSUPPORTED_SIGNATURE';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc where oid = 'net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure
    and proargnames = array['url','body','params','headers','timeout_milliseconds']::text[]) then
    raise exception 'MOZZI_MAINTENANCE_UNSUPPORTED_SIGNATURE';
  end if;
  if pg_catalog.has_schema_privilege('anon','private','create') or pg_catalog.has_schema_privilege('authenticated','private','create') then
    raise exception 'MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p where p.pronamespace = 'private'::regnamespace
    and p.proname = 'invoke_commerce_maintenance' and (p.pronargs <> 0 or p.proowner <> 'postgres'::regrole
      or pg_catalog.obj_description(p.oid,'pg_proc') is distinct from '${description}')) then
    raise exception 'MOZZI_MAINTENANCE_OBJECT_COLLISION';
  end if;
  if exists(select 1 from vault.secrets where name = '${secretName}' and description is distinct from '${description}') then
    raise exception 'MOZZI_MAINTENANCE_OBJECT_COLLISION';
  end if;
  if exists(select 1 from cron.job where jobname = '${JOB_NAME}' and
      (username <> current_user or database <> current_database() or command <> '${COMMAND}'))
    or (select count(*) from cron.job where jobname = '${JOB_NAME}') > 1 then
    raise exception 'MOZZI_MAINTENANCE_OBJECT_COLLISION';
  end if;
  if exists(select 1 from cron.job where jobname is distinct from '${JOB_NAME}' and active and
      (command ilike '%reconcile-payments%' or command ilike '%invoke_commerce_maintenance%')) then
    raise exception 'MOZZI_MAINTENANCE_DUPLICATE_SCHEDULER';
  end if;
end;
$guard$;

-- Restrict only the two Vault relations and pg_net's pending queue. Do not
-- revoke entire schemas, change extension ownership, or touch unrelated jobs.
revoke all on table net.http_request_queue, vault.secrets, vault.decrypted_secrets from public, anon, authenticated;
do $permissions$
declare
  relation record;
  member record;
  columns text;
  operation record;
begin
  -- Table REVOKE does not remove existing column grants.
  for relation in select c.oid,c.relnamespace,n.nspname,c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where c.oid in ('net.http_request_queue'::regclass,'vault.secrets'::regclass,'vault.decrypted_secrets'::regclass)
  loop
    select string_agg(pg_catalog.quote_ident(a.attname),',') into columns from pg_catalog.pg_attribute a
      where a.attrelid=relation.oid and a.attnum>0 and not a.attisdropped;
    execute pg_catalog.format('revoke all (%s) on table %I.%I from public, anon, authenticated', columns, relation.nspname, relation.relname);
    for member in select oid,rolname from pg_catalog.pg_roles where rolname in ('anon','authenticated')
    loop
      if pg_catalog.has_schema_privilege(member.oid,relation.relnamespace,'usage') and
        (pg_catalog.has_table_privilege(member.oid,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(member.oid,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')) then
        raise exception 'MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES';
      end if;
    end loop;
  end loop;
  -- Vault writers can replace the secret even without SELECT; close only those
  -- public-client grants. service_role's existing Vault rights are preserved.
  for operation in select p.oid,p.oid::regprocedure::text signature from pg_catalog.pg_proc p
    where p.pronamespace='vault'::regnamespace and p.proname in ('create_secret','update_secret')
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', operation.signature);
    if (pg_catalog.has_schema_privilege('anon','vault','usage') and pg_catalog.has_function_privilege('anon',operation.oid,'execute'))
      or (pg_catalog.has_schema_privilege('authenticated','vault','usage') and pg_catalog.has_function_privilege('authenticated',operation.oid,'execute')) then
      raise exception 'MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES';
    end if;
  end loop;
  -- Detect unexpected direct-login readers, without changing their grants or
  -- managed Supabase service roles. Such installations need an operator review.
  if exists(select 1 from pg_catalog.pg_roles r where r.rolcanlogin and r.rolname not in
      ('postgres','supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin',
       'supabase_replication_admin','supabase_read_only_user','authenticator','dashboard_user','pgbouncer')
    and not (r.rolname='cli_login_postgres' and pg_catalog.pg_has_role(r.oid,'postgres','USAGE'))
    and ((pg_catalog.has_schema_privilege(r.oid,'net','usage') and pg_catalog.has_any_column_privilege(r.oid,'net.http_request_queue','SELECT'))
      or (pg_catalog.has_schema_privilege(r.oid,'vault','usage') and pg_catalog.has_any_column_privilege(r.oid,'vault.decrypted_secrets','SELECT')))) then
    raise exception 'MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES';
  end if;
end;
$permissions$;

create temporary table commerce_maintenance_input(secret text not null) on commit drop;
copy pg_temp.commerce_maintenance_input(secret) from stdin;
${maintenanceSecret}
\.
do $secret$
declare
  secret_id uuid;
  secret_value text;
begin
  select secret into strict secret_value from pg_temp.commerce_maintenance_input;
  select id into secret_id from vault.secrets where name='${secretName}';
  if secret_id is null then
    perform vault.create_secret(secret_value, '${secretName}', '${description}');
  else
    perform vault.update_secret(secret_id, secret_value, '${secretName}', '${description}');
  end if;
end;
$secret$;
drop table pg_temp.commerce_maintenance_input;

create or replace function ${HELPER}() returns bigint
language plpgsql security definer set search_path = ''
as $maintenance$
declare
  secret_value text;
  request_id bigint;
begin
  select decrypted_secret into strict secret_value from vault.decrypted_secrets where name='${secretName}';
  if secret_value is null or length(secret_value)<32 then
    raise exception 'Maintenance credential unavailable';
  end if;
  select net.http_post(
    url := '${origin}/functions/v1/reconcile-payments',
    body := '{"limit":10}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-maintenance-secret',secret_value),
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
exception when others then
  -- Do not forward provider/extension messages, which could include headers.
  raise exception 'Commerce maintenance could not be enqueued; inspect restricted diagnostics';
end;
$maintenance$;
comment on function ${HELPER}() is '${description}';
revoke all on function ${HELPER}() from public, anon, authenticated, service_role;

do $schedule$
declare job_id bigint;
begin
  if exists(select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
    and pg_catalog.has_function_privilege(r.oid,'${HELPER}()','execute')) then
    raise exception 'MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES';
  end if;
  select jobid into job_id from cron.job where jobname='${JOB_NAME}' and username=current_user;
  if job_id is null then
    perform cron.schedule('${JOB_NAME}','${SCHEDULE}','${COMMAND}');
  else
    perform cron.alter_job(job_id, schedule := '${SCHEDULE}', command := '${COMMAND}', active := true);
  end if;
end;
$schedule$;
commit;
select 'RESULT:' || jsonb_build_object('jobId',jobid,'active',active,'correctCommand',command='${COMMAND}',
  'correctSchedule',schedule='${SCHEDULE}')::text from cron.job where jobname='${JOB_NAME}' and username=current_user;
reset role;
`
}

function runInstaller() {
  let stage = 'local configuration'
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      console.log('Usage: node scripts/database/configure-commerce-maintenance.mjs --project-ref=<ref> [--apply --github-workflow-disabled]\nWithout --apply: local validation only. Requires .env.local, .env.edge.production and the matching Supabase link. Apply also requires PG_BIN and pre-enabled pg_cron, pg_net and supabase_vault. The workflow flag confirms PAYMENT_MAINTENANCE_ENABLED is disabled in GitHub and no other external scheduler runs this endpoint.')
      return
    }
    const local = readEnvironment('.env.local')
    const edge = readEnvironment('.env.edge.production')
    const config = validateConfiguration({
      projectRef: options.projectRef,
      linkedProjectRef: readFileSync('supabase/.temp/project-ref','utf8').trim(),
      projectUrl: local.VITE_SUPABASE_URL,
      maintenanceSecret: edge.MAINTENANCE_SECRET,
      githubEnabled: process.env.PAYMENT_MAINTENANCE_ENABLED,
    })
    if (!options.apply) {
      console.log(JSON.stringify({ localConfigurationValid: true, projectRef: config.projectRef, connected: false, applied: false, jobName: JOB_NAME, schedule: SCHEDULE }))
      return
    }
    const bin = process.env.PG_BIN ?? (existsSync('.env.database.local') ? readEnvironment('.env.database.local').PG_BIN : undefined)
    if (!bin) fail('CONFIGURATION_FAILED')
    stage = 'linked connection validation'
    const env = linkedDatabaseEnvironment()
    validateLinkedConnection(env,config.projectRef)
    for (const key of ['PGSERVICE','PGSERVICEFILE','PGHOSTADDR']) delete env[key]
    env.PGOPTIONS = '-c statement_timeout=30000 -c lock_timeout=5000'
    env.PGAPPNAME = 'mozzi-commerce-maintenance-installer'
    stage = 'transactional installation'
    const result = spawnSync(path.join(bin,process.platform === 'win32' ? 'psql.exe' : 'psql'),
      ['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','--no-password'], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 90000,
        env, input: buildInstallationSql(config,edge.MAINTENANCE_SECRET),
      })
    if (result.error || result.status !== 0) {
      const code = result.stderr?.match(/MOZZI_MAINTENANCE_([A-Z_]+)/)?.[1]
      fail(ERROR_CODES.has(code) ? code : 'INSTALL_FAILED')
    }
    const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT:'))
    if (lines.length !== 1) fail('INSTALL_FAILED')
    const summary = JSON.parse(lines[0].slice('RESULT:'.length))
    if (!Number.isSafeInteger(summary.jobId) || !summary.active || !summary.correctCommand || !summary.correctSchedule) fail('INSTALL_FAILED')
    console.log(JSON.stringify({ applied: true, projectRef: config.projectRef, jobName: JOB_NAME, jobId: summary.jobId, schedule: SCHEDULE, requestEnqueuedByInstaller: false }))
  } catch (error) {
    const code = error instanceof MaintenanceError && ERROR_CODES.has(error.code) ? error.code : 'CONFIGURATION_FAILED'
    console.error(JSON.stringify({ installationConfirmed: false, stage, code, detail: 'Raw diagnostics withheld. Review docs/commerce.md; no secrets or SQL are printed. If connection failed after commit, rerun to verify the same named job.' }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runInstaller()
