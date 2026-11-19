begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('e1900000-0000-4000-8000-000000000001','delivery-admin@example.test',now(),'{"full_name":"Delivery Admin"}'),
 ('e1900000-0000-4000-8000-000000000002','delivery-other@example.test',now(),'{"full_name":"Delivery Other"}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled,store_enabled,timezone,delivery_enabled) values
 ('e1900000-0000-4000-8000-000000000011','Delivery test','Delivery test','delivery-schedules','active','+5491111111111','DSC',true,true,'America/Argentina/Buenos_Aires',true),
 ('e1900000-0000-4000-8000-000000000012','Other test','Other test','delivery-other','active','+5491111111112','DSO',true,true,'America/Argentina/Buenos_Aires',true);
insert into public.restaurant_members(restaurant_id,user_id,role,status) values
 ('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000001','restaurant_admin','active'),
 ('e1900000-0000-4000-8000-000000000012','e1900000-0000-4000-8000-000000000002','restaurant_admin','active');
insert into public.delivery_zones(id,restaurant_id,name,delivery_fee_cents) values
 ('e1900000-0000-4000-8000-000000000021','e1900000-0000-4000-8000-000000000011','Center',0),
 ('e1900000-0000-4000-8000-000000000022','e1900000-0000-4000-8000-000000000011','North',4500),
 ('e1900000-0000-4000-8000-000000000023','e1900000-0000-4000-8000-000000000012','Foreign',0);

select ok(not has_table_privilege('anon','public.delivery_schedules','select'),'anonymous cannot read the schedule table');
select ok(not has_table_privilege('authenticated','public.delivery_schedules','update'),'members cannot bypass schedule validation');
select ok(not has_function_privilege('anon','public.save_delivery_schedule_policy(uuid,uuid,jsonb,uuid[],bigint)','execute'),'anonymous cannot configure schedules');
select ok(not has_function_privilege('authenticated','private.next_estimated_delivery_date(uuid,uuid,text,timestamptz)','execute'),'private calculation has no direct client grant');
select is(public.get_delivery_estimate('delivery-schedules','e1900000-0000-4000-8000-000000000021','menu')->>'enabled','false','existing zones start disabled');
select is(public.get_delivery_estimate('delivery-schedules','e1900000-0000-4000-8000-000000000023','store'),null::jsonb,'public quote rejects another commerce zone');
select is(public.get_delivery_estimate('delivery-schedules','e1900000-0000-4000-8000-000000000021','invalid'),null::jsonb,'invalid channel cannot bypass publication');

select set_config('request.jwt.claim.sub','e1900000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"e1900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select public.save_delivery_schedule_policy(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"menuEnabled":true,"storeEnabled":false,"weekdays":[2],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":[]}')$$,
 '42501','DELIVERY_SCHEDULE_FORBIDDEN','existing commerce cannot create calendars before opt-in');
select lives_ok($$update public.delivery_zones set delivery_fee_cents=0 where id='e1900000-0000-4000-8000-000000000021'$$,
 'the existing zone editor still works when the schedule is off');
select lives_ok($$select public.save_delivery_zone_settings(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"name":"Center","description":"","deliveryFeeCents":0,"minimumOrderCents":0,"freeShippingFromCents":null,"active":true,"sortOrder":0}')$$,
 'the zone editor can save standard terms without setting a schedule');
reset role;
insert into private.stage_one_features(restaurant_id,delivery_schedule) values('e1900000-0000-4000-8000-000000000011',true);
set local role authenticated;
select lives_ok($$select public.save_delivery_schedule_policy(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"menuEnabled":true,"storeEnabled":false,"weekdays":[2,5],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":[]}',
 array['e1900000-0000-4000-8000-000000000022']::uuid[],0)$$,'admin saves and copies a calendar atomically');
select is(jsonb_array_length(public.get_delivery_schedule_policies('e1900000-0000-4000-8000-000000000011')),2,'copied schedules are listed');
select is((select delivery_fee_cents from public.delivery_zones where id='e1900000-0000-4000-8000-000000000022'),4500::bigint,'calendar copying preserves the destination fee');
select throws_ok($$select public.save_delivery_schedule_policy(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"menuEnabled":true,"storeEnabled":false,"weekdays":[],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":[]}')$$,
 '22023','DELIVERY_SCHEDULE_DAYS_REQUIRED','enabled schedule requires a weekday');
select throws_ok($$select public.save_delivery_schedule_policy(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"menuEnabled":true,"storeEnabled":false,"weekdays":[2],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":["2026-02-30"]}')$$,
 '22023','DELIVERY_SCHEDULE_INVALID','invalid calendar dates are rejected');
select throws_ok($$select public.save_delivery_schedule_policy(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"menuEnabled":true,"storeEnabled":false,"weekdays":[2],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":[]}',
 '{}',0)$$,'PT409','DELIVERY_SCHEDULE_CHANGED','stale editor cannot overwrite a newer schedule');
select throws_ok($$select public.save_delivery_zone_settings(
 'e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021',
 '{"name":"Must rollback","description":"","deliveryFeeCents":1200,"minimumOrderCents":0,"freeShippingFromCents":null,"active":true,"sortOrder":0}',
 '{"menuEnabled":true,"storeEnabled":true,"weekdays":[2],"cutoffTime":"18:00","cutoffDayOffset":1,"closedDates":[]}',
 array['e1900000-0000-4000-8000-000000000023']::uuid[],1)$$,'22023','DELIVERY_ZONE_INVALID','foreign copy target rolls back the entire zone save');
select is((select name from public.delivery_zones where id='e1900000-0000-4000-8000-000000000021'),'Center','failed copy preserves source metadata');
reset role;

select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2026-11-19T20:59:59Z'),'2026-11-20'::date,'before prior-day cutoff includes Friday');
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2026-11-19T21:00:00Z'),'2026-11-24'::date,'exact cutoff moves to next route day');
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','store','2026-11-19T20:59:59Z'),null::date,'opt-in is independent by channel');
update public.delivery_schedules set closed_dates=array['2026-11-20']::date[] where delivery_zone_id='e1900000-0000-4000-8000-000000000021';
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2026-11-19T20:59:59Z'),'2026-11-24'::date,'closure skips the otherwise valid delivery date');
update public.delivery_schedules set cutoff_day_offset=0,closed_dates='{}' where delivery_zone_id='e1900000-0000-4000-8000-000000000021';
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2026-11-20T20:59:59Z'),'2026-11-20'::date,'same-day cutoff is supported');
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2026-11-20T21:00:00Z'),'2026-11-24'::date,'same-day cutoff excludes exact boundary');
update public.delivery_schedules set weekdays=array[4]::smallint[],cutoff_time='23:00' where delivery_zone_id='e1900000-0000-4000-8000-000000000021';
select is(private.next_estimated_delivery_date('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','menu','2027-01-01T01:00:00Z'),'2026-12-31'::date,'local date survives UTC midnight and year boundary');
update public.restaurants set public_menu_enabled=false where id='e1900000-0000-4000-8000-000000000011';
select is(public.get_delivery_estimate('delivery-schedules','e1900000-0000-4000-8000-000000000021','menu'),null::jsonb,'unpublished menu has no public schedule');
update public.restaurants set public_menu_enabled=true where id='e1900000-0000-4000-8000-000000000011';

select set_config('request.jwt.claim.sub','e1900000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"e1900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select is((select count(*)::integer from public.delivery_schedules),0,'RLS hides another commerce schedules');
select throws_ok($$select public.get_delivery_schedule_policies('e1900000-0000-4000-8000-000000000011')$$,'42501','DELIVERY_SCHEDULE_FORBIDDEN','another admin cannot enumerate schedules');
select throws_ok($$select public.save_delivery_schedule_policy('e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000021','{}')$$,'42501','DELIVERY_SCHEDULE_FORBIDDEN','another admin cannot save schedules');
reset role;

-- A real creation/retry proves the estimate is an immutable result, not a moving request field.
insert into public.categories(id,restaurant_id,name,slug) values('e1900000-0000-4000-8000-000000000031','e1900000-0000-4000-8000-000000000011','Items','items');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
 values('e1900000-0000-4000-8000-000000000032','e1900000-0000-4000-8000-000000000011','e1900000-0000-4000-8000-000000000031','P1','Item',1000);
insert into public.payment_methods(id,restaurant_id,code,name) values('e1900000-0000-4000-8000-000000000033','e1900000-0000-4000-8000-000000000011','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at,spans_next_day)
select 'e1900000-0000-4000-8000-000000000011'::uuid,d,0,'00:00'::time,'23:59'::time,false from generate_series(0,6)d
union all select 'e1900000-0000-4000-8000-000000000011',d,1,'23:58','00:01',true from generate_series(0,6)d;
update public.delivery_schedules set store_enabled=true,weekdays=array[0,1,2,3,4,5,6]::smallint[],cutoff_time='18:00',cutoff_day_offset=1
 where delivery_zone_id='e1900000-0000-4000-8000-000000000021';
create temporary table delivery_request(payload jsonb);
insert into delivery_request values('{"restaurantSlug":"delivery-schedules","channel":"store","checkoutMode":"whatsapp",
 "idempotencyKey":"e1900000-0000-4000-8000-000000000041","customer":{"name":"Customer","phone":"+5491111111111"},
 "fulfillment":{"type":"delivery","deliveryZoneId":"e1900000-0000-4000-8000-000000000021","address":"Main 100","city":"City"},
 "paymentMethodId":"e1900000-0000-4000-8000-000000000033","items":[{"productId":"e1900000-0000-4000-8000-000000000032","quantity":1,"optionIds":[]}]}');
create temporary table delivery_original(response jsonb);
insert into delivery_original select public.create_order_transaction((select payload from delivery_request),repeat('1',64),repeat('2',64),repeat('3',64));
select ok((select estimated_delivery_date is not null from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000041'),'creation captures the server date');
select is((select response#>>'{order,estimatedDeliveryDate}' from delivery_original),(select estimated_delivery_date::text from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000041'),'public response carries the persisted date');
select is((select expires_at-created_at from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000041'),interval '2 hours','delivery estimate does not extend order acceptance expiry');
update private.stage_one_features set delivery_schedule=false where restaurant_id='e1900000-0000-4000-8000-000000000011';
select is(public.get_delivery_estimate('delivery-schedules','e1900000-0000-4000-8000-000000000021','store')->>'enabled','false',
 'disabling the module hides estimates for previously configured zones');
select is((select store_enabled from public.delivery_schedules where delivery_zone_id='e1900000-0000-4000-8000-000000000021'),true,
 'disabling preserves the configured route');
select is(public.create_order_transaction((select payload from delivery_request),repeat('1',64),repeat('2',64),repeat('4',64))#>>'{order,estimatedDeliveryDate}',(select response#>>'{order,estimatedDeliveryDate}' from delivery_original),'retry after opt-out returns the original date');
select is((select count(*)::integer from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000041'),1,'retry creates no duplicate order');
select set_config('app.order_mutation','on',true);
select throws_ok($$update public.orders set estimated_delivery_date=estimated_delivery_date+1 where idempotency_key='e1900000-0000-4000-8000-000000000041'$$,'22023','DELIVERY_ESTIMATE_IMMUTABLE','even controlled state mutations cannot rewrite the estimate');
select lives_ok($$select public.create_order_transaction((select payload||jsonb_build_object('idempotencyKey','e1900000-0000-4000-8000-000000000042','fulfillment',jsonb_build_object('type','pickup')) from delivery_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,'pickup remains compatible without a schedule');
select is((select estimated_delivery_date from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000042'),null::date,'pickup has no estimated delivery date');
select lives_ok($$select public.create_order_transaction((select (payload-'channel'-'checkoutMode') ||
  jsonb_build_object('idempotencyKey','e1900000-0000-4000-8000-000000000043') from delivery_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 'an existing menu client still creates a WhatsApp delivery order after opting out');
select is((select estimated_delivery_date from public.orders where idempotency_key='e1900000-0000-4000-8000-000000000043'),null::date,
 'new orders follow the legacy delivery flow while the module is disabled');

set constraints all immediate;
select * from finish();
rollback;
