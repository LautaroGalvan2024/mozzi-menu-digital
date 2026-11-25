begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.oid_for(n integer) returns uuid language sql immutable as $$
  select ('34340000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.keys(variadic numbers integer[]) returns uuid[] language sql immutable as $$
  select array(select pg_temp.oid_for(n) from unnest(numbers) with ordinality t(n,i) order by i)
$$;
create function pg_temp.ids(doc jsonb) returns uuid[] language sql immutable as $$
  select array(select (item->>'id')::uuid from jsonb_array_elements(doc->'items') with ordinality t(item,i) order by i)
$$;
grant execute on function pg_temp.oid_for(integer), pg_temp.keys(integer[]), pg_temp.ids(jsonb) to authenticated;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
  (pg_temp.oid_for(1),'offers-admin@example.test',now(),'{}'),
  (pg_temp.oid_for(2),'offers-manager@example.test',now(),'{}');
insert into restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,public_menu_enabled) values
  (pg_temp.oid_for(10),'Offers','Offers','offer-order-a','active','+5491111111111','OFA',true,true),
  (pg_temp.oid_for(11),'Other store','Other store','offer-order-b','active','+5491111111111','OFB',true,true),
  (pg_temp.oid_for(12),'Menu only','Menu only','offer-order-menu','active','+5491111111111','OFM',false,true),
  (pg_temp.oid_for(13),'No offers','No offers','offer-order-empty','draft','+5491111111111','OFE',true,false);
insert into restaurant_members(restaurant_id,user_id,role,status) values
  (pg_temp.oid_for(10),pg_temp.oid_for(1),'restaurant_admin','active'),
  (pg_temp.oid_for(12),pg_temp.oid_for(1),'restaurant_admin','active'),
  (pg_temp.oid_for(13),pg_temp.oid_for(1),'restaurant_admin','active'),
  (pg_temp.oid_for(10),pg_temp.oid_for(2),'order_manager','active');
insert into categories(id,restaurant_id,name,slug,sort_order) values
  (pg_temp.oid_for(20),pg_temp.oid_for(10),'A','first',0),
  (pg_temp.oid_for(21),pg_temp.oid_for(10),'B','second',1),
  (pg_temp.oid_for(22),pg_temp.oid_for(11),'Other','other',0);
insert into products(id,restaurant_id,category_id,code,name,base_price_cents,promotional_price_cents,sort_order,featured)
select pg_temp.oid_for(n),pg_temp.oid_for(10),pg_temp.oid_for(case when n < 110 then 20 else 21 end),
  'SKU-'||n,'Item '||n,2000,case when n <= 110 then 1500 end,n,true
from generate_series(101,111) n;
insert into products(id,restaurant_id,category_id,code,name,base_price_cents,promotional_price_cents)
values(pg_temp.oid_for(112),pg_temp.oid_for(11),pg_temp.oid_for(22),'OTHER','Other-store offer',2500,1700);
insert into product_families(id,restaurant_id,category_id,code,name,axes)
values(pg_temp.oid_for(130),pg_temp.oid_for(10),pg_temp.oid_for(21),'F','Fixture family',array['Color']);
insert into products(id,restaurant_id,category_id,family_id,variant_attributes,code,name,base_price_cents,
  promotional_price_cents,quantity_threshold_minimum,quantity_threshold_unit_price_cents,available,sort_order)
values
  (pg_temp.oid_for(131),pg_temp.oid_for(10),pg_temp.oid_for(21),pg_temp.oid_for(130),'{"Color":"Red"}','RED','Red',2000,100,null,null,false,200),
  (pg_temp.oid_for(132),pg_temp.oid_for(10),pg_temp.oid_for(21),pg_temp.oid_for(130),'{"Color":"Blue"}','BLUE','Blue',1600,null,3,900,true,201);

update product_families set image_path='restaurants/'||restaurant_id||'/family.webp' where id=pg_temp.oid_for(130);
update products set image_path='restaurants/'||restaurant_id||'/blue.webp' where id=pg_temp.oid_for(132);
select ok(not has_table_privilege('authenticated','private.store_offer_positions','INSERT, UPDATE, DELETE'),'direct writes are denied');
select ok(not has_table_privilege('anon','private.store_offer_positions','SELECT'),'anonymous has no direct access to merchant settings');
select set_config('request.jwt.claim.sub',pg_temp.oid_for(1)::text,true);
set local role authenticated;

select is(get_store_offer_order(pg_temp.oid_for(13))->'items','[]'::jsonb,'merchant can prepare an enabled draft store with an empty editor');
select is(get_public_store_catalog_page('offer-order-empty','offers'),null::jsonb,'draft stores remain unpublished');
select is(pg_temp.ids(get_public_store_catalog_page('offer-order-b','offers')),pg_temp.keys(112),'another store starts with one offer');
select throws_ok($$select get_store_offer_order(pg_temp.oid_for(11))$$,'42501','STORE_OFFER_ORDER_FORBIDDEN','cannot read another store editor');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(11),'',pg_temp.keys(112))$$,'42501','STORE_OFFER_ORDER_FORBIDDEN','cannot write another store order');
select throws_ok($$select get_store_offer_order(pg_temp.oid_for(12))$$,'42501','STORE_OFFER_ORDER_FORBIDDEN','menu-only commerce has no store editor');

create temp table offer_baseline as select
  get_store_offer_order(pg_temp.oid_for(10)) as editor,
  get_public_store_catalog_page('offer-order-a','offers',null,null,null,8) as first_page,
  get_public_store_catalog_page('offer-order-a','all')->'items' as catalog,
  get_public_store_catalog_page('offer-order-a','featured')->'items' as featured,
  get_public_store_catalog_page('offer-order-a','offers',pg_temp.oid_for(20))->'items' as category,
  get_public_store_catalog_page('offer-order-a','offers',null,'Item')->'items' as search,
  get_public_catalog_page('offer-order-a','menu')->'items' as menu;
select is(pg_temp.ids(editor),pg_temp.keys(101,102,103,104,105,106,107,108,109,110,130),'legacy ordering uses category, featured and item sort for unsaved stores') from offer_baseline;
select is(editor#>>'{items,10,name}','Fixture family','variants occupy one named public card') from offer_baseline;
select is(editor#>>'{items,10,price}','1600','editor shows the purchasable qualifying variant price for a quantity offer') from offer_baseline;
select is(editor#>'{items,0,image_path}','null'::jsonb,'missing image uses the normal placeholder') from offer_baseline;
select is(editor#>>'{items,10,image_path}','restaurants/'||pg_temp.oid_for(10)||'/family.webp','editor uses the storefront family photo before the variant photo') from offer_baseline;

select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(101,102,103,104,105,106,107,108,109,110,110))$$,'22023','STORE_OFFER_ORDER_INVALID','duplicate replaces a required group');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(101,102,103,104,105,106,107,108,109,110,112))$$,'22023','STORE_OFFER_ORDER_INVALID','foreign products cannot receive a position');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(101,102,103,104,105,106,107,108,109,110,111))$$,'22023','STORE_OFFER_ORDER_INVALID','non-offer product rejected');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(101,102,103,104,105,106,107,108,109,110,999))$$,'22023','STORE_OFFER_ORDER_INVALID','nonexistent group rejected');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(101,102,103,104,105,106,107,108,109,110))$$,'22023','STORE_OFFER_ORDER_INVALID','incomplete list rejected');
select is(get_store_offer_order(pg_temp.oid_for(10)),editor,'rejected writes do not partially change the order') from offer_baseline;

select save_store_offer_order(pg_temp.oid_for(10),editor->>'revision',pg_temp.keys(130,110,109,108,107,106,105,104,103,102,101)) from offer_baseline;
select is(pg_temp.ids(get_store_offer_order(pg_temp.oid_for(10))),pg_temp.keys(130,110,109,108,107,106,105,104,103,102,101),'a fresh merchant read sees the saved order');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(102,101,103,104,105,106,107,108,109,110,130))$$,'PT409','STORE_OFFER_ORDER_STALE','a second editor cannot overwrite the saved order using a stale version');
select lives_ok($$select save_store_offer_order(pg_temp.oid_for(10),(select editor->>'revision' from offer_baseline),
  pg_temp.keys(130,110,109,108,107,106,105,104,103,102,101))$$,'lost successful reply can retry the exact same order');
select throws_ok($$select get_public_store_catalog_page('offer-order-a','offers',null,null,(select first_page->'nextCursor' from offer_baseline),8)$$,
  '22023','CATALOG_CURSOR_STALE','saving invalidates an old storefront cursor');
create temp table ordered_page as select get_public_store_catalog_page('offer-order-a','offers',null,null,null,8) as doc;
select is(pg_temp.ids(doc),pg_temp.keys(130,110,109,108,107,106,105,104),'previously off-page offers can appear first') from ordered_page;
select is(pg_temp.ids(get_public_store_catalog_page('offer-order-a','offers',null,null,doc->'nextCursor',8)),pg_temp.keys(103,102,101),'continuation never skips or repeats a saved group') from ordered_page;
select is(get_public_store_catalog_page('offer-order-a','all')->'items',catalog,'catalog order and product payload stay intact') from offer_baseline;
select is(get_public_store_catalog_page('offer-order-a','featured')->'items',featured,'featured shelves stay intact') from offer_baseline;
select is(get_public_store_catalog_page('offer-order-a','offers',pg_temp.oid_for(20))->'items',category,'category-filtered results retain their order') from offer_baseline;
select is(get_public_store_catalog_page('offer-order-a','offers',null,'Item')->'items',search,'search results retain their order') from offer_baseline;
select is(get_public_catalog_page('offer-order-a','menu')->'items',menu,'restaurant menu remains intact') from offer_baseline;
select is(pg_temp.ids(get_public_store_catalog_page('offer-order-b','offers')),pg_temp.keys(112),'another store retains its order');

reset role;
update products set promotional_price_cents=1400 where id=pg_temp.oid_for(111);
update products set promotion_ends_at=now()-interval '1 minute' where id=pg_temp.oid_for(110);
select is(pg_temp.ids(get_public_store_catalog_page('offer-order-a','offers')),pg_temp.keys(130,109,108,107,106,105,104,103,102,101,111),'expired offer disappears and a new one appends');
update products set promotion_ends_at=null where id=pg_temp.oid_for(110);
select is(get_public_store_catalog_page('offer-order-a','offers')#>>'{items,1,id}',pg_temp.oid_for(110)::text,'a returning offer keeps its position until another save omits it');
update products set available=false where id=pg_temp.oid_for(110);
set local role authenticated;
select save_store_offer_order(pg_temp.oid_for(10),get_store_offer_order(pg_temp.oid_for(10))->>'revision',pg_temp.keys(109,130,108,107,106,105,104,103,102,101,111));
reset role;
update products set available=true where id=pg_temp.oid_for(110);
select is(get_public_store_catalog_page('offer-order-a','offers')#>>'{items,11,id}',pg_temp.oid_for(110)::text,'returning offer appends when a save occurred during its absence');
update products set deleted_at=now() where id=pg_temp.oid_for(108);
delete from products where id=pg_temp.oid_for(107);
select is(pg_temp.ids(get_public_store_catalog_page('offer-order-a','offers')),pg_temp.keys(109,130,106,105,104,103,102,101,111,110),'soft and physical deletes keep the remaining order');
select ok(not exists(select 1 from private.store_offer_positions where group_id=pg_temp.oid_for(107)),'hard delete cleans up the saved rank');
select set_config('request.jwt.claim.sub',pg_temp.oid_for(2)::text,true);
set local role authenticated;
select throws_ok($$select get_store_offer_order(pg_temp.oid_for(10))$$,'42501','STORE_OFFER_ORDER_FORBIDDEN','order managers lack catalog permission');
select throws_ok($$select save_store_offer_order(pg_temp.oid_for(10),'',array[]::uuid[])$$,'42501','STORE_OFFER_ORDER_FORBIDDEN','order managers cannot save');

select * from finish();
rollback;
