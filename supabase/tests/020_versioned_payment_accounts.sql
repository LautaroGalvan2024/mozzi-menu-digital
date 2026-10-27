begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
values('29000000-0000-4000-8000-000000000001','versioned-payments@example.test',now(),'{}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,inventory_mode,inventory_activated_at,inventory_business_policy) values
('29000000-0000-4000-8000-000000000002','Versioned','Versioned','versioned-payments','active','+5491111111111','VER',true,'enforced',now(),'{}'),
('29000000-0000-4000-8000-000000000006','Other tenant','Other tenant','versioned-other','active','+5491111111111','OTH',true,'enforced',now(),'{}');
insert into public.restaurant_members(restaurant_id,user_id,role,status)
values('29000000-0000-4000-8000-000000000002','29000000-0000-4000-8000-000000000001','restaurant_admin','active');
insert into public.categories(id,restaurant_id,name,slug)
values('29000000-0000-4000-8000-000000000003','29000000-0000-4000-8000-000000000002','Cases','cases');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values('29000000-0000-4000-8000-000000000004','29000000-0000-4000-8000-000000000002','29000000-0000-4000-8000-000000000003','CASE','Case',1000);
insert into public.inventory_balances(restaurant_id,product_id,on_hand)
values('29000000-0000-4000-8000-000000000002','29000000-0000-4000-8000-000000000004',10);

-- Model the migration's legacy state: credentials retained, environment unknown.
insert into private.payment_accounts(id,restaurant_id,provider_user_id,encrypted_credentials,expires_at)
values('29000000-0000-4000-8000-000000000005','29000000-0000-4000-8000-000000000002','same-provider-both-modes','legacy-cipher-untouched',now()+interval '1 day');
select throws_ok($$update public.restaurants set store_checkout_online_enabled=true where id='29000000-0000-4000-8000-000000000002'$$,
  '22023','ONLINE_CHECKOUT_NOT_READY','unknown legacy environment cannot enable new charges');
select throws_ok($$select public.save_payment_account('29000000-0000-4000-8000-000000000002','same-provider-both-modes','new-cipher',now()+interval '1 day',null)$$,
  '22023','PAYMENT_ENVIRONMENT_REQUIRED','OAuth cannot assume an environment');
select throws_ok($$update private.payment_accounts set live_mode=false where id='29000000-0000-4000-8000-000000000005'$$,
  '22023','PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE','only the explicit legacy bridge may assign a previously unknown environment');
select is(public.backfill_payment_account_environment('29000000-0000-4000-8000-000000000005',false)->>'updated','true','verified legacy mode is backfilled once');
select is(public.backfill_payment_account_environment('29000000-0000-4000-8000-000000000005',false)->>'updated','false','verified legacy backfill is idempotent');
select throws_ok($$select public.backfill_payment_account_environment('29000000-0000-4000-8000-000000000005',true)$$,
  '22023','PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE','backfill cannot reclassify a known sandbox account as production');
select is((select encrypted_credentials from private.payment_accounts where id='29000000-0000-4000-8000-000000000005'),'legacy-cipher-untouched','backfill never rewrites credentials');
select is(public.get_payment_account(p_provider_user_id=>'same-provider-both-modes')->>'accountId','29000000-0000-4000-8000-000000000005','legacy webhook routing is allowed for exactly one known connection');
select public.save_payment_account('29000000-0000-4000-8000-000000000002','same-provider-both-modes','test-cipher-original',now()+interval '1 day',false);
update public.restaurants set store_checkout_online_enabled=true where id='29000000-0000-4000-8000-000000000002';

create temporary table versioned_results(label text primary key,response jsonb,key uuid);
create function pg_temp.versioned_checkout(p_label text,p_live boolean,p_key uuid default extensions.gen_random_uuid(),p_expected_account_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.begin_online_checkout(jsonb_build_object('restaurantSlug','versioned-payments','idempotencyKey',p_key,
    'customer',jsonb_build_object('name','Synthetic buyer','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','00000000-0000-4000-8000-000000000000',
    'items',jsonb_build_array(jsonb_build_object('productId','29000000-0000-4000-8000-000000000004','quantity',1,'optionIds','[]'::jsonb))),
    repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),p_live,
    coalesce(p_expected_account_id,(public.get_payment_account('29000000-0000-4000-8000-000000000002')->>'accountId')::uuid));
  insert into pg_temp.versioned_results values(p_label,result,p_key);
  return result;
end $$;
select throws_ok($$select pg_temp.versioned_checkout('wrong-mode-before',true)$$,
  '22023','PAYMENT_ENVIRONMENT_MISMATCH','production checkout rejects a sandbox current account before reserving');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),0::bigint,'mode mismatch creates no stock hold');
select is((select count(*) from public.orders where restaurant_id='29000000-0000-4000-8000-000000000002'),0::bigint,'mode mismatch creates no order');
select pg_temp.versioned_checkout('test-paid',false);
select pg_temp.versioned_checkout('test-pending',false);
select public.set_online_checkout_preference((select (response->>'attemptId')::uuid from versioned_results where label='test-pending'),
  'test-preference-020','https://sandbox.mercadopago.com.ar/checkout/test-020',(select (response->>'preferenceLeaseId')::uuid from versioned_results where label='test-pending'));
select public.reconcile_online_payment((select (response->>'attemptId')::uuid from versioned_results where label='test-paid'),'test-payment-020','approved',1000,'ARS',now());
select is((select response->>'accountId' from versioned_results where label='test-paid'),'29000000-0000-4000-8000-000000000005','purchase pins its original connection before reservation');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),2::bigint,'paid and pending sandbox purchases both retain their stock');

create temporary table versioned_connections(label text primary key,response jsonb);
insert into versioned_connections values('production',public.save_payment_account('29000000-0000-4000-8000-000000000002','same-provider-both-modes','production-cipher',now()+interval '1 day',true));
select isnt((select response->>'accountId' from versioned_connections where label='production'),'29000000-0000-4000-8000-000000000005','production receives a different immutable connection ID');
select is((select count(*) from private.payment_accounts where restaurant_id='29000000-0000-4000-8000-000000000002'),2::bigint,'connecting production preserves the sandbox connection');
select is((select count(*) from private.payment_accounts where restaurant_id='29000000-0000-4000-8000-000000000002' and is_current),1::bigint,'only one connection is current');
select is((select active from private.payment_accounts where id='29000000-0000-4000-8000-000000000005'),false,'historical connection stops accepting new purchases');
select is((select encrypted_credentials from private.payment_accounts where id='29000000-0000-4000-8000-000000000005'),'test-cipher-original','production never overwrites old sandbox access');
select is((select store_checkout_online_enabled from public.restaurants where id='29000000-0000-4000-8000-000000000002'),false,'changing the receiving connection requires deliberate checkout activation');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),2::bigint,'account switch neither releases nor reserves inventory');
select is(public.get_payment_account('29000000-0000-4000-8000-000000000002')->>'liveMode','true','current-account status selects production');
select is(public.get_payment_account(p_provider_user_id=>'same-provider-both-modes',p_live_mode=>false)->>'accountId','29000000-0000-4000-8000-000000000005','sandbox webhook resolves its retained connection');
select is(public.get_payment_account(p_provider_user_id=>'same-provider-both-modes',p_live_mode=>true)->>'accountId',(select response->>'accountId' from versioned_connections where label='production'),'production webhook resolves the new connection');
select throws_ok($$select public.get_payment_account(p_provider_user_id=>'same-provider-both-modes')$$,
  '22023','PAYMENT_ACCOUNT_LOOKUP_AMBIGUOUS','webhook without environment cannot guess among two versions');
select is(public.get_online_payment_attempt((select (response->>'attemptId')::uuid from versioned_results where label='test-pending'))->>'liveMode','false','historical attempt keeps its sandbox environment after the switch');
select is(public.get_online_checkout_status((select (response->>'actionId')::uuid from versioned_results where label='test-pending'),repeat('d',64),true)#>>'{payment,status}','pending','production recovery can still read its historical purchase');
select is(public.get_online_checkout_status((select (response->>'actionId')::uuid from versioned_results where label='test-pending'),repeat('d',64),true)#>>'{payment,checkoutUrl}',null::text,'production recovery does not return a sandbox checkout link');
select is(public.get_online_checkout_status((select (response->>'actionId')::uuid from versioned_results where label='test-pending'),repeat('d',64),false)#>>'{payment,checkoutUrl}','https://sandbox.mercadopago.com.ar/checkout/test-020','same-environment recovery preserves the original payment link');

update public.restaurants set store_checkout_online_enabled=true where id='29000000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.versioned_checkout('stale-account-preflight',true,extensions.gen_random_uuid(),'29000000-0000-4000-8000-000000000005')$$,
  '40001','PAYMENT_ACCOUNT_NOT_CURRENT','account switch after Edge preflight is fenced before order creation');
select is((select count(*) from public.orders where restaurant_id='29000000-0000-4000-8000-000000000002'),2::bigint,'stale-account preflight creates no order');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),2::bigint,'stale-account preflight creates no reservation');
select throws_ok($$select pg_temp.versioned_checkout('cross-mode-retry',true,(select key from versioned_results where label='test-pending'))$$,
  '22023','PAYMENT_ENVIRONMENT_MISMATCH','idempotent retry cannot migrate a sandbox purchase into production');
select is((select count(*) from public.orders where restaurant_id='29000000-0000-4000-8000-000000000002'),2::bigint,'rejected cross-mode retry duplicates no order');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),2::bigint,'rejected cross-mode retry changes no reservations');
select pg_temp.versioned_checkout('production',true);
select is((select response->>'accountId' from versioned_results where label='production'),(select response->>'accountId' from versioned_connections where label='production'),'new production attempt pins the new connection');
select pg_temp.versioned_checkout('production-retry',true,(select key from versioned_results where label='production'));
select is((select response->>'attemptId' from versioned_results where label='production'),(select response->>'attemptId' from versioned_results where label='production-retry'),'same-environment retry preserves its attempt');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),3::bigint,'same-environment retry does not reserve twice');
select throws_ok($$update private.online_payment_attempts set account_id=(select (response->>'accountId')::uuid from versioned_connections where label='production') where id=(select (response->>'attemptId')::uuid from versioned_results where label='test-paid')$$,
  '22023','PAYMENT_ATTEMPT_ACCOUNT_IMMUTABLE','no caller can rebind an existing attempt to another connection');
select throws_ok($$update private.payment_accounts set live_mode=true where id='29000000-0000-4000-8000-000000000005'$$,
  '22023','PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE','known connection mode cannot be overwritten');

select is(public.acquire_payment_account_refresh('29000000-0000-4000-8000-000000000005',now()+interval '1 day'),true,'historical connection can acquire its own refresh lease');
select is((select refresh_lease_until is null from private.payment_accounts where live_mode and restaurant_id='29000000-0000-4000-8000-000000000002'),true,'historical refresh does not claim the current connection lease');
select is(public.refresh_payment_account('29000000-0000-4000-8000-000000000005','same-provider-both-modes','test-cipher-refreshed',now()+interval '2 days',false,now()+interval '1 day')->>'active','false','historical refresh cannot reactivate sandbox charges');
select is(public.get_payment_account('29000000-0000-4000-8000-000000000002')->>'liveMode','true','historical refresh cannot replace the production current pointer');
select is(public.get_payment_account(p_account_id=>'29000000-0000-4000-8000-000000000005')->>'encryptedCredentials','test-cipher-refreshed','reconciliation can retrieve the refreshed historical connection');
select throws_ok($$select public.refresh_payment_account('29000000-0000-4000-8000-000000000005','same-provider-both-modes','bad-cipher',now(),true,now()+interval '2 days')$$,
  '22023','PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE','refresh cannot change a connection environment');
select throws_ok($$select public.refresh_payment_account('29000000-0000-4000-8000-000000000005','same-provider-both-modes','stale-cipher',now()+interval '3 days',false,now()+interval '1 day')$$,
  '40001','PAYMENT_LEASE_CONFLICT','stale refresh cannot overwrite credentials renewed during its provider request');
select is(public.get_payment_account(p_account_id=>'29000000-0000-4000-8000-000000000005')->>'encryptedCredentials','test-cipher-refreshed','stale refresh leaves the newer credentials intact');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from versioned_results where label='test-pending'),'late-test-payment-020','approved',1000,'ARS',now())->>'paymentStatus','approved','old pending sandbox payment still reconciles after production activation');
select is(public.reconcile_online_payment((select (response->>'attemptId')::uuid from versioned_results where label='test-paid'),'test-payment-020','refunded',1000,'ARS',now()+interval '1 minute')->>'paymentStatus','refunded','historical sandbox refund still reconciles after production activation');
select is((select payment_status from public.orders where id=(select (response->>'orderId')::uuid from versioned_results where label='production')),'pending','sandbox events do not credit the production order');
select is((select reserved from public.inventory_balances where product_id='29000000-0000-4000-8000-000000000004'),2::bigint,'historical refund releases only its own reservation');
select ok(exists(select 1 from jsonb_array_elements(public.list_online_reconciliation()) x where x->>'accountId'='29000000-0000-4000-8000-000000000005' and x->>'liveMode'='false'),'reconciliation queue includes retained sandbox connection identity');
select ok(exists(select 1 from jsonb_array_elements(public.list_online_reconciliation()) x where x->>'liveMode'='true'),'reconciliation queue also includes production connection identity');

insert into versioned_connections values('other',public.save_payment_account('29000000-0000-4000-8000-000000000006','other-provider','other-cipher',now()+interval '1 day',true));
select throws_ok($$select public.save_payment_account('29000000-0000-4000-8000-000000000006','same-provider-both-modes','steal-cipher',now()+interval '1 day',true)$$,
  '22023','PAYMENT_ACCOUNT_ALREADY_CONNECTED','another tenant cannot steal an existing provider and environment');
select is(public.get_payment_account('29000000-0000-4000-8000-000000000006')->>'accountId',(select response->>'accountId' from versioned_connections where label='other'),'failed connection switch preserves the other tenant current account');
select is(public.get_payment_account(p_restaurant_id=>'29000000-0000-4000-8000-000000000006',p_account_id=>'29000000-0000-4000-8000-000000000005'),null::jsonb,'an exact account lookup cannot bypass an explicit tenant filter');
select throws_ok($$update private.online_payment_attempts set account_id=(select (response->>'accountId')::uuid from versioned_connections where label='other') where id=(select (response->>'attemptId')::uuid from versioned_results where label='production')$$,
  '22023','PAYMENT_ATTEMPT_ACCOUNT_IMMUTABLE','attempt cannot be reassigned to a different tenant account');
select set_config('request.jwt.claim.sub','29000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"29000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select is(public.get_payment_connection('29000000-0000-4000-8000-000000000002')->>'liveMode','true','authorized panel sees only its current account mode');
select ok(not public.get_payment_connection('29000000-0000-4000-8000-000000000002') ? 'encryptedCredentials','panel metadata never returns encrypted credentials');
select throws_ok($$select public.get_payment_connection('29000000-0000-4000-8000-000000000006')$$,'42501','PAYMENT_ACCOUNT_FORBIDDEN','panel metadata remains tenant-authorized');
select ok(not has_table_privilege('authenticated','private.payment_accounts','select'),'authenticated browser cannot inspect retained credentials');
select ok(not has_function_privilege('authenticated','public.backfill_payment_account_environment(uuid,boolean)','execute'),'browser cannot assign account environments');
select ok(not has_function_privilege('anon','public.refresh_payment_account(uuid,text,text,timestamptz,boolean,timestamptz)','execute'),'anonymous browser cannot rotate provider credentials');
select public.disconnect_payment_account('29000000-0000-4000-8000-000000000002');
select is(public.refresh_payment_account((select (response->>'accountId')::uuid from versioned_connections where label='production'),'same-provider-both-modes','production-refreshed',now()+interval '2 days',true,now()+interval '1 day')->>'active','false','current-account refresh preserves deliberate disconnection');
select is((select count(*) from private.online_payment_attempts where restaurant_id='29000000-0000-4000-8000-000000000002'),3::bigint,'all historical attempts remain after switches, refreshes and disconnection');
set constraints all immediate;
select * from finish();
rollback;
