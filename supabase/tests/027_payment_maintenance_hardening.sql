begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
values('37000000-0000-4000-8000-000000000001','maintenance-admin@example.test',now(),'{}');
select set_config('request.jwt.claim.sub','37000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"37000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
create temporary table maintenance_fixtures(label text primary key,tenant uuid,product uuid,order_id uuid,attempt_id uuid,action_id uuid);
create function pg_temp.maintenance_fixture(p_label text) returns void
language plpgsql set search_path='' as $$
declare tenant uuid:=extensions.gen_random_uuid(); category uuid:=extensions.gen_random_uuid(); product uuid:=extensions.gen_random_uuid(); result jsonb;
begin
  insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,inventory_mode,inventory_activated_at,inventory_business_policy)
  values(tenant,'Maintenance fixture','Fixture','maint-'||tenant,'active','+5491111111111','MNT',true,'enforced',now(),'{}');
  insert into public.restaurant_members(restaurant_id,user_id,role,status)
  values(tenant,'37000000-0000-4000-8000-000000000001','restaurant_admin','active');
  insert into public.categories(id,restaurant_id,name,slug) values(category,tenant,'Category','category');
  insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents) values(product,tenant,category,'ONE','One product',1000);
  insert into public.inventory_balances(restaurant_id,product_id,on_hand) values(tenant,product,10);
  perform public.save_payment_account(tenant,tenant::text,'synthetic-ciphertext',now()+interval '1 day',false);
  update public.restaurants set store_checkout_online_enabled=true where id=tenant;
  result:=public.begin_online_checkout(jsonb_build_object('restaurantSlug','maint-'||tenant,'idempotencyKey',extensions.gen_random_uuid(),
    'customer',jsonb_build_object('name','Synthetic buyer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','00000000-0000-4000-8000-000000000000',
    'items',jsonb_build_array(jsonb_build_object('productId',product,'quantity',1,'optionIds','[]'::jsonb))),
    repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
    (public.get_payment_account(tenant)->>'accountId')::uuid);
  insert into pg_temp.maintenance_fixtures values(p_label,tenant,product,(result->>'orderId')::uuid,(result->>'attemptId')::uuid,(result->>'actionId')::uuid);
end $$;

select pg_temp.maintenance_fixture('blocked');
select pg_temp.maintenance_fixture('healthy-one');
select pg_temp.maintenance_fixture('healthy-two');
update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id in (select attempt_id from maintenance_fixtures);
update private.online_payment_attempts set expires_at=now()-interval '2 minutes' where id=(select attempt_id from maintenance_fixtures where label='blocked');
select public.change_inventory_policy((select tenant from maintenance_fixtures where label='blocked'),'paused','Physical recount',
  (select inventory_version from public.restaurants where id=(select tenant from maintenance_fixtures where label='blocked')));
select public.begin_inventory_count((select tenant from maintenance_fixtures where label='blocked'),'37000000-0000-4000-8000-000000000009','Physical recount');
create temporary table maintenance_results(label text primary key,result jsonb);
insert into maintenance_results values('first',public.expire_online_reservations_report(now(),1));
select is((select result->>'expired' from maintenance_results where label='first'),'1','an older recount does not consume the healthy work limit');
select is((select result->>'blocked' from maintenance_results where label='first'),'1','report exposes the blocked recount');
select is((select result->>'failed' from maintenance_results where label='first'),'0','a recount is a retryable exclusion, not corrupt financial data');
select is((select count(*) from public.orders where id in (select order_id from maintenance_fixtures where label like 'healthy-%') and status='expired'),1::bigint,'one other merchant expires despite blocked head');
select is(public.expire_online_reservations(now(),1),1,'legacy integer RPC processes the other healthy merchant');
select is((select sum(reserved) from public.inventory_balances where product_id in (select product from maintenance_fixtures where label like 'healthy-%')),0::numeric,'healthy merchants both release their holds');
select is((select reserved from public.inventory_balances where product_id=(select product from maintenance_fixtures where label='blocked')),1::bigint,'recount stock stays unchanged');
select is((select status::text from public.orders where id=(select order_id from maintenance_fixtures where label='blocked')),'generated','blocked order stays pending until recount finishes');
select is(public.expire_online_reservations(now(),1),0,'repeated batches never release a healthy hold twice');
select public.finish_inventory_count('37000000-0000-4000-8000-000000000009',jsonb_build_array(jsonb_build_object(
  'productId',(select product from maintenance_fixtures where label='blocked'),'quantity',10,'countedAt',clock_timestamp())),
  '{}',true,'Synthetic immobility attestation',false);
select is(public.expire_online_reservations(now(),1),1,'finishing a recount makes its retained hold eligible again');
select is((select reserved from public.inventory_balances where product_id=(select product from maintenance_fixtures where label='blocked')),0::bigint,'retained hold releases exactly once after recount');
select is((select count(*) from public.order_events where order_id in (select order_id from maintenance_fixtures) and event_type='online_reservation_expired'),3::bigint,'one expiration event per order');

-- A later approval still follows the existing stock reacquisition contract.
select is(public.reconcile_online_payment((select attempt_id from maintenance_fixtures where label='healthy-one'),'maintenance-late-approval','approved',1000,'ARS',now())->>'paymentStatus','approved','late approval can reacquire released stock');
select is((select reserved from public.inventory_balances where product_id=(select product from maintenance_fixtures where label='healthy-one')),1::bigint,'late approval reacquires exactly one unit');
select is(public.expire_online_reservations(now(),10),0,'paid stock is excluded from expiration');

select pg_temp.maintenance_fixture('recent');
select public.mark_online_reconciled((select attempt_id from maintenance_fixtures where label='recent'));
select is((select next_reconcile_at from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='recent')),now()+interval '5 minutes','legacy completion schedules recent pending work in five minutes');
select public.mark_online_reconciled((select attempt_id from maintenance_fixtures where label='healthy-two'));
select is((select next_reconcile_at from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='healthy-two')),now()+interval '15 minutes','recent expiration is monitored with a bounded cadence');
select ok(not exists(select 1 from jsonb_array_elements(public.list_online_reconciliation(500)) x
  where x->>'attemptId'=(select attempt_id::text from maintenance_fixtures where label='healthy-two')),'a just-checked expired order no longer consumes every batch');
select public.finish_online_reconciliation((select attempt_id from maintenance_fixtures where label='recent'),false);
select is((select next_reconcile_at from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='recent')),now()+interval '1 minute','first provider failure schedules a short retry');
select public.finish_online_reconciliation((select attempt_id from maintenance_fixtures where label='recent'),false);
select is((select next_reconcile_at from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='recent')),now()+interval '2 minutes','repeated provider failure backs off');
select public.finish_online_reconciliation((select attempt_id from maintenance_fixtures where label='recent'),true);
select is((select reconciliation_failures from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='recent')),0,'success resets failure backoff');
select is((select payment_status from public.orders where id=(select order_id from maintenance_fixtures where label='recent')),'pending','scheduling never establishes a financial state');

select public.claim_order((select action_id from maintenance_fixtures where label='healthy-one'));
select public.complete_order((select order_id from maintenance_fixtures where label='healthy-one'));
update private.online_payment_attempts set created_at=now()-interval '30 days' where id=(select attempt_id from maintenance_fixtures where label='healthy-one');
select public.mark_online_reconciled((select attempt_id from maintenance_fixtures where label='healthy-one'));
select is((select next_reconcile_at from private.online_payment_attempts where id=(select attempt_id from maintenance_fixtures where label='healthy-one')),now()+interval '1 day','historical paid order remains monitored daily');
update private.online_payment_attempts set next_reconcile_at=now()-interval '1 second' where id=(select attempt_id from maintenance_fixtures where label='healthy-one');
select ok(exists(select 1 from jsonb_array_elements(public.list_online_reconciliation(500)) x
  where x->>'attemptId'=(select attempt_id::text from maintenance_fixtures where label='healthy-one')),'historical paid orders reenter the queue when due');
select public.reconcile_online_payment((select attempt_id from maintenance_fixtures where label='healthy-one'),'maintenance-late-approval','refunded',1000,'ARS',now()+interval '1 minute');
update private.online_payment_attempts set next_reconcile_at=now()-interval '1 second' where id=(select attempt_id from maintenance_fixtures where label='healthy-one');
select ok(exists(select 1 from jsonb_array_elements(public.list_online_reconciliation(500)) x
  where x->>'attemptId'=(select attempt_id::text from maintenance_fixtures where label='healthy-one')),'refund history remains available for later provider changes');

select ok(not has_function_privilege('anon','public.expire_online_reservations_report(timestamptz,integer)','execute'),'anonymous cannot perform maintenance');
select ok(not has_function_privilege('authenticated','public.finish_online_reconciliation(uuid,boolean)','execute'),'tenant clients cannot manipulate scheduling');
select ok(has_function_privilege('service_role','public.expire_online_reservations_report(timestamptz,integer)','execute'),'service retains maintenance capability');
select ok(has_function_privilege('service_role','public.expire_online_reservations(timestamptz,integer)','execute'),'legacy expiration capability remains');
select ok(not has_function_privilege('service_role','private.schedule_online_reconciliation()','execute'),'private scheduling trigger is not an RPC bypass');
select ok(exists(select 1 from pg_indexes where schemaname='private' and indexname='online_payment_receipts_attempt_idx'),'receipt aggregate has an attempt index');
select ok(exists(select 1 from pg_indexes where schemaname='private' and indexname='online_payment_attempts_reconciliation_due_idx'),'due work has a queue index');
select ok(exists(select 1 from pg_indexes where schemaname='private' and indexname='online_payment_attempts_expiration_due_idx'),'expiration has an eligible-attempt index');
select ok(exists(select 1 from pg_indexes where schemaname='private' and indexname='online_payment_status_tokens_expiry_idx'),'token cleanup has an expiry index');
select throws_ok($$select public.expire_online_reservations_report(now(),0)$$,'P0001','LIMIT_INVALID','report retains a bounded work limit');
select throws_ok($$select public.list_online_reconciliation(null)$$,'P0001','LIMIT_INVALID','null cannot disable the reconciliation limit');
set constraints all immediate;
select * from finish();
rollback;
