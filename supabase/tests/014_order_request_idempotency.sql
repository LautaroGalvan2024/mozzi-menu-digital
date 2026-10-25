begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled)
values('2e000000-0000-4000-8000-000000000001','Intent tests','Intent tests','intent-tests','active','+5491111111111','Synthetic','Synthetic','INT',true);
insert into public.categories(id,restaurant_id,name,slug)
values('3e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','Food','food');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('4e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','3e000000-0000-4000-8000-000000000001','INTENT','Synthetic product',1000);
insert into public.product_option_groups(id,restaurant_id,product_id,code,name,min_select,max_select)
values('5e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','4e000000-0000-4000-8000-000000000001','EXTRAS','Extras',0,2);
insert into public.product_options(id,restaurant_id,option_group_id,code,name,price_delta_cents) values
('6e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','5e000000-0000-4000-8000-000000000001','A','A',100),
('6e000000-0000-4000-8000-000000000002','2e000000-0000-4000-8000-000000000001','5e000000-0000-4000-8000-000000000001','B','B',200);
insert into public.payment_methods(id,restaurant_id,code,name) values
('7e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','cash','Cash'),
('7e000000-0000-4000-8000-000000000002','2e000000-0000-4000-8000-000000000001','transfer','Transfer');
insert into public.delivery_zones(id,restaurant_id,name,delivery_fee_cents)
values('8e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','Synthetic zone',100);
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at,spans_next_day)
select '2e000000-0000-4000-8000-000000000001'::uuid,d,0,'00:00'::time,'23:59'::time,false from generate_series(0,6)d
union all select '2e000000-0000-4000-8000-000000000001',d,1,'23:58','00:01',true from generate_series(0,6)d;
create temporary table intent_payload(payload jsonb);
insert into intent_payload values('{
 "restaurantSlug":"intent-tests","idempotencyKey":"9e000000-0000-4000-8000-000000000001",
 "customer":{"name":"Synthetic customer","phone":"+5491111111111"},
 "fulfillment":{"type":"delivery","deliveryZoneId":"8e000000-0000-4000-8000-000000000001","address":"Original 123","city":"Synthetic","reference":"Front door"},
 "paymentMethodId":"7e000000-0000-4000-8000-000000000001","notes":"Original notes",
 "items":[{"productId":"4e000000-0000-4000-8000-000000000001","quantity":2,"notes":" No salt ","optionIds":["6e000000-0000-4000-8000-000000000002","6e000000-0000-4000-8000-000000000001"]}]}');
grant select on intent_payload to service_role;
select ok(not has_function_privilege('anon','public.create_order_transaction(jsonb,text,text,text)','execute'),'creation remains unavailable to anon SQL');
select ok(not has_function_privilege('authenticated','public.create_order_transaction(jsonb,text,text,text)','execute'),'creation remains service-only');
select ok(not has_function_privilege('service_role','private.create_order_transaction_without_request_hash(jsonb,text,text,text)','execute'),'service cannot bypass request comparison');
select ok(not has_table_privilege('authenticated','private.order_request_receipts','select'),'request receipts stay private');
set local role service_role;
create temporary table intent_created as select public.create_order_transaction(
 (select payload from intent_payload),repeat('1',64),repeat('2',64),repeat('3',64)) response;
select is((select response->>'idempotentReplay' from intent_created),'false','first request creates an order');
select is(public.create_order_transaction((select payload from intent_payload),repeat('1',64),repeat('2',64),repeat('4',64))->>'idempotentReplay','true','identical request replays');
select throws_ok($$select public.create_order_transaction('{"restaurantSlug":"intent-tests","idempotencyKey":"9e000000-0000-4000-8000-000000000001"}',repeat('1',64),repeat('2',64),repeat('4',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','a bare UUID is not a recovery credential for customer details');
select is(public.create_order_transaction((select payload from intent_payload)||jsonb_build_object('tokenExpiresAt',now()+interval '45 minutes','antiSpam',jsonb_build_object('formStartedAt',now())),repeat('5',64),repeat('6',64),repeat('7',64))->>'idempotentReplay','true','volatile timestamps, anti-spam and transport hashes do not change intent');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{fulfillment,address}','"Changed 456"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed address conflicts before token mutation');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{customer,phone}','"+5492222222222"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed phone conflicts');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{customer,name}','"Other customer"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed customer conflicts');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{paymentMethodId}','"7e000000-0000-4000-8000-000000000002"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed payment method conflicts');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{notes}','"Changed notes"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed order notes conflict');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{items,0,notes}','"Different variety"'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed line notes conflict');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{items,0,quantity}','3'),repeat('1',64),repeat('2',64),repeat('8',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','changed quantity conflicts');
select is(public.create_order_transaction(jsonb_set((select payload from intent_payload),'{items}',
 '[{"productId":"4e000000-0000-4000-8000-000000000001","quantity":1,"notes":"No salt","optionIds":["6e000000-0000-4000-8000-000000000001","6e000000-0000-4000-8000-000000000002"]},{"productId":"4e000000-0000-4000-8000-000000000001","quantity":1,"notes":"No salt","optionIds":["6e000000-0000-4000-8000-000000000002","6e000000-0000-4000-8000-000000000001"]}]'),repeat('1',64),repeat('2',64),repeat('9',64))->>'idempotentReplay','true','split equal lines and option order normalize to the same pricing identity');
select is(public.register_whatsapp_opened((select (response#>>'{order,actionId}')::uuid from intent_created),repeat('3',64))->>'registered','true','token from first response remains valid after retries');
select is(public.register_whatsapp_opened((select (response#>>'{order,actionId}')::uuid from intent_created),repeat('9',64))->>'registered','true','token from another in-flight response also works');
select is(public.register_whatsapp_opened((select (response#>>'{order,actionId}')::uuid from intent_created),repeat('8',64))->>'registered','false','conflicting request never authorizes its token');
select is(public.register_whatsapp_opened((select (response#>>'{order,actionId}')::uuid from intent_created),repeat('f',64))->>'registered','false','unknown token is rejected');
reset role;
select is((select count(*)::integer from public.orders where restaurant_id='2e000000-0000-4000-8000-000000000001'),1,'all replays and conflicts leave exactly one order');
select is((select count(*)::integer from public.order_events where restaurant_id='2e000000-0000-4000-8000-000000000001' and event_type='whatsapp_opened'),1,'multiple valid tokens mutate WhatsApp state exactly once');
select is((select count(*)::integer from private.order_request_receipts where restaurant_id='2e000000-0000-4000-8000-000000000001'),1,'one durable request receipt');
select is((select delivery_address from public.orders where restaurant_id='2e000000-0000-4000-8000-000000000001'),'Original 123','conflict cannot silently change delivery address');
-- Simulate an order committed by the old function during deployment; recover identity from snapshots.
delete from private.order_request_receipts where restaurant_id='2e000000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.create_order_transaction((select payload from intent_payload),repeat('1',64),repeat('2',64),repeat('a',64))->>'idempotentReplay','true','legacy receipt is verified from persisted snapshots');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from intent_payload),'{fulfillment,address}','"Legacy changed 999"'),repeat('1',64),repeat('2',64),repeat('b',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','legacy recovery never adopts the changed request hash');
select throws_ok($$select public.create_order_transaction(jsonb_set(jsonb_set((select payload from intent_payload),'{idempotencyKey}','"9e000000-0000-4000-8000-000000000002"'),'{customer,name}','""'),repeat('1',64),repeat('2',64),repeat('c',64))$$,
 '22023','CUSTOMER_INVALID','new requests retain original validation errors');
reset role;
select is((select count(*)::integer from private.order_request_receipts where restaurant_id='2e000000-0000-4000-8000-000000000001'),1,'failed create rolls back its order and receipt');
select * from finish();
rollback;
