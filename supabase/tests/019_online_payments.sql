begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
values('28000000-0000-4000-8000-000000000001','commerce-admin@example.test',now(),'{}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled)
values('28000000-0000-4000-8000-000000000002','Payments test','Payments test','commerce-payments','active','+5491111111111','PAY',true);
insert into public.restaurant_members(restaurant_id,user_id,role,status)
values('28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000001','restaurant_admin','active');
insert into public.categories(id,restaurant_id,name,slug)
values('28000000-0000-4000-8000-000000000003','28000000-0000-4000-8000-000000000002','Cases','cases');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents) values
('28000000-0000-4000-8000-000000000004','28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000003','BLACK','Black case',1000),
('28000000-0000-4000-8000-000000000005','28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000003','RED','Red case',1000);
insert into public.inventory_balances(restaurant_id,product_id,on_hand) values
('28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000004',1),
('28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000005',5);
select throws_ok($$update public.restaurants set store_checkout_online_enabled=true where id='28000000-0000-4000-8000-000000000002'$$,
 '22023','ONLINE_CHECKOUT_NOT_READY','online activation requires both inventory and a connected account');
update public.restaurants set inventory_mode='enforced',inventory_activated_at=now(),inventory_business_policy='{}'
where id='28000000-0000-4000-8000-000000000002';
select lives_ok($$select public.save_payment_account('28000000-0000-4000-8000-000000000002','synthetic-merchant','encrypted-synthetic',now()+interval '1 day')$$,'server stores encrypted merchant credentials');
update public.restaurants set store_checkout_online_enabled=true where id='28000000-0000-4000-8000-000000000002';
select is(public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'active','true','new connection is active');
select ok(not has_table_privilege('service_role','private.payment_accounts','select'),'credentials are exposed only through explicit service RPC');
select ok(not has_function_privilege('authenticated','public.begin_online_checkout(jsonb,text,text,text,text)','execute'),'anonymous customer cannot invoke trusted payment transaction directly');
select ok(not has_function_privilege('service_role','private.create_commerce_order(jsonb,text,text,text)','execute'),'service cannot bypass the reservation wrapper through PostgREST');

create temporary table payment_test_results(label text primary key,response jsonb,key uuid);
create function pg_temp.payment_fixture(p_label text,p_product uuid default '28000000-0000-4000-8000-000000000004',p_key uuid default extensions.gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.begin_online_checkout(jsonb_build_object('restaurantSlug','commerce-payments','idempotencyKey',p_key,
    'customer',jsonb_build_object('name','Synthetic customer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','00000000-0000-4000-8000-000000000000',
    'items',jsonb_build_array(jsonb_build_object('productId',p_product,'quantity',1,'optionIds','[]'::jsonb))),repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64));
  insert into pg_temp.payment_test_results values(p_label,result,p_key);
  return result;
end $$;
select lives_ok($$select pg_temp.payment_fixture('first')$$,'online checkout creates order and reserves last unit atomically');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000004'),1::bigint,'last unit is reserved before provider redirect');
select is((select response->>'preferenceLeaseAcquired' from payment_test_results where label='first'),'true','first caller acquires preference creation lease');
select lives_ok($$select pg_temp.payment_fixture('retry','28000000-0000-4000-8000-000000000004',(select key from payment_test_results where label='first'))$$,'same checkout replays before reserve can fail');
select is((select response->>'attemptId' from payment_test_results where label='first'),(select response->>'attemptId' from payment_test_results where label='retry'),'retry has the same payment attempt');
select is((select response->>'preferenceLeaseAcquired' from payment_test_results where label='retry'),'false','concurrent retry cannot create another preference');
select is((select count(*) from public.inventory_operations where restaurant_id='28000000-0000-4000-8000-000000000002' and kind='payment_hold'),1::bigint,'retry does not duplicate stock hold');
select throws_ok($$select pg_temp.payment_fixture('oversell')$$,'22023','INSUFFICIENT_STOCK','a second customer cannot reserve the last unit');
select is((select count(*) from public.orders where restaurant_id='28000000-0000-4000-8000-000000000002'),1::bigint,'failed reserve rolls back its order as well');
select throws_ok($$select public.set_online_checkout_preference((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'synthetic-pref','https://www.mercadopago.com.ar/checkout/test',extensions.gen_random_uuid())$$,
 '40001','PAYMENT_LEASE_CONFLICT','stale preference writer is fenced');
select lives_ok($$select public.set_online_checkout_preference((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'synthetic-pref','https://www.mercadopago.com.ar/checkout/test',(select (response->>'preferenceLeaseId')::uuid from payment_test_results where label='first'))$$,'lease holder attaches provider preference');
select throws_ok($$select public.get_online_checkout_status((select (response->>'actionId')::uuid from payment_test_results where label='first'),repeat('e',64))$$,
 '42501','PAYMENT_STATUS_FORBIDDEN','action ID alone cannot disclose payment result');
select is(public.get_online_checkout_status((select (response->>'actionId')::uuid from payment_test_results where label='first'),repeat('d',64))#>>'{payment,status}','pending','status bearer shows only verified pending state');
select ok(not (public.get_online_checkout_status((select (response->>'actionId')::uuid from payment_test_results where label='first'),repeat('d',64))->'order' ? 'customerPhone'),'public payment status excludes customer phone');
select set_config('request.jwt.claim.sub','28000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"28000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select throws_ok($$select public.claim_order((select (response->>'actionId')::uuid from payment_test_results where label='first'))$$,
 '22023','PAYMENT_NOT_APPROVED','operator cannot accept an unpaid online purchase');
select throws_ok($$select public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'payment-1','approved',1,'ARS',now())$$,
 '22023','PAYMENT_VERIFICATION_FAILED','wrong amount cannot credit the order');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'payment-1','approved',1000,'ARS',now())->>'paymentStatus','approved','verified payment approves the independent payment state');
select is((select status::text from public.orders where id=(select (response->>'orderId')::uuid from payment_test_results where label='first')),'generated','paid purchase awaits preparation without fake human acceptance');
select is((select count(*) from public.inventory_operations where restaurant_id='28000000-0000-4000-8000-000000000002' and kind='reserve' and actor_type='system' and actor_user_id is null),1::bigint,'payment reservation conversion records explicit system actor');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'payment-1','approved',1000,'ARS',now())->>'replayed','true','duplicate webhook is idempotent');
select is(public.claim_order((select (response->>'actionId')::uuid from payment_test_results where label='first'))->>'claimed','true','paid checkout can be accepted by actual operator');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000004'),1::bigint,'acceptance does not reserve the paid unit a second time');
select lives_ok($$select public.complete_order((select (response->>'orderId')::uuid from payment_test_results where label='first'))$$,'delivery consumes confirmed paid reservation');
select is((select on_hand from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000004'),0::bigint,'delivery deducts physical stock exactly once');
select lives_ok($$select public.complete_order((select (response->>'orderId')::uuid from payment_test_results where label='first'))$$,'delivery retry is idempotent');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='first'),'payment-1','refunded',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','refunded','refund updates payment independently');
select is((select on_hand from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000004'),0::bigint,'refunding delivered goods does not silently restock them');

select pg_temp.payment_fixture('late-no-stock','28000000-0000-4000-8000-000000000005');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='late-no-stock'),'payment-2','rejected',1000,'ARS',now())->>'paymentStatus','rejected','rejected payment releases its temporary hold');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),0::bigint,'failed payment returns available stock');
-- Fixture for another sale consuming all units before a delayed approval.
update public.inventory_balances set on_hand=0 where product_id='28000000-0000-4000-8000-000000000005';
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='late-no-stock'),'payment-2','approved',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','requires_refund','late approval without stock is explicit refund review');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='late-no-stock'),'payment-2-duplicate','rejected',1000,'ARS',now()+interval '2 minutes')->>'paymentStatus','requires_refund','rejection of another payment cannot clear a missing-stock review');
select throws_ok($$select public.claim_order((select (response->>'actionId')::uuid from payment_test_results where label='late-no-stock'))$$,
 '22023','PAYMENT_NOT_APPROVED','no-stock paid case cannot be prepared');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),0::bigint,'late approval never creates negative or phantom stock');
update public.inventory_balances set on_hand=5 where product_id='28000000-0000-4000-8000-000000000005';
select pg_temp.payment_fixture('expired','28000000-0000-4000-8000-000000000005');
update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id=(select (response->>'attemptId')::uuid from payment_test_results where label='expired');
select is(public.expire_online_reservations(),1,'maintenance releases abandoned payment reservation');
select is((select status::text from public.orders where id=(select (response->>'orderId')::uuid from payment_test_results where label='expired')),'expired','abandoned checkout becomes expired');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='expired'),'payment-3','approved',1000,'ARS',now())->>'paymentStatus','approved','late approval reacquires available units atomically');
select is((select status::text from public.orders where id=(select (response->>'orderId')::uuid from payment_test_results where label='expired')),'generated','successfully recovered late payment returns to preparation queue');
select is(public.expire_orders(now()+interval '10 days'),0,'legacy expiry cannot expire an online paid order');
select is(public.cancel_order((select (response->>'orderId')::uuid from payment_test_results where label='expired'),'Customer cancellation')->>'cancelled','true','operator cancels paid order before acceptance');
select is((select payment_status from public.orders where id=(select (response->>'orderId')::uuid from payment_test_results where label='expired')),'requires_refund','cancelled does not falsely mean refunded');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),0::bigint,'cancellation releases confirmed reservation once');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='expired'),'payment-3','refunded',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','refunded','provider refund resolves cancelled paid order');

select pg_temp.payment_fixture('multiple','28000000-0000-4000-8000-000000000005');
select public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='multiple'),'payment-4','approved',1000,'ARS',now());
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='multiple'),'payment-5','rejected',1000,'ARS',now())->>'paymentStatus','approved','rejected second payment cannot downgrade another approved payment');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='multiple'),'payment-5','approved',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','requires_refund','duplicate charge is detected instead of duplicate inventory deduction');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='multiple'),'payment-5','refunded',1000,'ARS',now()+interval '2 minutes')->>'paymentStatus','approved','refunding duplicate charge preserves original paid purchase');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),1::bigint,'duplicate-charge resolution preserves one reservation');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='multiple'),'payment-4','rejected',1000,'ARS',now()-interval '1 minute')->>'replayed','true','out-of-order stale receipt cannot undo payment');

select pg_temp.payment_fixture('partial','28000000-0000-4000-8000-000000000005');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='partial'),'payment-6','partially_refunded',1000,'ARS',now())->>'paymentStatus','partially_refunded','partial refund as first notification is explicit review');
select is((select reservation_state from private.online_payment_attempts where id=(select (response->>'attemptId')::uuid from payment_test_results where label='partial')),'committed','first partial-refund event preserves a real confirmed reservation');
select throws_ok($$select public.claim_order((select (response->>'actionId')::uuid from payment_test_results where label='partial'))$$,
 '22023','PAYMENT_NOT_APPROVED','partially refunded order cannot be prepared without resolution');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='partial'),'payment-7','rejected',1000,'ARS',now())->>'paymentStatus','partially_refunded','another rejected payment cannot clear partial-refund review');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='partial'),'payment-6','refunded',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','refunded','full refund resolves partial state and releases stock');
select pg_temp.payment_fixture('disputed','28000000-0000-4000-8000-000000000005');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='disputed'),'payment-8','in_mediation',1000,'ARS',now())->>'paymentStatus','requires_refund','provider dispute is accepted and blocks preparation for review');
select throws_ok($$select public.claim_order((select (response->>'actionId')::uuid from payment_test_results where label='disputed'))$$,
 '22023','PAYMENT_NOT_APPROVED','disputed purchase cannot be prepared');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='disputed'),'payment-8','charged_back',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','charged_back','chargeback resolves held stock without a fictitious refund approval');

-- A physical recount must retain both paid-but-unaccepted and temporary holds.
select pg_temp.payment_fixture('count-held','28000000-0000-4000-8000-000000000005');
select public.change_inventory_policy('28000000-0000-4000-8000-000000000002','paused','Physical recount',
  (select inventory_version from public.restaurants where id='28000000-0000-4000-8000-000000000002'));
select public.begin_inventory_count('28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000009','Physical recount');
create temporary table online_count_rows as select jsonb_build_array(
  jsonb_build_object('productId','28000000-0000-4000-8000-000000000004','quantity',0,'countedAt',clock_timestamp()),
  jsonb_build_object('productId','28000000-0000-4000-8000-000000000005','quantity',5,'countedAt',clock_timestamp())) rows;
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),2::bigint,'count starts with one paid and one temporary reservation');
select throws_ok($$select public.finish_inventory_count('28000000-0000-4000-8000-000000000009',jsonb_set((select rows from online_count_rows),'{1,quantity}','1'),'{}',true,'Synthetic no movement attestation',false)$$,
 '22023','INSUFFICIENT_STOCK','physical count cannot omit unaccepted online reservations');
select throws_ok($$select public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='count-held'),'payment-9','rejected',1000,'ARS',now())$$,
 '22023','INVENTORY_CUTOVER','payment release cannot move stock during immobile count');
select lives_ok($$select public.finish_inventory_count('28000000-0000-4000-8000-000000000009',(select rows from online_count_rows),'{}',true,'Synthetic no movement attestation',false)$$,'correct physical recount preserves online reservations');
select is((select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000005'),2::bigint,'count retains both online reservations unchanged');
select lives_ok($$select public.change_inventory_policy('28000000-0000-4000-8000-000000000002','enforced','Resume after physical recount',
  (select inventory_version from public.restaurants where id='28000000-0000-4000-8000-000000000002'))$$,'inventory can resume after recount with online obligations');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from payment_test_results where label='count-held'),'payment-9','rejected',1000,'ARS',now())->>'paymentStatus','rejected','blocked payment event can be retried after recount');

select public.save_payment_oauth_state(repeat('f',64),'encrypted-pkce-fixture');
select is(public.consume_payment_oauth_state(repeat('f',64))->>'encryptedPayload','encrypted-pkce-fixture','OAuth state recovers encrypted verifier once');
select throws_ok($$select public.consume_payment_oauth_state(repeat('f',64))$$,'22023','OAUTH_STATE_INVALID','OAuth state is single-use');
select public.disconnect_payment_account('28000000-0000-4000-8000-000000000002');
select public.save_payment_account('28000000-0000-4000-8000-000000000002','synthetic-merchant','refreshed-encrypted',now()+interval '2 days',false);
select is(public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'active','false','background token refresh does not reactivate disconnected payments');
select is(public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'encryptedCredentials','refreshed-encrypted','disconnected accounts retain credentials for reconciliation');
select throws_ok($$select pg_temp.payment_fixture('disconnected','28000000-0000-4000-8000-000000000005')$$,
 '22023','ONLINE_CHECKOUT_NOT_READY','disconnected account cannot accept new online checkout');
set constraints all immediate;
select * from finish();
rollback;
