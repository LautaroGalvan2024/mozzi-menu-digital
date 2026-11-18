-- Aggregate diagnostics for the four 20261117 migrations on a pre-upgrade DB.
-- A timeout or missing row is an incomplete check. Only counts are returned.
begin read only;
set local lock_timeout = '1s';
set local statement_timeout = '5s';

select count(*) as special_dates_requiring_review
from (
  select restaurant_id, date from public.special_hours
  group by restaurant_id, date having bool_or(is_closed) and count(*) > 1
) conflicting_dates;

select count(*) as ambiguous_auth_emails
from (
  select lower(coalesce(email, id::text || '@invalid.local'))
  from auth.users
  group by 1 having count(*) > 1
) duplicate_email;

select count(*) as conflicting_profile_owners
from auth.users u join public.profiles p
  on lower(p.email) = lower(coalesce(u.email, u.id::text || '@invalid.local'))
where p.id <> u.id;

select count(*) as profiles_to_backfill
from auth.users u where not exists(select 1 from public.profiles p where p.id = u.id);

select n.nspname as schema_name, c.relname as table_name,
       c.reltuples::bigint as estimated_rows, pg_total_relation_size(c.oid) as bytes
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname,c.relname) in (
  ('private','online_payment_attempts'),('private','online_payment_receipts'),
  ('private','online_payment_status_tokens'),('public','special_hours'),
  ('public','restaurants'),('public','products'),('public','product_families'),
  ('public','categories'),('public','restaurant_members')
) order by 1,2;
rollback;
