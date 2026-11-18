begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select no_plan();
create function pg_temp.preview_id(n integer) returns uuid language sql immutable as $$
  select ('29170000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
grant execute on function pg_temp.preview_id(integer) to anon;
insert into restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,public_menu_enabled)
values (pg_temp.preview_id(1),'Preview Shop','Preview Shop','preview-shop','active','+5491111111111','PRE',true,true),
       (pg_temp.preview_id(2),'Other Shop','Other Shop','preview-other','active','+5491111111111','OTH',true,false);
insert into categories(id,restaurant_id,name,slug) values
  (pg_temp.preview_id(3),pg_temp.preview_id(1),'Category','category'),
  (pg_temp.preview_id(4),pg_temp.preview_id(2),'Other','other');
insert into product_families(id,restaurant_id,category_id,code,name,description,axes)
values(pg_temp.preview_id(5),pg_temp.preview_id(1),pg_temp.preview_id(3),'FAM','Family title','Family description',array['Color']);
insert into products(id,restaurant_id,category_id,code,name,description,base_price_cents,family_id,variant_attributes)
values(pg_temp.preview_id(6),pg_temp.preview_id(1),pg_temp.preview_id(3),'VAR','Variant title','Variant description',100,pg_temp.preview_id(5),'{"Color":"Red"}'),
      (pg_temp.preview_id(7),pg_temp.preview_id(2),pg_temp.preview_id(4),'OTHER','Private to this tenant','Other',100,null,'{}'),
      (pg_temp.preview_id(8),pg_temp.preview_id(1),pg_temp.preview_id(3),'SINGLE','Single title','Single description',100,null,'{}');
set local role anon;
select is(public.get_public_catalog_preview('preview-shop')->'restaurant'->>'tradeName','Preview Shop','anon can read published commerce metadata');
select is(public.get_public_catalog_preview('preview-other','menu'),null::jsonb,'hidden channel does not leak metadata');
select is(public.get_public_catalog_preview('preview-shop','invalid'),null::jsonb,'unknown channel is rejected');
select is(public.get_public_catalog_preview('preview-shop','menu',pg_temp.preview_id(6)),null::jsonb,'product previews are store only');
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(7)),null::jsonb,'foreign tenant product has no projection');
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(5))->'product'->>'name','Family title','family ID selects family metadata');
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(6))->'product'->>'name','Family title','variant ID preserves existing family presentation');
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(8))->'product'->>'name','Single title','standalone product retains its own presentation');
select ok(not(public.get_public_catalog_preview('preview-shop','store') ? 'categories'),'preview does not contain the catalogue');
select is((select count(*)::integer from jsonb_object_keys(public.get_public_catalog_preview('preview-shop')->'restaurant')),5,'public projection contains only five approved restaurant fields');
reset role;
update products set active=false where id=pg_temp.preview_id(8);
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(8)),null::jsonb,'inactive product is hidden');
update product_families set active=false where id=pg_temp.preview_id(5);
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(6)),null::jsonb,'inactive family is hidden');
update product_families set active=true where id=pg_temp.preview_id(5);
update categories set active=false where id=pg_temp.preview_id(3);
select is(public.get_public_catalog_preview('preview-shop','store',pg_temp.preview_id(6)),null::jsonb,'inactive category is hidden');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update restaurants set status='suspended' where id=pg_temp.preview_id(1);
select is(public.get_public_catalog_preview('preview-shop','store'),null::jsonb,'suspended commerce is hidden');
select ok(not exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='public.get_public_catalog_preview(text,text,uuid)'::regprocedure and a.grantee=0),'PUBLIC has no implicit EXECUTE');
select * from finish();
rollback;
