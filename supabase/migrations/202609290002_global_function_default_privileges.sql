-- Schema-specific default ACLs are additive in PostgreSQL. Reset the global
-- function default for the migration owner so future functions do not inherit
-- EXECUTE through PUBLIC before an explicit allowlist grant is applied.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;

-- This helper is only called by the owner-executed check_order_rate_limits RPC.
-- It has no direct API caller and therefore needs no API-role grant.
revoke execute on function public.check_rate_limit(text, uuid, integer, integer)
  from public, anon, authenticated, service_role;

comment on schema public is
  'API schema. Function EXECUTE is deny-by-default globally and granted explicitly per RPC.';
