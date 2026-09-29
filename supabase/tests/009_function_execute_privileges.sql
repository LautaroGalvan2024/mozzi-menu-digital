begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(64);

with expected(signature, access) as (
  values
    ('public.get_public_menu(text)', 'public'),
    ('public.get_actor_authorization()', 'authenticated'),
    ('public.get_order_by_action(uuid)', 'authenticated'),
    ('public.claim_order(uuid)', 'authenticated'),
    ('public.complete_order(uuid)', 'authenticated'),
    ('public.cancel_order(uuid,text)', 'authenticated'),
    ('public.import_products_batch(uuid,jsonb,text)', 'authenticated'),
    ('public.get_order_metrics(uuid,timestamptz,timestamptz)', 'authenticated'),
    ('public.set_restaurant_member_status(uuid,public.membership_status)', 'authenticated'),
    ('public.save_restaurant_hours(uuid,jsonb,jsonb,uuid[],uuid[])', 'authenticated'),
    ('public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[])', 'authenticated'),
    ('public.list_orphan_image_assets(uuid)', 'authenticated'),
    ('public.expire_orders(timestamptz,integer)', 'service'),
    ('public.check_rate_limit(text,uuid,integer,integer)', 'owner'),
    ('public.cleanup_rate_limits(timestamptz)', 'service'),
    ('public.check_order_rate_limits(text,text,text)', 'service'),
    ('public.create_order_transaction(jsonb,text,text,text)', 'service'),
    ('public.register_whatsapp_opened(uuid,text)', 'service'),
    ('public.create_restaurant_transaction(jsonb,uuid,uuid,text,uuid)', 'service'),
    ('public.upsert_restaurant_membership(uuid,uuid,public.restaurant_role,public.membership_status,uuid)', 'service')
)
select is(
  has_function_privilege('anon', signature, 'execute'),
  access = 'public',
  format('anon EXECUTE matches the ACL contract for %s', signature)
)
from expected
union all
select is(
  has_function_privilege('authenticated', signature, 'execute'),
  access in ('public', 'authenticated'),
  format('authenticated EXECUTE matches the ACL contract for %s', signature)
)
from expected
union all
select is(
  has_function_privilege('service_role', signature, 'execute'),
  access = 'service',
  format('service_role EXECUTE matches the ACL contract for %s', signature)
)
from expected;

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),
  20::bigint,
  'the public function inventory contains only the reviewed allowlist'
);

create function public.pgtap_acl_probe_009()
returns integer
language sql
as $$ select 1 $$;

select is(
  has_function_privilege('anon', 'public.pgtap_acl_probe_009()', 'execute'),
  false,
  'future functions deny anon EXECUTE by default'
);
select is(
  has_function_privilege('authenticated', 'public.pgtap_acl_probe_009()', 'execute'),
  false,
  'future functions deny authenticated EXECUTE by default'
);
select is(
  has_function_privilege('service_role', 'public.pgtap_acl_probe_009()', 'execute'),
  false,
  'future functions deny service_role EXECUTE by default'
);

select * from finish();
rollback;
