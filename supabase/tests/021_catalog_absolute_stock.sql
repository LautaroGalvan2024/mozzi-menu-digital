begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('1a210000-0000-4000-8000-000000000001','stock-catalog-admin@example.test',now(),'{}'),
 ('1a210000-0000-4000-8000-000000000002','stock-catalog-manager@example.test',now(),'{}'),
 ('1a210000-0000-4000-8000-000000000003','stock-catalog-other@example.test',now(),'{}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by) values
 ('2a210000-0000-4000-8000-000000000001','Stock catalogue','Synthetic','stock-catalog','active','+5491111111111','Synthetic','Synthetic','SCA',true,'1a210000-0000-4000-8000-000000000001'),
 ('2a210000-0000-4000-8000-000000000002','Other stock','Synthetic','stock-other','active','+5491111111111','Synthetic','Synthetic','SCB',true,'1a210000-0000-4000-8000-000000000003');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values
 ('2a210000-0000-4000-8000-000000000001','1a210000-0000-4000-8000-000000000001','restaurant_admin','active','1a210000-0000-4000-8000-000000000001'),
 ('2a210000-0000-4000-8000-000000000001','1a210000-0000-4000-8000-000000000002','order_manager','active','1a210000-0000-4000-8000-000000000001'),
 ('2a210000-0000-4000-8000-000000000002','1a210000-0000-4000-8000-000000000003','restaurant_admin','active','1a210000-0000-4000-8000-000000000003');
insert into public.categories(id,restaurant_id,name,slug) values
 ('3a210000-0000-4000-8000-000000000001','2a210000-0000-4000-8000-000000000001','Cases','cases'),
 ('3a210000-0000-4000-8000-000000000002','2a210000-0000-4000-8000-000000000002','Other','other');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents) values
 ('4a210000-0000-4000-8000-000000000001','2a210000-0000-4000-8000-000000000001','3a210000-0000-4000-8000-000000000001','STOCK-A','First',1000),
 ('4a210000-0000-4000-8000-000000000002','2a210000-0000-4000-8000-000000000001','3a210000-0000-4000-8000-000000000001','STOCK-B','Second',1000),
 ('4a210000-0000-4000-8000-000000000099','2a210000-0000-4000-8000-000000000002','3a210000-0000-4000-8000-000000000002','STOCK-X','Other tenant',1000);
insert into public.payment_methods(id,restaurant_id,code,name) values
 ('7a210000-0000-4000-8000-000000000001','2a210000-0000-4000-8000-000000000001','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
 select '2a210000-0000-4000-8000-000000000001',d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
create temporary table stock_orders(label text primary key,id uuid,action_id uuid);
grant select on stock_orders to authenticated;
create function pg_temp.stock_order(p_label text,p_quantity integer) returns uuid language plpgsql security definer set search_path='' as $$
declare k uuid:=extensions.gen_random_uuid(); v_id uuid;
begin
  perform public.create_order_transaction(jsonb_build_object('restaurantSlug','stock-catalog','idempotencyKey',k,
    'customer',jsonb_build_object('name','Synthetic','phone','+5494444444444'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId','7a210000-0000-4000-8000-000000000001','items',jsonb_build_array(jsonb_build_object(
      'productId','4a210000-0000-4000-8000-000000000001','quantity',p_quantity,'optionIds','[]'::jsonb))),repeat('a',64),repeat('b',64),repeat('c',64));
  insert into pg_temp.stock_orders select p_label,id,action_id from public.orders where idempotency_key=k returning id into v_id;
  return v_id;
end $$;
create function pg_temp.save_stock(p_id uuid,p_on text,p_version text,p_op uuid default extensions.gen_random_uuid(),p_name text default 'Saved product')
returns jsonb language sql security invoker set search_path='' as $$
 select public.save_product_catalog_with_stock('2a210000-0000-4000-8000-000000000001',
   jsonb_build_object('id',p_id,'categoryId','3a210000-0000-4000-8000-000000000001','name',p_name,'basePriceCents',1000),
   '[]','{}','{}',p_op,case when p_on is null then null else jsonb_build_object('onHand',p_on,'expectedVersion',p_version) end)
$$;
grant execute on function pg_temp.save_stock(uuid,text,text,uuid,text) to authenticated;
select pg_temp.stock_order('accepted',3);
select pg_temp.stock_order('pending',1);

select set_config('request.jwt.claim.sub','1a210000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1a210000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select public.claim_order((select action_id from stock_orders where label='accepted'));
select is(public.get_catalog_stock('2a210000-0000-4000-8000-000000000001',array['4a210000-0000-4000-8000-000000000001'::uuid])#>>'{items,0,initialized}','false','getter distinguishes missing balance from zero');
select is(public.get_catalog_stock('2a210000-0000-4000-8000-000000000001','{}')#>>'{policy,mode}','never_enabled','empty metadata query supplies initial policy');
select throws_ok($$select public.get_catalog_stock('2a210000-0000-4000-8000-000000000001',array['4a210000-0000-4000-8000-000000000099'::uuid])$$,'22023','INVENTORY_PRODUCT_INVALID','getter rejects other-tenant IDs rather than silently omitting them');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','2',null,'9a210000-0000-4000-8000-000000000001')#>>'{stock,items,0,onHand}','2','existing Sin conteo SKU accepts absolute initial quantity without physical count');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000003','0',null)#>>'{stock,items,0,onHand}','0','creating SKU and explicit zero initialize together');
select is((select inventory_mode from restaurants where id='2a210000-0000-4000-8000-000000000001'),'never_enabled','loading one quantity does not activate policy');
select is((select count(*)::integer from inventory_balances where restaurant_id='2a210000-0000-4000-8000-000000000001'),2,'other product balances are not invented');
select throws_ok($$select public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000002',0)$$,'22023','INVENTORY_NOT_INITIALIZED','activation requires every physical SKU to have explicit quantity');
select lives_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000002','0',null)$$,'second SKU can explicitly start at zero');
select throws_ok($$select public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000002',9)$$,'40001','INVENTORY_VERSION_CONFLICT','activation needs reviewed policy version');
select throws_ok($$select public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000002',0)$$,'22023','INSUFFICIENT_STOCK','initial activation cannot promise accepted legacy quantity exceeding stock');
select is((select inventory_mode from restaurants where id='2a210000-0000-4000-8000-000000000001'),'never_enabled','failed adoption rolls policy back');
select ok((select inventory_business_policy is null from restaurants where id='2a210000-0000-4000-8000-000000000001'),'failed activation rolls new business confirmation back');
select ok(not exists(select 1 from orders where restaurant_id='2a210000-0000-4000-8000-000000000001' and inventory_tracked),'failed activation rolls snapshots and tracked status back');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','5','1','9a210000-0000-4000-8000-000000000003')#>>'{stock,items,0,version}','2','absolute correction requires the loaded version');
select is(public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000002',0)->>'adoptedOrders','2','one activation adopts accepted and generated legacy orders');
select is((select reserved from inventory_balances where product_id='4a210000-0000-4000-8000-000000000001'),3::bigint,'only already accepted legacy order reserves on activation');
select is((select count(*)::integer from orders where restaurant_id='2a210000-0000-4000-8000-000000000001' and inventory_tracked),2,'both open orders gain immutable inventory snapshots');
select is(public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000002',0)->>'replayed','true','activation retry is durable despite policy version change');
select is((select count(*)::integer from inventory_counts where restaurant_id='2a210000-0000-4000-8000-000000000001'),0,'direct activation does not fabricate a physical count');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','2',null,'9a210000-0000-4000-8000-000000000001')->>'replayed','true','old initial save replay returns original result after later reservation');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000001'),5::bigint,'old initial save replay cannot reset later quantity');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','6','3','9a210000-0000-4000-8000-000000000001')$$,'22023','IDEMPOTENCY_CONFLICT','same command key with changed absolute quantity conflicts');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','10',null)$$,'40001','INVENTORY_VERSION_CONFLICT','null expected version cannot overwrite initialized stock');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','10','2',extensions.gen_random_uuid(),'Stale title')$$,'40001','INVENTORY_VERSION_CONFLICT','version changed by reservation rejects stale form');
select is((select name from products where id='4a210000-0000-4000-8000-000000000001'),'Saved product','stock conflict also rolls catalogue metadata back');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','2','3')$$,'22023','INSUFFICIENT_STOCK','absolute stock cannot be less than current reservations');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','8','3','9a210000-0000-4000-8000-000000000004','Latest product')#>>'{stock,items,0,reserved}','3','absolute update preserves reservations');
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001',null,null)#>>'{stock,items}','[]','omitted stock changes only catalogue');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000001'),8::bigint,'omitted stock keeps current balance');
select public.complete_order((select id from stock_orders where label='accepted'));
select is(pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','8','3','9a210000-0000-4000-8000-000000000004','Latest product')->>'replayed','true','replay after delivery returns command outcome');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000001'),5::bigint,'retry after delivery cannot restock sold units');
select is((select name from products where id='4a210000-0000-4000-8000-000000000001'),'Saved product','retry cannot undo later metadata-only save');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000004','0','0')$$,'40001','INVENTORY_VERSION_CONFLICT','new SKU requires null version rather than fabricated zero');
select ok(not exists(select 1 from products where id='4a210000-0000-4000-8000-000000000004'),'failed stock initialization rolls new product back');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000004','-1',null)$$,'22023','INVENTORY_QUANTITY_INVALID','negative absolute quantity is invalid');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000004','1.5',null)$$,'22023','INVENTORY_QUANTITY_INVALID','fractional absolute quantity is invalid');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000004','10000000000000',null)$$,'22023','INVENTORY_QUANTITY_INVALID','absolute quantity enforces thirteen digit maximum');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','5','9223372036854775808')$$,'22023','INVENTORY_QUANTITY_INVALID','version overflow is a controlled validation failure');
select lives_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000004','0',null)$$,'new SKU can initialize in already enforced mode');
select is(public.get_catalog_stock('2a210000-0000-4000-8000-000000000001',array['4a210000-0000-4000-8000-000000000004'::uuid])#>>'{items,0,initialized}','true','zero SKU appears initialized to editor');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000099','7',null)$$,'42501','TENANT_ID_IMMUTABLE','other tenant product cannot acquire this tenant stock');

-- Family creation is one command, including new SKUs and their distinct stock.
reset role;
create temporary table family_request as select
 '{"id":"5a210000-0000-4000-8000-000000000001","categoryId":"3a210000-0000-4000-8000-000000000001","name":"Cases","axes":["Color"]}'::jsonb family,
 '[{"productId":"4a210000-0000-4000-8000-000000000005","attributes":{"Color":"Black"},"product":{"basePriceCents":1100}},
   {"productId":"4a210000-0000-4000-8000-000000000006","attributes":{"Color":"Blue"},"product":{"basePriceCents":1200}}]'::jsonb variants,
 '[{"productId":"4a210000-0000-4000-8000-000000000005","onHand":"7","expectedVersion":null},
   {"productId":"4a210000-0000-4000-8000-000000000006","onHand":"11","expectedVersion":null}]'::jsonb stock;
grant select on family_request to authenticated;
set local role authenticated;
select lives_ok($$select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,variants,'9a210000-0000-4000-8000-000000000005',stock) from family_request$$,'family saves two new SKUs and different quantities atomically');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000006'),11::bigint,'second variant keeps its own quantity');
select is((select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,variants,'9a210000-0000-4000-8000-000000000005',stock)->>'replayed' from family_request),'true','whole family replay needs no new versions');
select throws_ok($$select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,variants,extensions.gen_random_uuid(),
 '[{"productId":"4a210000-0000-4000-8000-000000000005","onHand":"20","expectedVersion":"1"},{"productId":"4a210000-0000-4000-8000-000000000006","onHand":"30","expectedVersion":"0"}]') from family_request$$,
 '40001','INVENTORY_VERSION_CONFLICT','one stale variant aborts the entire family stock update');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000005'),7::bigint,'valid sibling quantity also rolls back on family conflict');
select throws_ok($$select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,variants,extensions.gen_random_uuid(),
 '[{"productId":"4a210000-0000-4000-8000-000000000001","onHand":"99","expectedVersion":"5"}]') from family_request$$,
 '22023','INVENTORY_PRODUCT_INVALID','family cannot update stock for a nonmember SKU');
select throws_ok($$select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,variants,extensions.gen_random_uuid(),
 '[{"productId":"4a210000-0000-4000-8000-000000000005","onHand":"20","expectedVersion":"1"},{"productId":"4a210000-0000-4000-8000-000000000005","onHand":"20","expectedVersion":"1"}]') from family_request$$,
 '22023','INVENTORY_DUPLICATE_PRODUCT','duplicate stock rows cannot apply twice');
select throws_ok($$select public.save_product_family_with_stock('2a210000-0000-4000-8000-000000000001',family,jsonb_set(variants,'{1,attributes,Color}','"Black"'),extensions.gen_random_uuid(),
 '[{"productId":"4a210000-0000-4000-8000-000000000005","onHand":"20","expectedVersion":"1"}]') from family_request$$,
 '23505','FAMILY_VARIANT_DUPLICATE','invalid family combinations cannot commit stock');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000005'),7::bigint,'invalid family leaves quantities unchanged');

select public.change_inventory_policy('2a210000-0000-4000-8000-000000000001','paused','Contingency pause',1);
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000005','8','1')$$,'22023','INVENTORY_PAUSED','absolute editor cannot bypass a genuine contingency pause');
select lives_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000005',null,null)$$,'metadata-only edit remains possible during pause');
select throws_ok($$select public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001',extensions.gen_random_uuid(),2)$$,'22023','INVENTORY_PAUSED','initial activation shortcut cannot bypass a contingency reconciliation');
select public.begin_inventory_count('2a210000-0000-4000-8000-000000000001','9a210000-0000-4000-8000-000000000006','Actual physical reconciliation');
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000005','8','1')$$,'22023','INVENTORY_CUTOVER','active physical count blocks direct quantities');
select is((select on_hand from inventory_balances where product_id='4a210000-0000-4000-8000-000000000005'),7::bigint,'pause and cutover failures do not alter balance');
reset role;
select ok(not exists(select 1 from inventory_operations where restaurant_id='2a210000-0000-4000-8000-000000000001' and actor_user_id is distinct from '1a210000-0000-4000-8000-000000000001'::uuid),'catalogue stock and adoption ledger records real authenticated actor');
select ok(not exists(select 1 from inventory_balances b where b.restaurant_id='2a210000-0000-4000-8000-000000000001' and b.on_hand<>(select coalesce(sum(m.delta_on_hand),0) from inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id)),'all physical balances reconcile exactly to append-only ledger');
select is((select count(*)::integer from inventory_operations where restaurant_id='2a210000-0000-4000-8000-000000000001' and idempotency_key='9a210000-0000-4000-8000-000000000004'),1,'retried product update creates one ledger operation');
select is((select count(*)::integer from inventory_balances where restaurant_id='2a210000-0000-4000-8000-000000000002'),0,'foreign balances remain untouched');
select ok(not has_table_privilege('authenticated','private.catalog_stock_commands','select') and not has_function_privilege('authenticated','private.set_catalog_absolute_stock(uuid,uuid,jsonb,uuid)','execute'),'private idempotency and setter are not browser-callable');

select set_config('request.jwt.claim.sub','1a210000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"1a210000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000005','8','1')$$,'42501','INVENTORY_FORBIDDEN','order manager cannot change stock through catalogue wrapper');
select throws_ok($$select public.get_catalog_stock('2a210000-0000-4000-8000-000000000001','{}')$$,'42501','INVENTORY_FORBIDDEN','catalogue stock getter requires catalogue permission');
select throws_ok($$select public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000001',extensions.gen_random_uuid(),2)$$,'42501','INVENTORY_FORBIDDEN','order manager cannot activate inventory');
reset role;
select set_config('request.jwt.claim.sub','1a210000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"1a210000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000005','8','1')$$,'42501','INVENTORY_FORBIDDEN','other tenant admin cannot edit stock');
select throws_ok($$select public.get_catalog_stock('2a210000-0000-4000-8000-000000000001','{}')$$,'42501','INVENTORY_FORBIDDEN','getter does not reveal foreign policy');
select public.confirm_inventory_business_policy('2a210000-0000-4000-8000-000000000002','{"unitModel":"whole_product","sourceOfTruth":"app","otherChannels":"none","returns":"full_only","partialDeliveries":"none","physicalScope":"until_handoff_including_transit","acceptance":"reserve","delivery":"physical_handoff","acceptedReservationsExpire":false}');
select public.save_product_catalog_with_stock('2a210000-0000-4000-8000-000000000002',
 '{"id":"4a210000-0000-4000-8000-000000000099","categoryId":"3a210000-0000-4000-8000-000000000002","name":"Other owned product","basePriceCents":1000}',
 '[]','{}','{}',extensions.gen_random_uuid(),'{"onHand":"0","expectedVersion":null}');
select is(public.activate_inventory_from_product_stock('2a210000-0000-4000-8000-000000000002',extensions.gen_random_uuid(),0)->>'mode','enforced','owner can activate explicit zero stock without pending orders');
select is((select inventory_business_policy->>'otherChannels' from restaurants where id='2a210000-0000-4000-8000-000000000002'),'none','activation preserves a business policy previously confirmed by merchant');
reset role;
update public.restaurant_members set status='suspended' where user_id='1a210000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','1a210000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1a210000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select pg_temp.save_stock('4a210000-0000-4000-8000-000000000001','2',null,'9a210000-0000-4000-8000-000000000001')$$,'42501','INVENTORY_FORBIDDEN','replay still requires current active membership');
reset role;
select * from finish();
rollback;
