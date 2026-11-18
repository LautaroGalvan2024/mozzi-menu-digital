-- Audit evidence only. Executed against isolated mozzi_audit_20261117.
-- Requires synthetic local managed schemas, not a hosted Supabase project.
-- Every fixture is rolled back. Never use this file to change production.
BEGIN;
SET LOCAL statement_timeout='20s';
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
SELECT jsonb_build_object('probe','false_orphans','role',current_user,
  'results',jsonb_agg(jsonb_build_object('file',regexp_replace(path,'^.*/',''),'issue',issue) ORDER BY path))
FROM public.list_orphan_image_assets('2a170000-0000-4000-8000-000000000001');
INSERT INTO public.special_hours(restaurant_id,date,slot_index,is_closed,opens_at,closes_at)
VALUES('2a170000-0000-4000-8000-000000000001','2099-01-01',0,true,null,null),
      ('2a170000-0000-4000-8000-000000000001','2099-01-01',1,false,'09:00','18:00');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('probe','direct_special_hours','role',current_user,'rows',count(*),
  'closed_rows',count(*) FILTER(WHERE is_closed),'open_rows',count(*) FILTER(WHERE NOT is_closed))
FROM public.special_hours
WHERE restaurant_id='2a170000-0000-4000-8000-000000000001' AND date='2099-01-01';
ROLLBACK;
SELECT jsonb_build_object('probe','rollback_clean','users',count(*))
FROM auth.users WHERE id='1a170000-0000-4000-8000-000000000001';
