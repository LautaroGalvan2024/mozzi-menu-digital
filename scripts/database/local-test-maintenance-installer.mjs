// Disposable loopback-only PostgreSQL test. Mock extensions never send HTTP.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'
import { buildInstallationSql, validateConfiguration } from './configure-commerce-maintenance.mjs'

const env = localDatabaseEnvironment()
const database = `mozzi_scheduler_${randomBytes(6).toString('hex')}`
const reader = `${database}_reader`
const psql = path.join(env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
const query = (input, target = database) => run(psql, ['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',target], { env, input }).trim()
const projectRef = 'abcdefghijklmnopqrst'
const firstSecret = 'synthetic_only_0123456789_0123456789'
const secondSecret = 'synthetic_only_9876543210_9876543210'
const config = validateConfiguration({ projectRef, linkedProjectRef: projectRef, projectUrl: `https://${projectRef}.supabase.co`, maintenanceSecret: firstSecret })
const install = secret => query(buildInstallationSql(config,secret).replace("current_database() <> 'postgres'", `current_database() <> '${database}'`))
let created = false
let readerCreated = false
try {
  query(`create database "${database}";`, env.PGDATABASE)
  created = true
  query(`create schema private; create schema net; create schema vault; create schema cron;
    -- Only this disposable database receives mock extension metadata. The native
    -- Windows substrate cannot load these managed Supabase C extensions.
    insert into pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion) values
      (990001,'pg_cron','postgres'::regrole,'cron'::regnamespace,false,'test'),
      (990002,'pg_net','postgres'::regrole,'net'::regnamespace,false,'test'),
      (990003,'supabase_vault','postgres'::regrole,'vault'::regnamespace,false,'test');
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,description text,secret text);
    create view vault.decrypted_secrets as select *,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(new_secret text,new_name text,new_description text,unused uuid default null)
      returns uuid language sql as $$insert into vault.secrets(name,description,secret) values(new_name,new_description,new_secret) returning id$$;
    create function vault.update_secret(secret_id uuid,new_secret text,new_name text,new_description text)
      returns void language sql as $$update vault.secrets set secret=new_secret,name=new_name,description=new_description where id=secret_id$$;
    create table net.http_request_queue(id bigserial primary key,url text,body jsonb,headers jsonb,timeout_milliseconds integer);
    create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000)
      returns bigint language sql as $$insert into net.http_request_queue(url,body,headers,timeout_milliseconds) values(url,body,headers,timeout_milliseconds) returning id$$;
    create table cron.job(jobid bigserial primary key,jobname text,username text default current_user,database text default current_database(),command text,schedule text,active boolean default true,unique(jobname,username));
    create function cron.schedule(name text,schedule text,command text) returns bigint language sql as
      $$insert into cron.job(jobname,schedule,command) values(name,schedule,command) returning jobid$$;
    create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null)
      returns void language sql as $$update cron.job j set schedule=coalesce(alter_job.schedule,j.schedule),command=coalesce(alter_job.command,j.command),active=coalesce(alter_job.active,j.active) where j.jobid=job_id$$;
    grant usage on schema net,vault to public;
    grant all on net.http_request_queue,vault.secrets,vault.decrypted_secrets to public;
    grant select(headers) on net.http_request_queue to authenticated;
    grant execute on function vault.create_secret(text,text,text,uuid),vault.update_secret(uuid,text,text,text) to service_role;`)
  const firstResult = install(firstSecret)
  assert.match(firstResult, /RESULT:/)
  assert.equal(query("select count(*) from cron.job where command='select private.invoke_commerce_maintenance();' and schedule='*/5 * * * *' and active;"), '1')
  assert.equal(query('select count(*) from net.http_request_queue;'), '0', 'installation must not enqueue a payment maintenance request')
  assert.equal(query("select has_function_privilege('anon','private.invoke_commerce_maintenance()','execute') or has_function_privilege('authenticated','private.invoke_commerce_maintenance()','execute') or has_function_privilege('service_role','private.invoke_commerce_maintenance()','execute');"), 'f')
  assert.equal(query("select has_any_column_privilege('anon','net.http_request_queue','SELECT') or has_any_column_privilege('authenticated','net.http_request_queue','SELECT');"), 'f')
  query('select private.invoke_commerce_maintenance();')
  assert.equal(query(`select count(*) from net.http_request_queue where headers->>'x-maintenance-secret'='${firstSecret}' and body='{"limit":10}'::jsonb and timeout_milliseconds=60000 and url='${config.origin}/functions/v1/reconcile-payments';`), '1')
  const jobId = query('select jobid from cron.job;')
  install(secondSecret)
  assert.equal(query('select jobid from cron.job;'), jobId, 'rerun must preserve the existing job')
  assert.equal(query(`select count(*) from vault.secrets where secret='${secondSecret}';`), '1')
  query("insert into cron.job(jobname,command,schedule) values('other-maintenance','select call_reconcile(''reconcile-payments'');','*/5 * * * *');")
  assert.throws(() => install(firstSecret), /MOZZI_MAINTENANCE_DUPLICATE_SCHEDULER/)
  assert.equal(query(`select count(*) from vault.secrets where secret='${secondSecret}';`), '1', 'collision must leave the current credential unchanged')
  query("delete from cron.job where jobname='other-maintenance';")
  query(`create role "${reader}" nologin; grant "${reader}" to anon;`)
  readerCreated = true
  query(`grant select on net.http_request_queue to "${reader}";`)
  assert.throws(() => install(firstSecret), /MOZZI_MAINTENANCE_UNSAFE_PRIVILEGES/)
  assert.equal(query(`select count(*) from vault.secrets where secret='${secondSecret}';`), '1', 'inherited access must fail before replacing the Vault secret')
  console.log(JSON.stringify({ passed: true, checks: ['initial install','no immediate request','private helper ACL','queue column grants','fixed POST','idempotent rotation','duplicate job rollback','inherited access rollback'], remoteAccess: false }))
} finally {
  if (created) query(`drop database "${database}";`, env.PGDATABASE)
  if (readerCreated) query(`drop role "${reader}";`, env.PGDATABASE)
}
