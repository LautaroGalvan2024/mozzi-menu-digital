begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('1f000000-0000-4000-8000-000000000001','family-admin@example.test',now(),'{}'),
 ('1f000000-0000-4000-8000-000000000002','family-other@example.test',now(),'{}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by) values
 ('2f000000-0000-4000-8000-000000000001','Variants','Variants','variants-test','active','+5491111111111','Address','City','VAA',true,'1f000000-0000-4000-8000-000000000001'),
 ('2f000000-0000-4000-8000-000000000002','Other','Other','variants-other','active','+5492222222222','Address','City','VAB',true,'1f000000-0000-4000-8000-000000000002');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values
 ('2f000000-0000-4000-8000-000000000001','1f000000-0000-4000-8000-000000000001','restaurant_admin','active','1f000000-0000-4000-8000-000000000001'),
 ('2f000000-0000-4000-8000-000000000002','1f000000-0000-4000-8000-000000000002','restaurant_admin','active','1f000000-0000-4000-8000-000000000002');
insert into public.categories(id,restaurant_id,name,slug) values
 ('3f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','Fundas','fundas'),
 ('3f000000-0000-4000-8000-000000000002','2f000000-0000-4000-8000-000000000002','Other','other');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents) values
 ('4f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','3f000000-0000-4000-8000-000000000001','BLACK','Original black',1000),
 ('4f000000-0000-4000-8000-000000000002','2f000000-0000-4000-8000-000000000001','3f000000-0000-4000-8000-000000000001','RED','Original red',1200),
 ('4f000000-0000-4000-8000-000000000003','2f000000-0000-4000-8000-000000000002','3f000000-0000-4000-8000-000000000002','OTHER','Other product',500);
insert into public.inventory_balances(restaurant_id,product_id,on_hand,reserved) values
 ('2f000000-0000-4000-8000-000000000001','4f000000-0000-4000-8000-000000000001',5,0),
 ('2f000000-0000-4000-8000-000000000001','4f000000-0000-4000-8000-000000000002',9,0);
insert into public.payment_methods(id,restaurant_id,code,name) values
 ('7f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
select '2f000000-0000-4000-8000-000000000001',d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
create temporary table family_fixture(family jsonb,variants jsonb);
insert into family_fixture values
 ('{"id":"5f000000-0000-4000-8000-000000000001","code":"SILICONE","name":"Funda silicona","categoryId":"3f000000-0000-4000-8000-000000000001","axes":["Modelo","Color"],"active":true}',
  '[{"productId":"4f000000-0000-4000-8000-000000000001","attributes":{"Modelo":"iPhone 15","Color":"Negro"}},{"productId":"4f000000-0000-4000-8000-000000000002","attributes":{"Modelo":"iPhone 15","Color":"Rojo"}}]');
grant select,update on family_fixture to authenticated;

select ok(not has_function_privilege('anon','public.save_product_family(uuid,jsonb,jsonb)','execute'),'public cannot group SKU');
select ok(not has_table_privilege('authenticated','public.product_families','update'),'family writes use the transactional RPC');
select ok(not has_column_privilege('authenticated','public.products','family_id','update'),'group assignments cannot bypass the graph validation');
select set_config('request.jwt.claim.sub','1f000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1f000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select is(public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),(select variants from family_fixture))->>'variants','2','existing SKU grouped atomically');
select is((select code from public.products where id='4f000000-0000-4000-8000-000000000001'),'BLACK','SKU code preserved');
select is((select on_hand from public.inventory_balances where product_id='4f000000-0000-4000-8000-000000000001'),5::bigint,'black stock preserved');
select is((select on_hand from public.inventory_balances where product_id='4f000000-0000-4000-8000-000000000002'),9::bigint,'red stock remains independent');
select is((select count(*) from public.inventory_movements),0::bigint,'grouping creates no physical stock movements');
select throws_ok($$select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),
 jsonb_set((select variants from family_fixture),'{1,attributes}','{"Modelo":"iPhone 15","Color":"Negro"}'))$$,
 '23505','FAMILY_VARIANT_DUPLICATE','duplicate combination rejected');
select is((select variant_attributes->>'Color' from public.products where code='RED'),'Rojo','failed grouping rolls every variant back');
select throws_ok($$select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),
 '[{"productId":"4f000000-0000-4000-8000-000000000001","attributes":{"Color":"Negro"}}]')$$,
 '22023','FAMILY_VARIANT_INVALID','missing model rejected');
select throws_ok($$select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),
 '[{"productId":"4f000000-0000-4000-8000-000000000003","attributes":{"Color":"Negro","Modelo":"iPhone 15"}}]')$$,
 '42501','FAMILY_PRODUCT_UNAVAILABLE','cross-tenant SKU rejected');
select is((select value#>>'{family,name}' from jsonb_array_elements(public.get_public_menu('variants-test')#>'{categories,0,products}') where value->>'code'='BLACK'),
 'Funda silicona','public menu shares the family metadata');

reset role;
select public.create_order_transaction('{"restaurantSlug":"variants-test","idempotencyKey":"8f000000-0000-4000-8000-000000000001","customer":{"name":"Buyer","phone":"+5494444444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"7f000000-0000-4000-8000-000000000001","items":[{"productId":"4f000000-0000-4000-8000-000000000001","quantity":1,"optionIds":[]}]}',repeat('a',64),repeat('b',64),repeat('c',64));
select is((select variant_attributes_snapshot->>'Color' from public.order_items where product_id='4f000000-0000-4000-8000-000000000001'),'Negro','order snapshots exact selected variant');
select is((select product_name_snapshot from public.order_items where product_id='4f000000-0000-4000-8000-000000000001'),'Funda silicona · iPhone 15 / Negro','order and WhatsApp describe the chosen SKU');
set local role authenticated;
update family_fixture set family=jsonb_set(family,'{name}','"Funda nueva"');
select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),(select variants from family_fixture));
select is((select family_name_snapshot from public.order_items where product_id='4f000000-0000-4000-8000-000000000001'),'Funda silicona','family edits do not rewrite historical order labels');
update family_fixture set family=jsonb_set(family,'{active}','false');
select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),(select variants from family_fixture));
select is(jsonb_array_length(public.get_public_menu('variants-test')#>'{categories,0,products}'),0,'hidden family hides all its variants');
reset role;
select throws_ok($$select public.create_order_transaction('{"restaurantSlug":"variants-test","idempotencyKey":"8f000000-0000-4000-8000-000000000002","customer":{"name":"Buyer","phone":"+5494444444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"7f000000-0000-4000-8000-000000000001","items":[{"productId":"4f000000-0000-4000-8000-000000000001","quantity":1,"optionIds":[]}]}',repeat('a',64),repeat('b',64),repeat('c',64))$$,
 '22023','PRODUCT_UNAVAILABLE','direct order cannot buy a hidden family variant');

create temporary table family_import(payload jsonb);
insert into family_import values ('{"batchId":"bf000000-0000-4000-8000-000000000001","products":[
 {"rowRef":"2","code":"IMPORT-B","name":"Import blue","category":"Fundas","basePriceCents":500,"familyCode":"IMPORT","familyName":"Imported family","variantAttributes":{"Color":"Blue"}},
 {"rowRef":"3","code":"IMPORT-R","name":"Import red","category":"Fundas","basePriceCents":600,"familyCode":"IMPORT","familyName":"Imported family","variantAttributes":{"Color":"Red"}}]}');
grant select on family_import to authenticated;
set local role authenticated;
select is(public.import_products_batch('2f000000-0000-4000-8000-000000000001',(select payload from family_import),'upsert')#>>'{summary,created}','2','import creates family and SKU in one transaction');
select is((select count(distinct family_id) from public.products where code in ('IMPORT-B','IMPORT-R')),1::bigint,'imported variants share one family');
select lives_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001',(select payload from family_import),'upsert')$$,'import replay is safe');
select is((select count(*) from public.products where code in ('IMPORT-B','IMPORT-R')),2::bigint,'replay does not duplicate SKU');
select lives_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001','[{"code":"IMPORT-B","name":"Edited via old file","category":"Fundas","basePriceCents":550}]','upsert')$$,'old import format updates an existing variant');
select is((select variant_attributes->>'Color' from public.products where code='IMPORT-B'),'Blue','old file preserves grouping');
select lives_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001','[{"code":"IMPORT-B","name":"Ignored","category":"Other","basePriceCents":100,"familyCode":"OTHER","familyName":"Different","variantAttributes":{"Size":"S"}}]','skip')$$,'skip existing leaves the whole grouping intact');
select is((select variant_attributes->>'Color' from public.products where code='IMPORT-B'),'Blue','skip preserves original attributes');
select throws_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001','[{"code":"ROLLBACK-A","name":"First","category":"Fundas","basePriceCents":100,"familyCode":"ROLLBACK","familyName":"Rollback","variantAttributes":{"Color":"Red"}},{"code":"ROLLBACK-B","name":"Second","category":"Fundas","basePriceCents":100,"familyCode":"ROLLBACK","familyName":"Rollback","variantAttributes":{"Color":"Red"}}]','create')$$,
 '23505','FAMILY_VARIANT_DUPLICATE','duplicate combinations roll back entire import');
select is((select count(*) from public.products where code like 'ROLLBACK-%'),0::bigint,'no SKU remains after invalid family import');
select is((select count(*) from public.product_families where code='ROLLBACK'),0::bigint,'no family remains after invalid import');
select set_config('request.jwt.claim.sub','1f000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"1f000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
select is((select count(*) from public.product_families where restaurant_id='2f000000-0000-4000-8000-000000000001'),0::bigint,'other tenant cannot read families');
select throws_ok($$select public.save_product_family('2f000000-0000-4000-8000-000000000001',(select family from family_fixture),(select variants from family_fixture))$$,
 '42501','CATALOG_MANAGEMENT_FORBIDDEN','other tenant cannot modify family');
reset role;
select * from finish();
rollback;
