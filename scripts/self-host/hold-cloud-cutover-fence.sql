\set ON_ERROR_STOP on
\set VERBOSITY terse
SET application_name = 'mozzi-final-cutover-fence';
BEGIN;
SET LOCAL idle_in_transaction_session_timeout = '20min';

DO $fence$
DECLARE
  target record;
  expected integer := 0;
  acquired integer;
BEGIN
  IF current_database() <> 'postgres'
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR pg_is_in_recovery()
     OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     OR to_regnamespace('pgbouncer') IS NULL
     OR to_regclass('public.restaurants') IS NULL
     OR to_regclass('private.payment_accounts') IS NULL
     OR to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Se requiere la base cloud de origen de Mozzi Menu como postgres administrado.';
  END IF;

  FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private', 'supabase_migrations', 'auth', 'storage', 'vault')
      AND c.relkind IN ('r', 'p')
      AND (n.nspname, c.relname) NOT IN (
        ('auth', 'schema_migrations'),
        ('storage', 'migrations'),
        ('storage', 'buckets_vectors'),
        ('storage', 'vector_indexes')
      )
    ORDER BY n.nspname, c.relname
  LOOP
    IF NOT has_table_privilege(current_user, target.oid, 'MAINTAIN,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'La cobertura de permisos del origen difiere de la revisada.';
    END IF;
    EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE NOWAIT', target.schema_name, target.table_name);
    expected := expected + 1;
  END LOOP;

  SELECT count(DISTINCT relation) INTO acquired FROM pg_locks
  WHERE pid = pg_backend_pid() AND locktype = 'relation' AND mode = 'ShareLock' AND granted;
  IF expected <> 78 OR acquired <> expected THEN
    RAISE EXCEPTION 'La cobertura de tablas difiere del origen revisado.';
  END IF;
END
$fence$;

SELECT count(DISTINCT relation) AS tablas_bloqueadas FROM pg_locks
WHERE pid = pg_backend_pid() AND locktype = 'relation' AND mode = 'ShareLock' AND granted;
