begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled,store_enabled)
values
  ('32000000-0000-4000-8000-000000000001','Seller test','Seller test','seller-test','active','+5491111111111','SLR',false,true),
  ('32000000-0000-4000-8000-000000000002','Another shop','Another shop','seller-other','active','+5491111111112','OTR',false,true);
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
values('32000000-0000-4000-8000-000000000010','seller-admin@example.test',now(),'{}');
insert into public.restaurant_members(restaurant_id,user_id,role,status)
values('32000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000010','restaurant_admin','active');
select set_config('request.jwt.claim.sub','32000000-0000-4000-8000-000000000010',true);
select set_config('request.jwt.claims','{"sub":"32000000-0000-4000-8000-000000000010","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select public.save_seller('32000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000006',
 'Alex','+5491111111113',null,true,false,true)$$,'42501','FORBIDDEN','tenant admins cannot save sellers before opt-in');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
insert into public.categories(id,restaurant_id,name,slug)
values('32000000-0000-4000-8000-000000000003','32000000-0000-4000-8000-000000000001','Offers','offers');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('32000000-0000-4000-8000-000000000004','32000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000003','P','Product',1000);
insert into public.payment_methods(id,restaurant_id,code,name)
values('32000000-0000-4000-8000-000000000005','32000000-0000-4000-8000-000000000001','cash','Cash');
insert into public.sellers(id,restaurant_id,name,whatsapp_phone,store_enabled)
values
  ('32000000-0000-4000-8000-000000000006','32000000-0000-4000-8000-000000000001','Alex','+5491111111113',true),
  ('32000000-0000-4000-8000-000000000007','32000000-0000-4000-8000-000000000002','Andrea','+5491111111114',true);
insert into public.inventory_balances(restaurant_id,product_id,on_hand)
values('32000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000004',2);
update public.restaurants set inventory_mode='enforced',inventory_activated_at=now(),inventory_business_policy='{}'
where id='32000000-0000-4000-8000-000000000001';

create temporary table seller_request(payload jsonb);
insert into seller_request values('{
  "restaurantSlug":"seller-test","channel":"store","checkoutMode":"whatsapp",
  "sellerId":"32000000-0000-4000-8000-000000000006",
  "idempotencyKey":"32000000-0000-4000-8000-000000000008",
  "customer":{"name":"Sample buyer","phone":"+5491199999901"},
  "fulfillment":{"type":"pickup"},"paymentMethodId":"32000000-0000-4000-8000-000000000005",
  "items":[{"productId":"32000000-0000-4000-8000-000000000004","quantity":1,"optionIds":[]}]}');

select is(public.get_public_seller('seller-test','store','32000000-0000-4000-8000-000000000006'),null::jsonb,'an old link stays hidden when the module is off');
select throws_ok($$select public.create_order_transaction((select payload from seller_request),repeat('1',64),repeat('2',64),repeat('3',64))$$,
 '22023','SELLER_NOT_AVAILABLE','the order trigger rejects new referrals before opt-in');
insert into private.stage_one_features(restaurant_id,sellers) values('32000000-0000-4000-8000-000000000001',true);
set local role anon;
select is(public.get_public_seller('seller-test','store','32000000-0000-4000-8000-000000000006')->>'name','Alex','the active seller is visible for the correct published channel');
select ok(not (public.get_public_seller('seller-test','store','32000000-0000-4000-8000-000000000006') ? 'whatsapp_phone'),'public seller lookup omits the phone');
select is(public.get_public_seller('seller-test','store','32000000-0000-4000-8000-000000000007'),null::jsonb,'a seller from another shop is hidden');
select is(public.get_public_seller('seller-other','store','32000000-0000-4000-8000-000000000007'),null::jsonb,'a second tenant stays disabled when the pilot opts in');
select is(public.get_public_seller('seller-test','menu','32000000-0000-4000-8000-000000000006'),null::jsonb,'an unpublished channel is hidden');
select ok(not has_table_privilege('anon','public.sellers','SELECT'),'anon has no direct sellers access');
select ok(not has_function_privilege('anon','public.save_seller(uuid,uuid,text,text,text,boolean,boolean,boolean)','EXECUTE'),'anon cannot save a seller');
reset role;

select throws_ok($$select public.create_order_transaction(
  (select payload || '{"sellerId":"32000000-0000-4000-8000-000000000007"}' from seller_request),
  repeat('1',64),repeat('2',64),repeat('3',64))$$,
  '22023','SELLER_NOT_AVAILABLE','checkout rejects a seller from another shop');

create temporary table seller_result as select public.create_order_transaction(
  (select payload || jsonb_build_object('recoveryTokenHash',repeat('8',64),'recoveryExpiresAt',now()+interval '25 minutes') from seller_request),
  repeat('1',64),repeat('2',64),repeat('3',64)
) as response;

select is((select response#>>'{order,sellerName}' from seller_result),'Alex','confirmation uses the trusted seller name');
select is((select response#>>'{order,sellerWhatsappPhone}' from seller_result),'+5491111111113','confirmation uses the trusted seller destination');
select is((select seller_id from public.orders where idempotency_key='32000000-0000-4000-8000-000000000008'),
  '32000000-0000-4000-8000-000000000006'::uuid,'order stores the seller id');
select throws_ok($$select public.create_order_transaction(
  (select payload-'sellerId' from seller_request),repeat('1',64),repeat('2',64),repeat('4',64))$$,
  '22023','IDEMPOTENCY_CONFLICT','removing attribution changes the business request');

update private.stage_one_features set sellers=false where restaurant_id='32000000-0000-4000-8000-000000000001';
select is((select public.recover_order_confirmation((response#>>'{order,actionId}')::uuid,repeat('8',64))#>>'{order,sellerName}' from seller_result),
  'Alex','switching off referrals preserves the saved seller name');
select is((select public.recover_order_confirmation((response#>>'{order,actionId}')::uuid,repeat('8',64))#>>'{order,sellerWhatsappPhone}' from seller_result),
  null::text,'switching off referrals lets recovery fall back to the commerce contact');
update private.stage_one_features set sellers=true where restaurant_id='32000000-0000-4000-8000-000000000001';

update public.sellers set name='Alex, nuevo nombre', whatsapp_phone='+5491111111115'
where id='32000000-0000-4000-8000-000000000006';
select is((select public.recover_order_confirmation((response#>>'{order,actionId}')::uuid,repeat('8',64))#>>'{order,sellerName}' from seller_result),
  'Alex','recovery uses the original seller snapshot');
select is((select public.recover_order_confirmation((response#>>'{order,actionId}')::uuid,repeat('8',64))#>>'{order,sellerWhatsappPhone}' from seller_result),
  null::text,'recovery omits the changed seller number');
update public.sellers set active=false where id='32000000-0000-4000-8000-000000000006';
select is(public.get_public_seller('seller-test','store','32000000-0000-4000-8000-000000000006'),null::jsonb,'inactive links stop resolving');
select is(public.create_order_transaction((select payload from seller_request),repeat('1',64),repeat('2',64),repeat('5',64))->>'idempotentReplay',
  'true','the original intent still replays after deactivation');

update public.sellers set active=true where id='32000000-0000-4000-8000-000000000006';
select public.save_payment_account('32000000-0000-4000-8000-000000000001','synthetic-seller-test','synthetic',now()+interval '1 day',false);
update public.restaurants set store_checkout_online_enabled=true where id='32000000-0000-4000-8000-000000000001';

create temporary table seller_payment_result as select public.begin_online_checkout(
  (select payload || jsonb_build_object('idempotencyKey','32000000-0000-4000-8000-000000000009') from seller_request),
  repeat('1',64),repeat('2',64),repeat('6',64),repeat('7',64),false,
  (public.get_payment_account('32000000-0000-4000-8000-000000000001')->>'accountId')::uuid
) as response;
select is((select seller_id from public.orders where idempotency_key='32000000-0000-4000-8000-000000000009'),
  '32000000-0000-4000-8000-000000000006'::uuid,'online payment stores the same attribution');
select is((select public.get_online_checkout_status((response->>'actionId')::uuid,repeat('7',64),false)#>>'{order,sellerName}' from seller_payment_result),
  'Alex, nuevo nombre','online status shows attributed seller');
select ok(not (select (public.get_online_checkout_status((response->>'actionId')::uuid,repeat('7',64),false)->'order') ? 'sellerWhatsappPhone' from seller_payment_result),
  'online status omits seller contact information');
select is((select reserved from public.inventory_balances where product_id='32000000-0000-4000-8000-000000000004'),1::bigint,'online attribution preserves the stock hold');

set constraints all immediate;
select * from finish();
rollback;
