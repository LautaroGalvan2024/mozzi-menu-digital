begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('1f000000-0000-4000-8000-000000000001','catalog-boundary@example.test',now(),'{"full_name":"Synthetic catalogue admin"}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by) values
 ('2f000000-0000-4000-8000-000000000001','Catalogue boundary','Synthetic','catalog-boundary','active','+5491111111111','Synthetic','Synthetic','CBT',true,'1f000000-0000-4000-8000-000000000001');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values
 ('2f000000-0000-4000-8000-000000000001','1f000000-0000-4000-8000-000000000001','restaurant_admin','active','1f000000-0000-4000-8000-000000000001');
insert into public.categories(id,restaurant_id,name,slug) values
 ('3f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','Main','main');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents) values
 ('4f000000-0000-4000-8000-000000000001','2f000000-0000-4000-8000-000000000001','3f000000-0000-4000-8000-000000000001','ORIGINAL','Original',1000);

select ok(not has_table_privilege('authenticated','public.products','update'),'no blanket product UPDATE grant overrides column restrictions');
select ok(not has_column_privilege('authenticated','public.products','code','update'),'direct product code update denied');
select ok(has_column_privilege('authenticated','public.products','image_path','update'),'image association remains permitted subject to RLS');
select ok(has_column_privilege('authenticated','public.products','available','update') and has_column_privilege('authenticated','public.products','deleted_at','update'),'operational flags and archive updates remain permitted');
select ok(not has_table_privilege('authenticated','public.product_option_groups','insert') and not has_table_privilege('authenticated','public.product_option_groups','update'),'group mutations require an atomic catalogue RPC');
select ok(not has_table_privilege('authenticated','public.product_options','insert') and not has_table_privilege('authenticated','public.product_options','update'),'option mutations require an atomic catalogue RPC');
select set_config('request.jwt.claim.sub','1f000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1f000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$update public.products set code='DIRECT' where false$$,'42501','permission denied for table products','code ACL rejects before selecting or locking rows');
select throws_ok($$update public.products set code='DIRECT' where id='4f000000-0000-4000-8000-000000000001'$$,'42501','permission denied for table products','tenant admin cannot bypass code RPC');
select throws_ok($$update public.products set id='4f000000-0000-4000-8000-000000000002' where id='4f000000-0000-4000-8000-000000000001'$$,'42501','permission denied for table products','stable product UUID cannot be mutated directly');
select throws_ok($$update public.products set restaurant_id='2f000000-0000-4000-8000-000000000002' where false$$,'42501','permission denied for table products','tenant mutation denied before row selection');
select ok(not has_column_privilege('authenticated','public.products','created_by','update') and not has_column_privilege('authenticated','public.products','created_at','update'),'original authorship cannot be overwritten directly');
select lives_ok($$update public.products set available=false,featured=true,image_path=null,name='Direct metadata' where id='4f000000-0000-4000-8000-000000000001'$$,'non-code update stays compatible with the existing browser');
select throws_ok($$insert into public.product_option_groups(restaurant_id,product_id,name,min_select,max_select) values('2f000000-0000-4000-8000-000000000001','4f000000-0000-4000-8000-000000000001','Bypass',0,0)$$,'42501','permission denied for table product_option_groups','direct invalid group cannot bypass final validation');
select throws_ok($$update public.product_options set active=false where false$$,'42501','permission denied for table product_options','direct option deactivation cannot race graph validation');

select is(public.save_product_catalog('2f000000-0000-4000-8000-000000000001',
 '{"id":"4f000000-0000-4000-8000-000000000001","categoryId":"3f000000-0000-4000-8000-000000000001","code":"00042","name":"RPC edited","basePriceCents":1000}', '[]')->>'code',
 '00042','authorized code edit uses the RPC and preserves text');
select is((select id::text from public.products where code='00042'),'4f000000-0000-4000-8000-000000000001','code edit keeps the same UUID');
select throws_ok($$select public.save_product_catalog('2f000000-0000-4000-8000-000000000001',
 '{"id":"4f000000-0000-4000-8000-000000000001","categoryId":"3f000000-0000-4000-8000-000000000001","name":"Must rollback","basePriceCents":9000}',
 '[{"id":"5f000000-0000-4000-8000-000000000001","name":"Zero","minSelect":0,"maxSelect":0,"active":true,"options":[]}]')$$,
 '22023','OPTION_GROUP_SELECTION_INVALID','manual RPC rejects active max zero');
select throws_ok($$select public.save_product_catalog('2f000000-0000-4000-8000-000000000001',
 '{"id":"4f000000-0000-4000-8000-000000000001","categoryId":"3f000000-0000-4000-8000-000000000001","name":"Must rollback","basePriceCents":9000}',
 '[{"id":"5f000000-0000-4000-8000-000000000001","name":"Impossible","required":true,"minSelect":2,"maxSelect":2,"options":[{"id":"6f000000-0000-4000-8000-000000000001","name":"One","priceDeltaCents":0,"active":true},{"id":"6f000000-0000-4000-8000-000000000002","name":"Inactive","priceDeltaCents":0,"active":false}]}]')$$,
 '22023','OPTION_GROUP_SELECTION_INVALID','manual RPC counts only active options');
select is((select name from public.products where id='4f000000-0000-4000-8000-000000000001'),'RPC edited','invalid groups roll back the product write');
select is((select count(*)::integer from public.product_option_groups where product_id='4f000000-0000-4000-8000-000000000001'),0,'invalid groups leave no partial children');

select lives_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001',
 '{"products":[{"code":"00042","basePriceCents":1000}],"optionGroups":[{"productCode":"00042","groupCode":"G","name":"Required","required":true,"minSelect":2,"maxSelect":2}],"options":[{"productCode":"00042","groupCode":"G","optionCode":"A","name":"One","priceDeltaCents":0,"active":true},{"productCode":"00042","groupCode":"G","optionCode":"B","name":"Two","active":true}]}','upsert')$$,
 'import atomically creates a satisfiable required group');
select lives_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001',
 '{"products":[{"code":"00042","basePriceCents":1200}],"optionGroups":[{"productCode":"00042","groupCode":"G","name":"Required patched","required":true,"minSelect":2,"maxSelect":2}]}','upsert')$$,
 'partial import preserves existing active options omitted from the batch');
select throws_ok($$select public.import_products_batch('2f000000-0000-4000-8000-000000000001',
 '{"products":[{"code":"00042","basePriceCents":9000}],"options":[{"productCode":"00042","groupCode":"G","optionCode":"B","name":"Two","active":false}]}','upsert')$$,
 '22023','OPTION_GROUP_SELECTION_INVALID','import cannot disable an option required by the final group');
select is((select base_price_cents::text from public.products where code='00042'),'1200','failed option patch also rolls back prices');
select is((select count(*)::integer from public.product_options o join public.product_option_groups g on g.id=o.option_group_id where g.code='G' and g.product_id='4f000000-0000-4000-8000-000000000001' and o.active),2,'failed option patch keeps the active options');
reset role;
select ok(exists(select 1 from pg_constraint where conname='product_option_groups_active_max_positive' and convalidated),'new active maximum constraint is validated');
select * from finish();
rollback;
