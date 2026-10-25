begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('1c000000-0000-4000-8000-000000000001','sku-admin@example.test',now(),'{"full_name":"SKU Admin"}'),
 ('1c000000-0000-4000-8000-000000000002','sku-other@example.test',now(),'{"full_name":"Other Admin"}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by) values
 ('2c000000-0000-4000-8000-000000000001','SKU A','SKU A','sku-a','active','+5491111111111','Address','City','SKA',true,'1c000000-0000-4000-8000-000000000001'),
 ('2c000000-0000-4000-8000-000000000002','SKU B','SKU B','sku-b','active','+5492222222222','Address','City','SKB',true,'1c000000-0000-4000-8000-000000000002');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values
 ('2c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000001','restaurant_admin','active','1c000000-0000-4000-8000-000000000001'),
 ('2c000000-0000-4000-8000-000000000002','1c000000-0000-4000-8000-000000000002','restaurant_admin','active','1c000000-0000-4000-8000-000000000002');
insert into public.categories(id,restaurant_id,name,slug) values
 ('3c000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','Main','main'),
 ('3c000000-0000-4000-8000-000000000002','2c000000-0000-4000-8000-000000000002','Main','main');
insert into public.products(id,restaurant_id,category_id,code,name,description,base_price_cents,promotional_price_cents,available,featured,sort_order) values
 ('4c000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','3c000000-0000-4000-8000-000000000001','000123','Existing','Preserve description',1000,900,false,true,7),
 ('4c000000-0000-4000-8000-000000000002','2c000000-0000-4000-8000-000000000001','3c000000-0000-4000-8000-000000000001','ARCHIVED','Archived','',1000,null,true,false,0);
update public.products set deleted_at=now() where code='ARCHIVED' and restaurant_id='2c000000-0000-4000-8000-000000000001';
insert into public.product_quantity_prices(restaurant_id,product_id,quantity,total_price_cents,active) values
 ('2c000000-0000-4000-8000-000000000001','4c000000-0000-4000-8000-000000000001',2,1700,true);

select ok(not has_function_privilege('anon','public.get_catalog_import_result(uuid,uuid)','execute'),'anon cannot recover import results');
select ok(not has_table_privilege('authenticated','private.catalog_import_batches','select'),'import ledger is not directly readable');
select ok(not has_function_privilege('authenticated','private.claim_catalog_code(uuid,uuid,text)','execute'),'allocator is private');
select set_config('request.jwt.claim.sub','1c000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1c000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;

create temporary table sku_manual as select public.save_product_catalog(
 '2c000000-0000-4000-8000-000000000001',
 '{"id":"4c000000-0000-4000-8000-000000000010","categoryId":"3c000000-0000-4000-8000-000000000001","name":"Manual automatic","basePriceCents":1000,"quantityPrices":[{"quantity":2,"totalPriceCents":"1700"}]}', '[]') result;
select matches((select result->>'code' from sku_manual),'^P-[0-9]{6,}$','manual missing code generates a short code');
select is((select result->>'productId' from sku_manual),'4c000000-0000-4000-8000-000000000010','manual preserves draft UUID');
select is((select result->>'quantityPrices' from sku_manual),'1','quantity-pricing wrapper remains active');
select is(public.save_product_catalog('2c000000-0000-4000-8000-000000000001',
 '{"id":"4c000000-0000-4000-8000-000000000010","categoryId":"3c000000-0000-4000-8000-000000000001","code":"  ","name":"Edited","basePriceCents":1100}', '[]')->>'code',
 (select result->>'code' from sku_manual),'same UUID and blank code preserve assignment');
select is((select count(*)::integer from public.product_quantity_prices where product_id='4c000000-0000-4000-8000-000000000010' and active),1,'manual edit without rules preserves quantity prices');
select throws_ok($$select public.save_product_catalog('2c000000-0000-4000-8000-000000000001',
 '{"id":"4c000000-0000-4000-8000-000000000011","categoryId":"3c000000-0000-4000-8000-000000000001","code":123,"name":"Bad","basePriceCents":1000}','[]')$$,
 '22023','PRODUCT_PAYLOAD_INVALID','numeric JSON codes are rejected instead of losing zeros');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"code":"archived","name":"Reuse","category":"Main","basePriceCents":1000}]','create')$$,
 '23505','PRODUCT_CODE_ALREADY_USED','archived code cannot be assigned to another product');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"name":"Unsafe retry","category":"Main","basePriceCents":1000}]','upsert')$$,
 '22023','IMPORT_BATCH_ID_REQUIRED','new rows without codes require stable import identity');

create temporary table sku_payload(payload jsonb);
insert into sku_payload values ('{"batchId":"bc000000-0000-4000-8000-000000000001","products":[
 {"rowRef":"2","name":"No code","category":"Main","basePriceCents":1200},
 {"rowRef":"4","code":"P-000002","name":"Explicit after blank","category":"Main","basePriceCents":1300},
 {"rowRef":"5","code":"000124","name":"Leading zeros","category":"Main","basePriceCents":1400}],
 "optionGroups":[{"productRowRef":"2","groupCode":"G","name":"Required","required":true,"minSelect":1,"maxSelect":1}],
 "options":[{"productRowRef":"2","groupCode":"G","optionCode":"O","name":"One","priceDeltaCents":0}]}');
create temporary table sku_import as select public.import_products_batch(
 '2c000000-0000-4000-8000-000000000001',(select payload from sku_payload),'upsert') result;
select is((select result#>>'{summary,created}' from sku_import),'3','mixed batch creates all three products');
select is((select result#>>'{products,0,code}' from sku_import),'P-000003','automatic row skips explicit code reserved by a later row');
select is((select result#>>'{products,1,code}' from sku_import),'P-000002','explicit code is preserved independent of row order');
select is((select result#>>'{products,2,code}' from sku_import),'000124','leading zeros survive server import');
select is((select result#>>'{products,0,rowRef}' from sku_import),'2','physical source row reference survives result mapping');
select is((select count(*)::integer from public.product_option_groups g join public.product_options o on o.option_group_id=g.id
 where g.product_id=(select (result#>>'{products,0,id}')::uuid from sku_import) and g.code='G' and o.code='O'),1,'children attach to generated product by rowRef');
select is(public.import_products_batch('2c000000-0000-4000-8000-000000000001',(select payload from sku_payload),'upsert')::text,
 (select result::text from sku_import),'retry returns exactly the persisted result');
select is(public.get_catalog_import_result('2c000000-0000-4000-8000-000000000001','bc000000-0000-4000-8000-000000000001')::text,
 (select result::text from sku_import),'result can be recovered after response loss');
update public.products set name='Edited after import' where id=(select (result#>>'{products,0,id}')::uuid from sku_import);
select lives_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',(select payload from sku_payload),'upsert')$$,'replay after later edit succeeds');
select is((select name from public.products where id=(select (result#>>'{products,0,id}')::uuid from sku_import)),
 'Edited after import','replay does not overwrite later edits');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 jsonb_set((select payload from sku_payload),'{products,0,name}','"Different"'),'upsert')$$,
 '22023','IMPORT_IDEMPOTENCY_CONFLICT','same key with changed content is rejected');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',(select payload from sku_payload),'skip')$$,
 '22023','IMPORT_IDEMPOTENCY_CONFLICT','same key with changed mode is rejected');
select is(public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"batchId":"bc000000-0000-4000-8000-000000000002","products":[{"name":"No code","category":"Main","basePriceCents":1200}]}','upsert')#>>'{summary,created}',
 '1','new deliberate batch without code creates a new product despite matching name');

select is(public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"code":"000123","basePriceCents":1500}]','update')#>>'{summary,updated}','1','price-only legacy import updates existing product');
select ok((select not (r ? 'batchId') and not ((r->'products'->0) ? 'rowRef')
 from (select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"code":"000123","basePriceCents":1500}]','update') r) legacy),
 'legacy request retains the exact strict Edge response shape');
select ok((select description='Preserve description' and promotional_price_cents=900 and not available and featured and sort_order=7
 from public.products where id='4c000000-0000-4000-8000-000000000001'),'omitted metadata preserves promotions and operational flags');
select is((select total_price_cents::text from public.product_quantity_prices where product_id='4c000000-0000-4000-8000-000000000001' and quantity=2),'1700','import preserves quantity-pricing rules');
select is(public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"id":"4c000000-0000-4000-8000-000000000001","code":"","basePriceCents":1600}]','update')#>>'{products,0,code}',
 '000123','UUID-based update with empty code preserves code');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"id":"4c000000-0000-4000-8000-000000000001","code":"Wrong","basePriceCents":1600}]','update')$$,
 '22023','IMPORT_PRODUCT_IDENTITY_CONFLICT','contradictory UUID and code are rejected');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"batchId":"bc000000-0000-4000-8000-000000000003","products":[{"name":"No identity","category":"Main","basePriceCents":1200}]}','update')$$,
 '22023','IMPORT_PRODUCT_NOT_FOUND','update-only without identity never creates products');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"code":"NEW-DUP","name":"One","category":"Main","basePriceCents":1},{"code":"new-dup","name":"Two","category":"Main","basePriceCents":2}]','upsert')$$,
 '22023','IMPORT_DUPLICATE_PRODUCT','case-insensitive duplicates are rejected before writes');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"batchId":"bc000000-0000-4000-8000-000000000004","products":[{"rowRef":"2","code":"ROLLBACK","name":"Rollback","category":"Main","basePriceCents":1200}],"optionGroups":[{"productRowRef":"2","groupCode":"G","name":"Impossible","required":true,"minSelect":1,"maxSelect":1}]}','upsert')$$,
 '22023','OPTION_GROUP_SELECTION_INVALID','unsatisfiable active groups roll back whole batch');
select is((select count(*)::integer from public.products where code='ROLLBACK'),0,'failed child validation rolls back product');
select is(public.get_catalog_import_result('2c000000-0000-4000-8000-000000000001','bc000000-0000-4000-8000-000000000004'),null::jsonb,'failed transaction leaves no committed result');
select lives_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"batchId":"bc000000-0000-4000-8000-000000000004","products":[{"code":"ROLLBACK","name":"Retry repaired","category":"Main","basePriceCents":1200}]}','upsert')$$,
 'failed attempt rolled back code claim and allows corrected retry');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"products":[{"code":"000123","basePriceCents":2000}],"optionGroups":[{"productCode":"000123","groupCode":"BAD-ZERO","name":"Zero","maxSelect":0}]}','upsert')$$,
 '22023','OPTION_GROUP_SELECTION_INVALID','maxSelect zero cannot break public catalog through import');
select is((select base_price_cents::text from public.products where code='000123' and restaurant_id='2c000000-0000-4000-8000-000000000001'),'1600','invalid group also rolls back parent price');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '{"products":[{"code":"000123","basePriceCents":2000}],"optionGroups":[{"productRowRef":"99","groupCode":"G","name":"Bad ref"}]}','upsert')$$,
 '22023','IMPORT_PRODUCT_REFERENCE_INVALID','unknown row reference is never matched by name');
select throws_ok($$select public.get_catalog_import_result('2c000000-0000-4000-8000-000000000002','bc000000-0000-4000-8000-000000000001')$$,
 '42501','CATALOG_IMPORT_FORBIDDEN','cross-tenant result lookup is denied before checking existence');
select throws_ok($$insert into public.products(restaurant_id,category_id,code,name,base_price_cents)
 values('2c000000-0000-4000-8000-000000000002','3c000000-0000-4000-8000-000000000002','000123','Forbidden',100)$$,
 '42501','CATALOG_MANAGEMENT_FORBIDDEN','direct cross-tenant insert cannot probe private code claims');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 '[{"code":"bad\ncode","name":"Invalid code","category":"Main","basePriceCents":100}]','create')$$,
 '22023','PRODUCT_CODE_INVALID','control characters cannot be stored as codes');
select lives_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 jsonb_build_array(jsonb_build_object('code',repeat('A',80),'name','Eighty','category','Main','basePriceCents',100)),'create')$$,
 'compatible 80-character explicit codes are accepted');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',
 jsonb_build_array(jsonb_build_object('code',repeat('A',81),'name','Too long','category','Main','basePriceCents',100)),'create')$$,
 '22023','PRODUCT_CODE_INVALID','81-character codes are rejected');
select set_config('request.jwt.claim.sub','1c000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"1c000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
select is(public.import_products_batch('2c000000-0000-4000-8000-000000000002',
 '[{"code":"000123","name":"Independent code","category":"Main","basePriceCents":100}]','create')#>>'{products,0,code}',
 '000123','same code in another tenant is independent');
select set_config('request.jwt.claim.sub','1c000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1c000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
reset role;
update public.profiles set active=false where id='1c000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select public.get_catalog_import_result('2c000000-0000-4000-8000-000000000001','bc000000-0000-4000-8000-000000000001')$$,
 '42501','CATALOG_IMPORT_FORBIDDEN','suspended profile cannot recover prior result');
select throws_ok($$select public.import_products_batch('2c000000-0000-4000-8000-000000000001',(select payload from sku_payload),'upsert')$$,
 '42501','CATALOG_IMPORT_FORBIDDEN','suspended profile cannot replay prior batch');
reset role;
select * from finish();
rollback;
