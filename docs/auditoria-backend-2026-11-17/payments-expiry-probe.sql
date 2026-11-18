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
select lives_ok($$select public.save_payment_account('28000000-0000-4000-8000-000000000002','synthetic-merchant','encrypted-synthetic',now()+interval '1 day',false)$$,'server stores encrypted merchant credentials');
update public.restaurants set store_checkout_online_enabled=true where id='28000000-0000-4000-8000-000000000002';
select is(public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'active','true','new connection is active');
select ok(not has_table_privilege('service_role','private.payment_accounts','select'),'credentials are exposed only through explicit service RPC');
select ok(not has_function_privilege('authenticated','public.begin_online_checkout(jsonb,text,text,text,text,boolean,uuid)','execute'),'anonymous customer cannot invoke trusted payment transaction directly');
select ok(not has_function_privilege('service_role','private.create_commerce_order(jsonb,text,text,text)','execute'),'service cannot bypass the reservation wrapper through PostgREST');

create temporary table payment_test_results(label text primary key,response jsonb,key uuid);
create function pg_temp.payment_fixture(p_label text,p_product uuid default '28000000-0000-4000-8000-000000000004',p_key uuid default extensions.gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.begin_online_checkout(jsonb_build_object('restaurantSlug','commerce-payments','idempotencyKey',p_key,
    'customer',jsonb_build_object('name','Synthetic customer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','00000000-0000-4000-8000-000000000000',
    'items',jsonb_build_array(jsonb_build_object('productId',p_product,'quantity',1,'optionIds','[]'::jsonb))),repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
    (public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'accountId')::uuid);
  insert into pg_temp.payment_test_results values(p_label,result,p_key);
  return result;
end $$;
set local statement_timeout='15s';
select pg_temp.payment_fixture('blocked');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,inventory_mode,inventory_activated_at,inventory_business_policy)
values('28000000-0000-4000-8000-000000000102','Other tenant','Other tenant','audit-other-tenant','active','+5491111111111','OTR',true,'enforced',now(),'{}');
insert into public.categories(id,restaurant_id,name,slug) values('28000000-0000-4000-8000-000000000103','28000000-0000-4000-8000-000000000102','Category','category');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('28000000-0000-4000-8000-000000000104','28000000-0000-4000-8000-000000000102','28000000-0000-4000-8000-000000000103','OTR','Other product',1000);
insert into public.inventory_balances(restaurant_id,product_id,on_hand) values('28000000-0000-4000-8000-000000000102','28000000-0000-4000-8000-000000000104',1);
select public.save_payment_account('28000000-0000-4000-8000-000000000102','audit-other-merchant','encrypted-synthetic',now()+interval '1 day',false);
update public.restaurants set store_checkout_online_enabled=true where id='28000000-0000-4000-8000-000000000102';
insert into payment_test_results(label,response,key)
select 'healthy',public.begin_online_checkout(jsonb_build_object('restaurantSlug','audit-other-tenant','idempotencyKey',extensions.gen_random_uuid(),
'customer',jsonb_build_object('name','Synthetic customer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
'paymentMethodId','00000000-0000-4000-8000-000000000000','items',jsonb_build_array(jsonb_build_object('productId','28000000-0000-4000-8000-000000000104','quantity',1,'optionIds','[]'::jsonb))),
repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,(public.get_payment_account('28000000-0000-4000-8000-000000000102')->>'accountId')::uuid),null;
update private.online_payment_attempts set expires_at=now()-interval '1 minute' where restaurant_id='28000000-0000-4000-8000-000000000002';
update private.online_payment_attempts set expires_at=now()-interval '2 minutes' where restaurant_id='28000000-0000-4000-8000-000000000102';
select set_config('request.jwt.claim.sub','28000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"28000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select public.change_inventory_policy('28000000-0000-4000-8000-000000000002','paused','Audit recount',(select inventory_version from public.restaurants where id='28000000-0000-4000-8000-000000000002'));
select public.begin_inventory_count('28000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000009','Audit recount');
create temporary table audit_probe_result(code text,message text);
do $$ begin perform public.expire_online_reservations(now(),10); insert into audit_probe_result values('NO_ERROR','NO_ERROR'); exception when others then insert into audit_probe_result values(sqlstate,sqlerrm); end $$;
select 'AUDIT:'||jsonb_build_object('test','cross_tenant_expiry_failure','error',(select row_to_json(r) from audit_probe_result r),'healthyTenantOrderStatus',(select o.status from public.orders o join payment_test_results t on o.id=(t.response->>'orderId')::uuid where t.label='healthy'),'healthyTenantReserved',(select reserved from public.inventory_balances where product_id='28000000-0000-4000-8000-000000000104'))::text;
rollback;
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
select lives_ok($$select public.save_payment_account('28000000-0000-4000-8000-000000000002','synthetic-merchant','encrypted-synthetic',now()+interval '1 day',false)$$,'server stores encrypted merchant credentials');
update public.restaurants set store_checkout_online_enabled=true where id='28000000-0000-4000-8000-000000000002';
select is(public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'active','true','new connection is active');
select ok(not has_table_privilege('service_role','private.payment_accounts','select'),'credentials are exposed only through explicit service RPC');
select ok(not has_function_privilege('authenticated','public.begin_online_checkout(jsonb,text,text,text,text,boolean,uuid)','execute'),'anonymous customer cannot invoke trusted payment transaction directly');
select ok(not has_function_privilege('service_role','private.create_commerce_order(jsonb,text,text,text)','execute'),'service cannot bypass the reservation wrapper through PostgREST');

create temporary table payment_test_results(label text primary key,response jsonb,key uuid);
create function pg_temp.payment_fixture(p_label text,p_product uuid default '28000000-0000-4000-8000-000000000004',p_key uuid default extensions.gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.begin_online_checkout(jsonb_build_object('restaurantSlug','commerce-payments','idempotencyKey',p_key,
    'customer',jsonb_build_object('name','Synthetic customer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','00000000-0000-4000-8000-000000000000',
    'items',jsonb_build_array(jsonb_build_object('productId',p_product,'quantity',1,'optionIds','[]'::jsonb))),repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
    (public.get_payment_account('28000000-0000-4000-8000-000000000002')->>'accountId')::uuid);
  insert into pg_temp.payment_test_results values(p_label,result,p_key);
  return result;
end $$;
set local statement_timeout='15s';
select pg_temp.payment_fixture('expired');
update private.online_payment_attempts set expires_at=now()-interval '1 minute' where restaurant_id='28000000-0000-4000-8000-000000000002';
select public.expire_online_reservations(now(),10);
select 'AUDIT:'||jsonb_build_object('test','expired_attempt_remains_in_queue','orderStatus',(select o.status from public.orders o join payment_test_results t on o.id=(t.response->>'orderId')::uuid where t.label='expired'),'paymentStatus',(select o.payment_status from public.orders o join payment_test_results t on o.id=(t.response->>'orderId')::uuid where t.label='expired'),'queueContainsExpired',exists(select 1 from jsonb_array_elements(public.list_online_reconciliation(10)) x where x->>'attemptId'=(select response->>'attemptId' from payment_test_results where label='expired')))::text;
rollback;
