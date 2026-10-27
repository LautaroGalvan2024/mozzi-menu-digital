begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled,store_enabled)
values('27000000-0000-4000-8000-000000000001','Commerce test','Commerce test','commerce-channels','active','+5491111111111','CHN',false,true);
insert into public.categories(id,restaurant_id,name,slug)
values('27000000-0000-4000-8000-000000000002','27000000-0000-4000-8000-000000000001','Cases','cases');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('27000000-0000-4000-8000-000000000003','27000000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000002','CASE','Case',1000);
insert into public.payment_methods(id,restaurant_id,code,name)
values('27000000-0000-4000-8000-000000000004','27000000-0000-4000-8000-000000000001','cash','Cash');
create temporary table channel_request(payload jsonb);
insert into channel_request values('{"restaurantSlug":"commerce-channels","channel":"store","checkoutMode":"whatsapp",
 "idempotencyKey":"27000000-0000-4000-8000-000000000005","customer":{"name":"Customer","phone":"+5491111111111"},
 "fulfillment":{"type":"pickup"},"paymentMethodId":"27000000-0000-4000-8000-000000000004",
 "items":[{"productId":"27000000-0000-4000-8000-000000000003","quantity":1,"optionIds":[]}]}');
select is(public.get_public_menu('commerce-channels'),null::jsonb,'menu remains unpublished while store is published');
select is(public.get_public_catalog('commerce-channels','store')#>>'{restaurant,channel}','store','store resolves its independently published channel');
select is(public.get_public_catalog('commerce-channels','store')#>>'{restaurant,isOpen}','false','no hours means physical business is closed');
select is(public.get_public_catalog('commerce-channels','store')#>>'{restaurant,acceptsOrders}','true','24-hour store accepts orders while business is closed');
select is(public.get_public_catalog('commerce-channels','invalid'),null::jsonb,'unknown channel is not a publication bypass');
select lives_ok($$select public.create_order_transaction((select payload from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,'store can place WhatsApp order with menu disabled and closed hours');
select is((select channel from public.orders where idempotency_key='27000000-0000-4000-8000-000000000005'),'store','order records its actual channel');
select is(public.create_order_transaction((select payload from channel_request),repeat('1',64),repeat('2',64),repeat('4',64))->>'idempotentReplay','true','store retry is idempotent');
select throws_ok($$select public.create_order_transaction((select payload-'channel'-'checkoutMode' from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','RESTAURANT_NOT_AVAILABLE','missing channel defaults to unpublished menu');
update public.restaurants set public_menu_enabled=true where id='27000000-0000-4000-8000-000000000001';
select throws_ok($$select public.create_order_transaction((select payload-'channel'-'checkoutMode' from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','IDEMPOTENCY_CONFLICT','same key cannot replay an order from another channel');
select is(private.order_request_fingerprint((select payload-'channel'-'checkoutMode' from channel_request)),
 private.order_request_fingerprint_v1((select payload-'channel'-'checkoutMode' from channel_request)),'legacy request retains exact v1 fingerprint');
update public.restaurants set store_ordering_policy='business_hours' where id='27000000-0000-4000-8000-000000000001';
select throws_ok($$select public.create_order_transaction((select payload||jsonb_build_object('idempotencyKey',extensions.gen_random_uuid()) from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','RESTAURANT_CLOSED','business-hours store policy is enforced server-side');
update public.restaurants set store_ordering_policy='always',store_checkout_whatsapp_enabled=false where id='27000000-0000-4000-8000-000000000001';
select throws_ok($$select public.create_order_transaction((select payload||jsonb_build_object('idempotencyKey',extensions.gen_random_uuid()) from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','CHECKOUT_MODE_DISABLED','store WhatsApp can be disabled independently');
select throws_ok($$select public.create_order_transaction((select payload||jsonb_build_object('channel','bogus') from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','CHECKOUT_CHANNEL_INVALID','invalid channel fails closed');
select throws_ok($$select public.create_order_transaction((select payload||jsonb_build_object('checkoutMode','online') from channel_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','ONLINE_CHECKOUT_ENDPOINT_REQUIRED','online checkout cannot bypass stock-reservation endpoint');
set constraints all immediate;
select * from finish();
rollback;
