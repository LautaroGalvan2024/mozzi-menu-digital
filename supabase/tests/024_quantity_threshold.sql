begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('1e000000-0000-4000-8000-000000000001','threshold-admin@example.test',now(),'{"full_name":"Threshold Admin"}'),
 ('1e000000-0000-4000-8000-000000000002','threshold-outsider@example.test',now(),'{"full_name":"Outsider"}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,store_enabled,created_by)
 values('2e000000-0000-4000-8000-000000000001','Threshold','Threshold','threshold','active','+5491111111111','Address','City','THR',true,true,'1e000000-0000-4000-8000-000000000001');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by)
 values('2e000000-0000-4000-8000-000000000001','1e000000-0000-4000-8000-000000000001','restaurant_admin','active','1e000000-0000-4000-8000-000000000001');
insert into public.categories(id,restaurant_id,name,slug)
 values('3e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','Main','main');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
 values('4e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','3e000000-0000-4000-8000-000000000001','YERBA','Yerba',450000);
insert into public.product_quantity_prices(restaurant_id,product_id,quantity,total_price_cents)
 values('2e000000-0000-4000-8000-000000000001','4e000000-0000-4000-8000-000000000001',3,1200000);
insert into public.payment_methods(id,restaurant_id,code,name,adjustment_type,adjustment_scope)
 values('8e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','cash','Cash','none','subtotal');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
 select '2e000000-0000-4000-8000-000000000001',d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
insert into public.product_option_groups(id,restaurant_id,product_id,code,name,min_select,max_select)
 values('5e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','4e000000-0000-4000-8000-000000000001','EXTRA','Extra',0,1);
insert into public.product_options(id,restaurant_id,option_group_id,code,name,price_delta_cents)
 values('6e000000-0000-4000-8000-000000000001','2e000000-0000-4000-8000-000000000001','5e000000-0000-4000-8000-000000000001','GIFT','Gift wrap',10000);

create function pg_temp.product_payload(p_patch jsonb) returns jsonb language sql as $$
 select '{"id":"4e000000-0000-4000-8000-000000000001","categoryId":"3e000000-0000-4000-8000-000000000001","code":"YERBA","name":"Yerba","description":"","basePriceCents":450000,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0}'::jsonb || p_patch
$$;
create function pg_temp.base_price(p_quantity integer,p_unit bigint default 450000) returns jsonb language sql as $$
 select private.calculate_product_base_pricing('2e000000-0000-4000-8000-000000000001','4e000000-0000-4000-8000-000000000001',p_quantity,p_unit)
$$;
grant execute on function pg_temp.product_payload(jsonb) to authenticated;

select is(pg_temp.base_price(4)->>'baseSubtotalCents','1650000','existing bundle prices remain unchanged');
select ok(not has_column_privilege('authenticated','public.products','quantity_threshold_minimum','update'),'threshold configuration requires an atomic RPC');
select ok(not has_function_privilege('authenticated','private.calculate_product_base_pricing(uuid,uuid,integer,bigint)','execute'),'pricing helper remains private');
create temporary table revision_before as select revision from private.catalog_revisions where restaurant_id='2e000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub','1e000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1e000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select lives_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":{"minimumQuantity":3,"unitPriceCents":400000}}'),'[]')$$,'admin enables one threshold');
select throws_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"name":"Should roll back","quantityThreshold":{"minimumQuantity":101,"unitPriceCents":400000}}'),'[]')$$,'22023','PRODUCT_QUANTITY_THRESHOLD_INVALID','invalid threshold rejects the complete save');
select throws_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":{"minimumQuantity":3.5,"unitPriceCents":400000}}'),'[]')$$,'22023','PRODUCT_QUANTITY_THRESHOLD_INVALID','fractional minimum is rejected');
select throws_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":{"minimumQuantity":3}}'),'[]')$$,'22023','PRODUCT_QUANTITY_THRESHOLD_INVALID','incomplete threshold is rejected');
reset role;

select is((select name from public.products where code='YERBA'),'Yerba','failed validation rolls back product metadata');
select ok((select revision from private.catalog_revisions where restaurant_id='2e000000-0000-4000-8000-000000000001')>(select revision from revision_before),'threshold edits advance catalog revision');
select is(pg_temp.base_price(q)->>'baseSubtotalCents',expected,'all-units threshold quantity '||q)
 from (values(1,'450000'),(2,'900000'),(3,'1200000'),(4,'1600000'),(5,'2000000'),(6,'2400000'),(100,'40000000')) cases(q,expected);
select is(pg_temp.base_price(4,350000)->>'baseSubtotalCents','1400000','cheaper active unit promotion is retained');
select is(pg_temp.base_price(4,350000)->>'mode','unit','a cheaper unit offer is not labelled as threshold pricing');
select is(pg_temp.base_price(4)->>'mode','quantity','threshold retains the backward compatible snapshot mode');
select is(pg_temp.base_price(4)->>'quantityPricingType','threshold','snapshot distinguishes threshold from bundles');
select is(pg_temp.base_price(4)->>'appliedUnitPriceCents','400000','snapshot records the applied unit price');
select is(pg_temp.base_price(4)->'components','[{"quantity":1,"count":4,"totalPriceCents":"400000","subtotalCents":"1600000"}]'::jsonb,'snapshot components remain compatible with existing readers');
select is((select count(*)::integer from public.product_quantity_prices where active and product_id='4e000000-0000-4000-8000-000000000001'),1,'dormant bundle is preserved');

set local role anon;
select is(public.get_public_menu('threshold')#>'{categories,0,products,0,quantityThreshold}','{"minimumQuantity":3,"unitPriceCents":"400000"}'::jsonb,'legacy menu exposes the threshold');
select is(public.get_public_catalog('threshold','store')#>'{categories,0,products,0,quantityPrices}','[]'::jsonb,'store projection hides dormant bundles');
select is(public.get_public_products_by_ids('threshold','menu',array['4e000000-0000-4000-8000-000000000001'::uuid])#>'{products,0,quantityThreshold}','{"minimumQuantity":3,"unitPriceCents":"400000"}'::jsonb,'cart hydration exposes the threshold');
reset role;

set local role authenticated;
select lives_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{}'),'[]')$$,'legacy save omits the new field');
select lives_ok($$select public.import_products_batch('2e000000-0000-4000-8000-000000000001','{"products":[{"code":"YERBA","name":"Yerba importada","basePriceCents":450000}],"optionGroups":[],"options":[]}','update')$$,'metadata import still works');
reset role;
select is((select quantity_threshold_minimum::integer from public.products where code='YERBA'),3,'legacy save and import preserve the active threshold');

set local role service_role;
create temporary table threshold_order as select public.create_order_transaction(
 '{"restaurantSlug":"threshold","idempotencyKey":"9e000000-0000-4000-8000-000000000001","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8e000000-0000-4000-8000-000000000001","items":[{"productId":"4e000000-0000-4000-8000-000000000001","quantity":2,"optionIds":["6e000000-0000-4000-8000-000000000001"],"unitPriceCents":1},{"productId":"4e000000-0000-4000-8000-000000000001","quantity":2,"optionIds":["6e000000-0000-4000-8000-000000000001"]}]}',repeat('1',64),repeat('2',64),repeat('3',64)) as response;
reset role;
select is((select response#>>'{order,subtotalCents}' from threshold_order),'1640000','checkout groups identical configurations, ignores client prices and adds options per unit');
select is((select oi.pricing_breakdown_snapshot->>'minimumQuantity' from public.order_items oi join public.orders o on o.id=oi.order_id where o.idempotency_key='9e000000-0000-4000-8000-000000000001'),'3','checkout persists threshold metadata');

set local role service_role;
create temporary table separate_threshold_order as select public.create_order_transaction(
 '{"restaurantSlug":"threshold","idempotencyKey":"9e000000-0000-4000-8000-000000000002","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8e000000-0000-4000-8000-000000000001","items":[{"productId":"4e000000-0000-4000-8000-000000000001","quantity":2,"optionIds":[],"notes":"A"},{"productId":"4e000000-0000-4000-8000-000000000001","quantity":2,"optionIds":[],"notes":"B"}]}',repeat('4',64),repeat('5',64),repeat('6',64)) as response;
reset role;
select is((select response#>>'{order,subtotalCents}' from separate_threshold_order),'1800000','different configurations do not combine to reach the threshold');

set local role authenticated;
select lives_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":{"minimumQuantity":100,"unitPriceCents":"399999"}}'),'[]')$$,'minimum of 100 and cent prices are accepted');
reset role;
select is(pg_temp.base_price(99)->>'baseSubtotalCents','44550000','quantity below the new minimum returns to regular pricing');
select is(pg_temp.base_price(100)->>'baseSubtotalCents','39999900','minimum 100 applies exactly without rounding');
set local role authenticated;
select lives_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":null}'),'[]')$$,'explicit null returns to saved bundles');
reset role;
select is(pg_temp.base_price(4)->>'baseSubtotalCents','1650000','switching back restores original bundle behavior');
select is((select oi.line_total_cents from public.order_items oi join public.orders o on o.id=oi.order_id where o.idempotency_key='9e000000-0000-4000-8000-000000000001'),1640000::bigint,'later catalog changes leave historical order totals unchanged');

select set_config('request.jwt.claim.sub','1e000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"1e000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select public.save_product_catalog('2e000000-0000-4000-8000-000000000001',pg_temp.product_payload('{"quantityThreshold":{"minimumQuantity":3,"unitPriceCents":1}}'),'[]')$$,'42501','CATALOG_MANAGEMENT_FORBIDDEN','outsider cannot modify threshold pricing');
reset role;
select * from finish();
rollback;
