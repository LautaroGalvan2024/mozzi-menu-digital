begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled)
values('2f000000-0000-4000-8000-000000000001','Recovery tests','Recovery tests','recovery-tests','active','+5491111111111','Synthetic','Synthetic','RCV',true);
insert into public.categories(id,restaurant_id,name,slug)
values('3f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','Food','food');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('4f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','3f000000-0000-4000-8000-000000000001','RECOVERY','Synthetic product',1000);
insert into public.payment_methods(id,restaurant_id,code,name)
values('7f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at,spans_next_day)
select '2f000000-0000-4000-8000-000000000001'::uuid,d,0,'00:00'::time,'23:59'::time,false from generate_series(0,6)d
union all select '2f000000-0000-4000-8000-000000000001',d,1,'23:58','00:01',true from generate_series(0,6)d;
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled)
values('2f000000-0000-4000-8000-000000000002','Other recovery tenant','Other recovery tenant','other-recovery-tests','active','+5491111111111','Synthetic','Synthetic','RC2',true);
insert into public.categories(id,restaurant_id,name,slug)
values('3f000000-0000-4000-8000-000000000002','2f000000-0000-4000-8000-000000000002','Food','food');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('4f000000-0000-4000-8000-000000000002','2f000000-0000-4000-8000-000000000002','3f000000-0000-4000-8000-000000000002','RECOVERY','Other synthetic product',1000);
insert into public.payment_methods(id,restaurant_id,code,name)
values('7f000000-0000-4000-8000-000000000002','2f000000-0000-4000-8000-000000000002','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at,spans_next_day)
select '2f000000-0000-4000-8000-000000000002'::uuid,d,0,'00:00'::time,'23:59'::time,false from generate_series(0,6)d
union all select '2f000000-0000-4000-8000-000000000002',d,1,'23:58','00:01',true from generate_series(0,6)d;
create temporary table recovery_payload(payload jsonb);
insert into recovery_payload values(jsonb_build_object(
 'restaurantSlug','recovery-tests','idempotencyKey','9f000000-0000-4000-8000-000000000001',
 'customer',jsonb_build_object('name','Synthetic customer','phone','+5491111111111'),
 'fulfillment',jsonb_build_object('type','pickup'),'paymentMethodId','7f000000-0000-4000-8000-000000000001',
 'items',jsonb_build_array(jsonb_build_object('productId','4f000000-0000-4000-8000-000000000001','quantity',1,'optionIds','[]'::jsonb)),
 'recoveryTokenHash',repeat('a',64),'recoveryExpiresAt',clock_timestamp()+interval '30 minutes'));
grant select on recovery_payload to service_role;

select ok(not has_table_privilege('anon','private.order_confirmation_recovery_tokens','select'),'anonymous clients cannot read token hashes');
select ok(not has_table_privilege('authenticated','private.order_confirmation_recovery_tokens','select'),'members cannot read recovery token hashes');
select ok(not has_table_privilege('service_role','private.order_confirmation_recovery_tokens','select'),'service accesses recovery only through narrow RPCs');
select ok(not has_function_privilege('anon','public.recover_order_confirmation(uuid,text)','execute'),'recovery is not an anonymous SQL RPC');
select ok(not has_function_privilege('authenticated','public.recover_order_confirmation(uuid,text)','execute'),'recovery is not a member SQL RPC');
select ok(not has_function_privilege('service_role','private.create_order_transaction_with_request_hash(jsonb,text,text,text)','execute'),'service cannot bypass atomic recovery token persistence');
set local role service_role;
create temporary table recovery_created as select public.create_order_transaction((select payload from recovery_payload),repeat('1',64),repeat('2',64),repeat('3',64)) response;
select is((select response->>'recoveryTokenStored' from recovery_created),'true','creation atomically stores a recovery capability');
select is(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('a',64))#>>'{order,displayNumber}',(select response#>>'{order,displayNumber}' from recovery_created),'valid token recovers the original confirmation');
select is(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('a',64))->>'clientEventTokenStored','false','recovery does not mint a telemetry token');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),null) is null,'action UUID alone never recovers personal details');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('3',64)) is null,'telemetry bearer hash is not a recovery credential');
select ok(public.recover_order_confirmation('af000000-0000-4000-8000-000000000099',repeat('a',64)) is null,'wrong action ID rejects an otherwise valid recovery token');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('f',64)) is null,'unknown token returns the same unavailable result');
select ok(public.recover_order_confirmation(null,'invalid') is null,'malformed action or hash has the same unavailable result');
select is(public.create_order_transaction((select payload from recovery_payload)||jsonb_build_object('recoveryTokenHash',repeat('b',64),'recoveryExpiresAt',clock_timestamp()+interval '2 hours'),repeat('1',64),repeat('2',64),repeat('4',64))->>'idempotentReplay','true','retry issues a new recovery token without changing business intent');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('a',64)) is not null,'first in-flight response token stays valid after retry');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('b',64)) is not null,'second response token also stays valid');
select is(public.create_order_transaction((select payload from recovery_payload)||jsonb_build_object('recoveryExpiresAt',clock_timestamp()+interval '2 hours'),repeat('1',64),repeat('2',64),repeat('5',64))->>'recoveryExpiresAt',(select response->>'recoveryExpiresAt' from recovery_created),'same token hash never extends its original expiry');
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from recovery_payload),'{customer,name}','"Changed"')||jsonb_build_object('recoveryTokenHash',repeat('c',64)),repeat('1',64),repeat('2',64),repeat('6',64))$$,'22023','IDEMPOTENCY_CONFLICT','conflicting business request cannot authorize a recovery token');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('c',64)) is null,'conflicting request token is absent');
select throws_ok($$select public.create_order_transaction((select payload from recovery_payload)-'recoveryExpiresAt',repeat('1',64),repeat('2',64),repeat('6',64))$$,'22023','RECOVERY_TOKEN_INVALID','partial recovery token input is rejected');
create temporary table second_recovery as select public.create_order_transaction(jsonb_set((select payload from recovery_payload),'{idempotencyKey}','"9f000000-0000-4000-8000-000000000002"')||jsonb_build_object('recoveryTokenHash',repeat('d',64)),repeat('1',64),repeat('2',64),repeat('7',64)) response;
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from second_recovery),repeat('a',64)) is null,'recovery token cannot cross to a different order');
create temporary table other_tenant_recovery as select public.create_order_transaction((select payload from recovery_payload)||jsonb_build_object(
 'restaurantSlug','other-recovery-tests','idempotencyKey','9f000000-0000-4000-8000-000000000004','paymentMethodId','7f000000-0000-4000-8000-000000000002',
 'items',jsonb_build_array(jsonb_build_object('productId','4f000000-0000-4000-8000-000000000002','quantity',1,'optionIds','[]'::jsonb)),
 'recoveryTokenHash',repeat('9',64)),repeat('1',64),repeat('2',64),repeat('8',64)) response;
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from other_tenant_recovery),repeat('a',64)) is null,'valid bearer cannot cross into another tenant order');
select is(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from other_tenant_recovery),repeat('9',64))#>>'{order,displayNumber}',(select response#>>'{order,displayNumber}' from other_tenant_recovery),'other tenant confirmation is available only with its own capability');
select is(public.register_whatsapp_opened((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('a',64))->>'registered','false','recovery token cannot perform WhatsApp telemetry mutation');
reset role;
select ok(not exists(select 1 from private.order_confirmation_recovery_tokens where expires_at>created_at+interval '30 minutes'),'server caps every capability at thirty minutes');
select is((select count(*) from public.orders where restaurant_id='2f000000-0000-4000-8000-000000000001'),2::bigint,'recovery and retries never duplicate the orders');
select is((select count(*) from public.order_events where restaurant_id='2f000000-0000-4000-8000-000000000001' and event_type='whatsapp_opened'),0::bigint,'read-only recovery never emits a WhatsApp event');
select ok(not exists(select 1 from public.orders where restaurant_id='2f000000-0000-4000-8000-000000000001' and status<>'generated'),'confirmation lookup leaves order states unchanged');
update private.order_confirmation_recovery_tokens set created_at=now()-interval '32 minutes',expires_at=now()-interval '3 minutes' where token_hash=repeat('a',64);
set local role service_role;
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('a',64)) is null,'expired capability is unavailable without disclosing why');
select ok(public.recover_order_confirmation((select (response#>>'{order,actionId}')::uuid from recovery_created),repeat('b',64)) is not null,'expiring one token does not invalidate a different valid response');
select is(public.check_order_recovery_rate_limit(repeat('a',64))->>'allowed','true','first recovery attempt consumes an allowed quota slot');
select ok(exists(select 1 from generate_series(1,61) n where public.check_order_recovery_rate_limit(repeat('a',64))->>'allowed'='false'),'repeated lookup attempts are bounded by the IP quota');
select is(public.check_order_recovery_rate_limit(repeat('b',64))->>'allowed','true','different IP hash has a separate quota');
reset role;
select ok((select sum(request_count) from private.order_recovery_rate_limits where key_hash=repeat('a',64))>30,'quota consumption remains persisted without requiring successful recovery');
create function pg_temp.fail_recovery_token_insert() returns trigger language plpgsql as $$begin raise exception using errcode='P0001',message='SYNTHETIC_TOKEN_FAILURE'; end$$;
create trigger recovery_atomic_failure before insert on private.order_confirmation_recovery_tokens for each row execute function pg_temp.fail_recovery_token_insert();
set local role service_role;
select throws_ok($$select public.create_order_transaction(jsonb_set((select payload from recovery_payload),'{idempotencyKey}','"9f000000-0000-4000-8000-000000000003"')||jsonb_build_object('recoveryTokenHash',repeat('e',64)),repeat('1',64),repeat('2',64),repeat('8',64))$$,'P0001','SYNTHETIC_TOKEN_FAILURE','token persistence failure rolls back the entire new order');
reset role;
drop trigger recovery_atomic_failure on private.order_confirmation_recovery_tokens;
select is((select count(*) from public.orders where restaurant_id='2f000000-0000-4000-8000-000000000001'),2::bigint,'failed token write leaves no orphan order');
select ok(not exists(select 1 from private.order_request_receipts where restaurant_id='2f000000-0000-4000-8000-000000000001' and idempotency_key='9f000000-0000-4000-8000-000000000003'),'failed token write also rolls back the idempotency receipt');
select * from finish();
rollback;
