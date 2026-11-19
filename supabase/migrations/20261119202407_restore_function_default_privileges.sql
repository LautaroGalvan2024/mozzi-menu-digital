-- A schema-scoped dump can omit global defaults. Restore the application
-- migration owner's policy on existing self-hosted projects as well.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
