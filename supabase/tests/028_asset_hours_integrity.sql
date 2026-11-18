begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
-- Emulate the Storage server's SQL permission probe; no object bytes exist here.
set local storage.allow_delete_query='true';
select no_plan();
select is(private.image_asset_primary_path('x-320.webp'),'x-1200.webp','legacy derivative belongs to primary');
select is(private.image_asset_primary_path('x-w900-640.webp'),'x-w900-900.webp','bounded derivative belongs to primary');
select is(private.image_asset_primary_path('x-w900-899.webp'),'x-w900-899.webp','unknown size is independent');
select ok(not has_function_privilege('anon','public.prepare_image_asset_cleanup(uuid,text)','execute'),'anonymous cannot prepare deletion');
select ok(has_function_privilege('authenticated','public.prepare_image_asset_cleanup(uuid,text)','execute'),'authenticated preparation retains tenant authorization');
INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data)
VALUES('1a170000-0000-4000-8000-000000000001','audit-db-probe@example.test',now(),'{}');
INSERT INTO public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled,created_by)
VALUES('2a170000-0000-4000-8000-000000000001','Audit Fixture','Audit Fixture','audit-db-probe','active','+5491111111111','AUD',true,'1a170000-0000-4000-8000-000000000001');
INSERT INTO public.restaurant_members(restaurant_id,user_id,role,status)
VALUES('2a170000-0000-4000-8000-000000000001','1a170000-0000-4000-8000-000000000001','restaurant_admin','active');
INSERT INTO public.categories(id,restaurant_id,name,slug)
VALUES('3a170000-0000-4000-8000-000000000001','2a170000-0000-4000-8000-000000000001','Fixture','fixture');
INSERT INTO public.product_families(id,restaurant_id,category_id,code,name,axes,image_path)
VALUES('5a170000-0000-4000-8000-000000000001','2a170000-0000-4000-8000-000000000001','3a170000-0000-4000-8000-000000000001','FAMILY','Family',ARRAY['Color'],'restaurants/2a170000-0000-4000-8000-000000000001/products/family-only.webp');
INSERT INTO public.products(id,restaurant_id,category_id,code,name,base_price_cents,image_path,family_id,variant_attributes)
VALUES('4a170000-0000-4000-8000-000000000001','2a170000-0000-4000-8000-000000000001','3a170000-0000-4000-8000-000000000001','PRODUCT','Product',100,'restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-1200.webp','5a170000-0000-4000-8000-000000000001','{"Color":"Blue"}');
INSERT INTO public.image_assets(restaurant_id,entity_type,entity_id,path,mime_type,size_bytes,width,height,created_by)
SELECT '2a170000-0000-4000-8000-000000000001','product','4a170000-0000-4000-8000-000000000001',
       'restaurants/2a170000-0000-4000-8000-000000000001/products/'||filename,
       'image/webp',100,100,100,'1a170000-0000-4000-8000-000000000001'
FROM unnest(ARRAY['responsive-320.webp','responsive-640.webp','responsive-1200.webp','family-only.webp']) filename;
INSERT INTO storage.objects(bucket_id,name,owner_id,metadata)
SELECT 'restaurant-assets',path,'1a170000-0000-4000-8000-000000000001','{"mimetype":"image/webp"}'::jsonb
FROM public.image_assets WHERE restaurant_id='2a170000-0000-4000-8000-000000000001';
DO $$ BEGIN
  PERFORM set_config('request.jwt.claim.sub','1a170000-0000-4000-8000-000000000001',true);
  PERFORM set_config('request.jwt.claims','{"sub":"1a170000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
END $$;
SET LOCAL ROLE authenticated;

select is((select count(*)::integer from public.list_orphan_image_assets('2a170000-0000-4000-8000-000000000001')),0,'responsive children and family reference are not orphaned');
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-320.webp')->>'retained','true','preparing derivative retains complete referenced upload');
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/family-only.webp')->>'retained','true','family-only reference retains file');
update public.restaurants set logo_path='restaurants/2a170000-0000-4000-8000-000000000001/logo/live.webp',
  cover_path='restaurants/2a170000-0000-4000-8000-000000000001/cover/live.webp'
where id='2a170000-0000-4000-8000-000000000001';
update public.categories set image_path='restaurants/2a170000-0000-4000-8000-000000000001/categories/live.webp'
where id='3a170000-0000-4000-8000-000000000001';
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/logo/live.webp')->>'retained','true','logo reference retains file');
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/cover/live.webp')->>'retained','true','cover reference retains file');
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/categories/live.webp')->>'retained','true','category reference retains file');
with moved as(update storage.objects set name='restaurants/2a170000-0000-4000-8000-000000000001/products/moved.webp' where name like '%/family-only.webp' returning name)
select is((select count(*)::integer from moved),0,'Storage move cannot bypass live reference protection');
with removed as(delete from storage.objects where bucket_id='restaurant-assets' and name like '%/family-only.webp' returning name) select is((select count(*)::integer from removed),0,'legacy raw delete cannot erase shared family file');
with changed as(update public.image_assets set deleted_at=now() where path like '%/family-only.webp' returning id) select is((select count(*)::integer from changed),0,'legacy cleanup cannot falsely mark referenced metadata deleted');
select throws_ok($$select public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000002','restaurants/2a170000-0000-4000-8000-000000000002/products/file.webp')$$,'42501','ASSET_CLEANUP_FORBIDDEN','cleanup cannot cross tenants');
select throws_ok($$select public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000002/products/file.webp')$$,'22023','ASSET_PATH_INVALID','foreign path cannot be prepared');
update public.products set image_path=null where id='4a170000-0000-4000-8000-000000000001';
select is((public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-1200.webp')->>'retained')::boolean,false,'detached upload can be prepared');
select is(jsonb_array_length(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-640.webp')->'paths'),3,'preparation is idempotent and includes every responsive file');
select is((select count(*)::integer from public.image_assets where path like '%/responsive-%' and deleted_at is not null),3,'registry stays pending until Storage removal');
select throws_ok($$update public.products set image_path='restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-320.webp' where id='4a170000-0000-4000-8000-000000000001'$$,'22023','IMAGE_ASSET_RETIRED','late derivative reference cannot race durable deletion');
with removed as(delete from storage.objects where bucket_id='restaurant-assets' and name like '%/responsive-%' returning name) select is((select count(*)::integer from removed),3,'prepared objects pass the existing tenant Storage DELETE route');
select is(jsonb_array_length(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-1200.webp')->'paths'),0,'retry after completed delete is safe');
select throws_ok($$update public.restaurants set logo_path='restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-1200.webp' where id='2a170000-0000-4000-8000-000000000001'$$,'22023','IMAGE_ASSET_RETIRED','restaurant references obey retirement');
select throws_ok($$update public.categories set image_path='restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-1200.webp' where id='3a170000-0000-4000-8000-000000000001'$$,'22023','IMAGE_ASSET_RETIRED','category references obey retirement');
insert into storage.objects(bucket_id,name,metadata) values('restaurant-assets','restaurants/2a170000-0000-4000-8000-000000000001/products/partial-w900-320.webp','{"mimetype":"image/webp"}');
select is(jsonb_array_length(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/partial-w900-320.webp')->'paths'),1,'failed partial upload needs no registry row to prepare cleanup');
with removed as(delete from storage.objects where name like '%/partial-w900-320.webp' returning name) select is((select count(*)::integer from removed),1,'partial upload is removable only after preparation');
select throws_ok($$insert into public.special_hours(restaurant_id,date,slot_index,is_closed,opens_at,closes_at) values('2a170000-0000-4000-8000-000000000001','2099-01-01',0,true,null,null),('2a170000-0000-4000-8000-000000000001','2099-01-01',1,false,'09:00','18:00'); set constraints special_hours_closed_date_exclusive immediate;$$,'23P01',null,'direct authenticated writes cannot mix closure and opening');
select is((select count(*)::integer from public.special_hours where restaurant_id='2a170000-0000-4000-8000-000000000001'),0,'failed mixed schedule rolls back completely');
select lives_ok($$insert into public.special_hours(restaurant_id,date,slot_index,is_closed,opens_at,closes_at) values('2a170000-0000-4000-8000-000000000001','2099-01-02',0,false,'09:00','12:00'),('2a170000-0000-4000-8000-000000000001','2099-01-02',1,false,'14:00','18:00'); set constraints special_hours_closed_date_exclusive immediate;$$,'separate open slots remain compatible');
set constraints special_hours_closed_date_exclusive deferred;
select lives_ok($$insert into public.special_hours(restaurant_id,date,slot_index,is_closed) values('2a170000-0000-4000-8000-000000000001','2099-01-03',0,true); set constraints special_hours_closed_date_exclusive immediate;$$,'single full-day closure remains compatible');
reset role;
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,logo_path)
values('2a170000-0000-4000-8000-000000000002','Legacy public image','Legacy','audit-image-cross-reference','draft','+5491111111112','LGC',
  'restaurants/2a170000-0000-4000-8000-000000000001/products/legacy-shared.webp');
set local role authenticated;
select is(public.prepare_image_asset_cleanup('2a170000-0000-4000-8000-000000000001','restaurants/2a170000-0000-4000-8000-000000000001/products/legacy-shared.webp')->>'retained','true','existing cross-tenant public-image reference is conservatively preserved');
reset role;
select lives_ok($$update public.product_families set name='Renamed family' where id='5a170000-0000-4000-8000-000000000001'$$,'unrelated family edit preserves historical references');
select throws_ok($$update public.product_families set image_path='restaurants/2a170000-0000-4000-8000-000000000001/products/responsive-640.webp' where id='5a170000-0000-4000-8000-000000000001'$$,'22023','IMAGE_ASSET_RETIRED','owner-executed family RPC cannot attach retired image');
select * from finish();
rollback;
