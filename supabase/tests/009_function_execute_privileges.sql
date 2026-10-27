begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(154);

with expected(signature, access) as (
  values
    ('public.get_public_menu(text)', 'public'),
    ('public.get_public_catalog(text,text)', 'public-service'),
    ('public.save_product_family(uuid,jsonb,jsonb)', 'authenticated'),
    ('public.get_payment_connection(uuid)', 'authenticated'),
    ('public.save_payment_account(uuid,text,text,timestamptz,boolean)', 'service'),
    ('public.refresh_payment_account(uuid,text,text,timestamptz,boolean,timestamptz)', 'service'),
    ('public.backfill_payment_account_environment(uuid,boolean)', 'service'),
    ('public.get_payment_account(uuid,text,uuid,boolean)', 'service'),
    ('public.disconnect_payment_account(uuid)', 'service'),
    ('public.acquire_payment_account_refresh(uuid,timestamptz)', 'service'),
    ('public.save_payment_oauth_state(text,text)', 'service'),
    ('public.consume_payment_oauth_state(text)', 'service'),
    ('public.begin_online_checkout(jsonb,text,text,text,text,boolean,uuid)', 'service'),
    ('public.set_online_checkout_preference(uuid,text,text,uuid)', 'service'),
    ('public.get_online_payment_attempt(uuid)', 'service'),
    ('public.get_online_checkout_status(uuid,text,boolean)', 'service'),
    ('public.reconcile_online_payment(uuid,text,text,bigint,text,timestamptz,jsonb)', 'service'),
    ('public.list_online_reconciliation(integer)', 'service'),
    ('public.mark_online_reconciled(uuid)', 'service'),
    ('public.expire_online_reservations(timestamptz,integer)', 'service'),
    ('public.get_actor_authorization()', 'authenticated'),
    ('public.get_order_by_action(uuid)', 'authenticated'),
    ('public.claim_order(uuid)', 'authenticated'),
    ('public.complete_order(uuid)', 'authenticated'),
    ('public.cancel_order(uuid,text)', 'authenticated'),
    ('public.import_products_batch(uuid,jsonb,text)', 'authenticated'),
    ('public.get_catalog_import_result(uuid,uuid)', 'authenticated'),
    ('public.get_inventory(uuid,uuid,integer)', 'authenticated'),
    ('public.confirm_inventory_business_policy(uuid,jsonb)', 'authenticated'),
    ('public.begin_inventory_count(uuid,uuid,text)', 'authenticated'),
    ('public.finish_inventory_count(uuid,jsonb,uuid[],boolean,text,boolean)', 'authenticated'),
    ('public.change_inventory_policy(uuid,text,text,bigint)', 'authenticated'),
    ('public.inventory_adjust(uuid,uuid,text,jsonb,text,text)', 'authenticated'),
    ('public.reverse_order_inventory(uuid,uuid,text,boolean,text,jsonb)', 'authenticated'),
    ('public.link_order_replacement(uuid,uuid,text)', 'authenticated'),
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
    ('public.recover_order_confirmation(uuid,text)', 'service'),
    ('public.check_order_recovery_rate_limit(text)', 'service'),
    ('public.register_whatsapp_opened(uuid,text)', 'service'),
    ('public.create_restaurant_transaction(jsonb,uuid,uuid,text,uuid)', 'service'),
    ('public.upsert_restaurant_membership(uuid,uuid,public.restaurant_role,public.membership_status,uuid)', 'service')
)
select is(
  has_function_privilege('anon', signature, 'execute'),
  access in ('public', 'public-service'),
  format('anon EXECUTE matches the ACL contract for %s', signature)
)
from expected
union all
select is(
  has_function_privilege('authenticated', signature, 'execute'),
  access in ('public', 'public-service', 'authenticated'),
  format('authenticated EXECUTE matches the ACL contract for %s', signature)
)
from expected
union all
select is(
  has_function_privilege('service_role', signature, 'execute'),
  access in ('service', 'public-service'),
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
  50::bigint,
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
