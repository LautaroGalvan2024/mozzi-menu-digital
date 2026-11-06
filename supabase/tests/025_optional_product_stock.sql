begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create function pg_temp.optional_id(p_number integer) returns uuid language sql immutable as $$
  select ('25250000-0000-4000-8000-'||lpad(p_number::text,12,'0'))::uuid
$$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
values(pg_temp.optional_id(1),'optional-stock@example.test',now(),'{}');
insert into restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,public_menu_enabled)
values(pg_temp.optional_id(2),'Optional stock','Optional stock','optional-stock','active','+5491111111111','OPT',true,true),
      (pg_temp.optional_id(22),'No quantities','No quantities','optional-empty','active','+5491111111111','EMP',true,true);
insert into restaurant_members(restaurant_id,user_id,role,status)
select pg_temp.optional_id(t),pg_temp.optional_id(1),'restaurant_admin','active' from unnest(array[2,22]) t;
insert into categories(id,restaurant_id,name,slug)
values(pg_temp.optional_id(3),pg_temp.optional_id(2),'Optional products','optional'),
      (pg_temp.optional_id(23),pg_temp.optional_id(22),'No quantities','empty');
insert into products(id,restaurant_id,category_id,code,name,base_price_cents,available)
select pg_temp.optional_id(n),pg_temp.optional_id(2),pg_temp.optional_id(3),'OPT-'||n,'Optional '||n,100,n<>13
from generate_series(10,17) n;
insert into products(id,restaurant_id,category_id,code,name,base_price_cents)
values(pg_temp.optional_id(24),pg_temp.optional_id(22),pg_temp.optional_id(23),'EMPTY','No quantity',100);
insert into payment_methods(id,restaurant_id,code,name)
values(pg_temp.optional_id(4),pg_temp.optional_id(2),'cash','Cash');
insert into business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
select pg_temp.optional_id(2),d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
select set_config('request.jwt.claim.sub',pg_temp.optional_id(1)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.optional_id(1),'role','authenticated','aal','aal1')::text,true);

create temporary table optional_orders(label text primary key,id uuid,action_id uuid,attempt_id uuid);
create function pg_temp.optional_stock(p_product integer,p_quantity text) returns jsonb
language sql as $$
 select public.save_product_catalog_with_stock(pg_temp.optional_id(2),
   jsonb_build_object('id',pg_temp.optional_id(p_product),'categoryId',pg_temp.optional_id(3),'name','Optional '||p_product,'basePriceCents',100),
   '[]','{}','{}',extensions.gen_random_uuid(),jsonb_build_object('onHand',p_quantity,'expectedVersion',
     (select version::text from inventory_balances where product_id=pg_temp.optional_id(p_product))))
$$;
create function pg_temp.optional_order(p_label text,p_product integer,p_quantity integer default 1,p_second integer default null,p_online boolean default false)
returns uuid language plpgsql as $$
declare v_key uuid:=extensions.gen_random_uuid(); v_request jsonb; v_response jsonb; v_id uuid;
begin
  v_request:=jsonb_build_object('restaurantSlug','optional-stock','idempotencyKey',v_key,'channel','store',
    'customer',jsonb_build_object('name','Synthetic','phone','+5491111111111'),'fulfillment',jsonb_build_object('type','pickup'),
    'paymentMethodId',case when p_online then '00000000-0000-4000-8000-000000000000'::uuid else pg_temp.optional_id(4) end,
    'items',jsonb_build_array(jsonb_build_object('productId',pg_temp.optional_id(p_product),'quantity',p_quantity,'optionIds','[]'::jsonb)));
  if p_second is not null then
    v_request:=jsonb_set(v_request,'{items}',v_request->'items'||jsonb_build_array(jsonb_build_object('productId',pg_temp.optional_id(p_second),'quantity',1,'optionIds','[]'::jsonb)));
  end if;
  if p_online then
    v_response:=public.begin_online_checkout(v_request,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
      (public.get_payment_account(pg_temp.optional_id(2))->>'accountId')::uuid);
  else
    v_response:=public.create_order_transaction(v_request,repeat('a',64),repeat('b',64),repeat('c',64));
  end if;
  insert into optional_orders select p_label,id,action_id,(v_response->>'attemptId')::uuid from orders where idempotency_key=v_key returning id into v_id;
  return v_id;
end $$;
create function pg_temp.optional_accept(p_label text) returns jsonb language sql as $$
 select public.claim_order((select action_id from optional_orders where label=p_label))
$$;
create function pg_temp.optional_complete(p_label text) returns jsonb language sql as $$
 select public.complete_order((select id from optional_orders where label=p_label))
$$;
create function pg_temp.optional_payment(p_label text,p_status text,p_minutes integer default 0) returns jsonb language sql as $$
 select public.reconcile_online_payment(t.attempt_id,'optional-payment-'||p_label,p_status,o.total_cents,'ARS',now()+make_interval(mins=>p_minutes))
 from optional_orders t join orders o on o.id=t.id where t.label=p_label
$$;

select pg_temp.optional_stock(10,'2');
select pg_temp.optional_stock(12,'0');
select pg_temp.optional_order('before-activation',10,3);
select pg_temp.optional_accept('before-activation');
select ok(not (select stock_tracked from order_inventory_lines where order_id=(select id from optional_orders where label='before-activation')),
  'order before activation stays untracked even when a quantity was preloaded');
-- Simulate an accepted pre-migration order, created when never_enabled orders
-- did not receive inventory snapshots. No production fixture or DML is used.
alter table order_items disable trigger order_items_inventory_snapshot;
select pg_temp.optional_order('historical-no-snapshot',14,4);
alter table order_items enable trigger order_items_inventory_snapshot;
select pg_temp.optional_accept('historical-no-snapshot');
select is((select count(*) from order_inventory_lines where order_id=(select id from optional_orders where label='historical-no-snapshot')),0::bigint,
  'historical fixture has no inventory snapshots');
select is(public.activate_inventory_from_product_stock(pg_temp.optional_id(2),pg_temp.optional_id(90),0)->>'adoptedOrders','2',
  'activation accepts a catalog mixing counted and uncounted products');
select is((select count(*) from inventory_balances where restaurant_id=pg_temp.optional_id(2)),2::bigint,
  'activation never invents balances for products without quantities');
select ok(not exists(select 1 from order_inventory_lines where order_id in (select id from optional_orders) and stock_tracked),
  'activation preserves both explicit untracked snapshots and historical missing snapshots as untracked');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(10)),0::bigint,
  'accepted orders from before activation do not acquire retroactive reservations');
select lives_ok($$select pg_temp.optional_complete('before-activation')$$,'pre-activation order can be delivered despite its quantity exceeding current stock');
select lives_ok($$select pg_temp.optional_complete('historical-no-snapshot')$$,'historical order can be delivered without a balance');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(10)),2::bigint,
  'pre-activation delivery does not consume subsequently controlled stock');

select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(11))#>>'{group,variants,0,available}','true','store detail sells a product with no quantity');
select is(public.get_public_products_by_ids('optional-stock','menu',array[pg_temp.optional_id(11)])#>>'{products,0,available}','true','menu and cart projection also sell uncounted product');
select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(12))#>>'{group,variants,0,available}','false','explicit zero remains unavailable');
select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(13))#>>'{group,variants,0,available}','false','manual unavailable flag wins over missing quantity');
select throws_ok($$select pg_temp.optional_order('manual-unavailable',13)$$,'22023','PRODUCT_UNAVAILABLE','uncounted checkout still respects manual unavailable flag');
select is((select v->>'available' from jsonb_array_elements(public.get_public_catalog_page('optional-stock','store',null,'Optional 11',null,24)->'items') g
  cross join lateral jsonb_array_elements(g->'variants') v where v->>'id'=pg_temp.optional_id(11)::text),'true','paginated search uses the same availability rule');

select pg_temp.optional_stock(10,'8');
select pg_temp.optional_order('mixed',10,2,11);
select is((select count(*) from order_inventory_lines where order_id=(select id from optional_orders where label='mixed')),2::bigint,'mixed order snapshots every line');
select is((select count(*) from order_inventory_lines where order_id=(select id from optional_orders where label='mixed') and stock_tracked),1::bigint,'only counted line is controlled');
select is(pg_temp.optional_accept('mixed')->>'claimed','true','mixed order can be accepted');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(10)),2::bigint,'mixed order reserves only the counted quantity');
create temporary table optional_revision as select (public.get_public_catalog_revision('optional-stock','store')->>'revision')::bigint revision;
select pg_temp.optional_stock(11,'0');
select ok((public.get_public_catalog_revision('optional-stock','store')->>'revision')::bigint>(select revision from optional_revision),'first quantity invalidates cached catalog revision');
select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(11))#>>'{group,variants,0,available}','false','first explicit zero immediately changes future availability');
select lives_ok($$select pg_temp.optional_complete('mixed')$$,'loading zero after creation does not invalidate the untracked line');
select lives_ok($$select pg_temp.optional_complete('mixed')$$,'mixed delivery retry is idempotent');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(10)),6::bigint,'mixed delivery deducts counted units once');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(11)),0::bigint,'newly loaded balance is untouched by the older untracked sale');
select is((select count(*) from inventory_movements m join inventory_operations op on op.id=m.operation_id where op.order_id=(select id from optional_orders where label='mixed') and m.product_id=pg_temp.optional_id(11)),0::bigint,'untracked line has no physical or reserved ledger movements');
select lives_ok($$select public.reverse_order_inventory((select id from optional_orders where label='mixed'),pg_temp.optional_id(91),'return',true,'Total return with one sellable counted unit',
  jsonb_build_array(jsonb_build_object('productId',pg_temp.optional_id(10),'quantity',1)))$$,'mixed return lists and restocks only counted items');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(10)),7::bigint,'return restores only the explicit sellable counted unit');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(11)),0::bigint,'mixed return never invents stock for formerly untracked line');
select throws_ok($$update order_inventory_lines set stock_tracked=true where order_id=(select id from optional_orders where label='mixed') and not stock_tracked$$,
  '42501','APPEND_ONLY_RECORD','per-line policy cannot be rewritten after creation');
select pg_temp.optional_order('new-zero',11);
select throws_ok($$select pg_temp.optional_accept('new-zero')$$,'22023','INSUFFICIENT_STOCK','new orders after first zero stock must respect it');
select public.cancel_order((select id from optional_orders where label='new-zero'),'Close zero-stock fixture');
select pg_temp.optional_stock(11,'3');
select is(public.get_public_products_by_ids('optional-stock','store',array[pg_temp.optional_id(11)])#>>'{products,0,available}','true','positive stock makes future requests available again');

select pg_temp.optional_order('entirely-untracked',14,5);
select lives_ok($$select pg_temp.optional_accept('entirely-untracked')$$,'all-untracked order creates an empty reservation marker');
select lives_ok($$select pg_temp.optional_complete('entirely-untracked')$$,'all-untracked order creates an empty delivery marker');
select lives_ok($$select public.reverse_order_inventory((select id from optional_orders where label='entirely-untracked'),pg_temp.optional_id(92),'return',true,'Complete return without controlled items')$$,'all-untracked return succeeds without physical movements');
select is(public.reverse_order_inventory((select id from optional_orders where label='entirely-untracked'),pg_temp.optional_id(92),'return',true,'Complete return without controlled items')->>'replayed','true','all-untracked return is idempotent');
select is((select count(*) from inventory_movements m join inventory_operations op on op.id=m.operation_id where op.order_id=(select id from optional_orders where label='entirely-untracked')),0::bigint,'all-untracked lifecycle produces no stock movement');
select ok(not exists(select 1 from inventory_balances where product_id=pg_temp.optional_id(14)),'all-untracked lifecycle never invents a balance');

select pg_temp.optional_order('cancel-mixed',10,1,15);
select pg_temp.optional_stock(15,'0');
select pg_temp.optional_accept('cancel-mixed');
select lives_ok($$select public.cancel_order((select id from optional_orders where label='cancel-mixed'),'Customer cancellation')$$,'mixed cancellation releases only counted lines after a later initial quantity');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(10)),0::bigint,'cancellation releases counted reservation');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(15)),0::bigint,'cancellation cannot release an untracked line from a new balance');

select public.save_payment_account(pg_temp.optional_id(2),'optional-merchant','encrypted-synthetic',now()+interval '1 day',false);
update restaurants set store_checkout_online_enabled=true where id=pg_temp.optional_id(2);
select pg_temp.optional_order('online-mixed',10,1,16,true);
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(10)),1::bigint,'online mixed order holds counted units');
select pg_temp.optional_stock(16,'0');
select is(pg_temp.optional_payment('online-mixed','rejected')->>'paymentStatus','rejected','online rejection releases a mixed hold');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(10)),0::bigint,'rejection returns counted units once');
select is(pg_temp.optional_payment('online-mixed','approved',1)->>'paymentStatus','approved','late approval respects original line policy after first zero quantity');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(16)),0::bigint,'late approval never reserves the formerly untracked line');
select pg_temp.optional_accept('online-mixed');
select pg_temp.optional_complete('online-mixed');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(10)),6::bigint,'online mixed delivery consumes one counted unit');
select is((select on_hand from inventory_balances where product_id=pg_temp.optional_id(16)),0::bigint,'online mixed delivery leaves later zero balance intact');

select pg_temp.optional_order('online-free',17,1,null,true);
update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id=(select attempt_id from optional_orders where label='online-free');
select is(public.expire_online_reservations(),1,'untracked online reservation expires normally without a balance');
select pg_temp.optional_stock(17,'0');
select is(pg_temp.optional_payment('online-free','approved')->>'paymentStatus','approved','late free-order approval remains valid after zero stock is loaded');
select is((select reserved from inventory_balances where product_id=pg_temp.optional_id(17)),0::bigint,'late free-order approval has no retroactive reservation');
select lives_ok($$select public.cancel_order((select id from optional_orders where label='online-free'),'Customer cancelled free order')$$,'paid all-untracked order can be cancelled');
select is(pg_temp.optional_payment('online-free','refunded',1)->>'paymentStatus','refunded','refund resolves cancellation without moving later stock');
select is((select count(*) from inventory_movements m join inventory_operations op on op.id=m.operation_id where op.order_id=(select id from optional_orders where label='online-free')),0::bigint,'expiry, late payment, cancellation and refund create no untracked stock movement');

select public.change_inventory_policy(pg_temp.optional_id(2),'paused','Optional-stock recount',(select inventory_version from restaurants where id=pg_temp.optional_id(2)));
select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(14))#>>'{group,variants,0,available}','false','uncounted product still respects commerce pause');
select throws_ok($$select pg_temp.optional_order('paused-free',14)$$,'22023','INVENTORY_PAUSED','untracked checkout cannot bypass inventory pause');
select public.begin_inventory_count(pg_temp.optional_id(2),pg_temp.optional_id(93),'Recount only initialized products');
create temporary table optional_count_rows as select jsonb_agg(jsonb_build_object('productId',product_id,'quantity',on_hand,'countedAt',clock_timestamp()) order by product_id) rows
from inventory_balances where restaurant_id=pg_temp.optional_id(2);
select throws_ok($$select public.finish_inventory_count(pg_temp.optional_id(93),(select rows-0 from optional_count_rows),'{}',true,'No physical movement in any channel',false)$$,
  '22023','INVENTORY_COUNT_INCOMPLETE','recount still requires every controlled balance');
select lives_ok($$select public.finish_inventory_count(pg_temp.optional_id(93),(select rows from optional_count_rows),'{}',true,'No physical movement in any channel',false)$$,'recount may omit products without initialized quantities');
select ok(not exists(select 1 from inventory_balances where product_id=pg_temp.optional_id(14)),'recount does not create stock for omitted uncounted product');
select public.change_inventory_policy(pg_temp.optional_id(2),'enforced','Resume reviewed optional stock',(select inventory_version from restaurants where id=pg_temp.optional_id(2)));
select is(public.get_public_catalog_group('optional-stock','store',pg_temp.optional_id(14))#>>'{group,variants,0,available}','true','untracked product returns to sale after explicit resume');

select lives_ok($$select public.activate_inventory_from_product_stock(pg_temp.optional_id(22),pg_temp.optional_id(94),0)$$,'commerce may activate with no loaded quantities');
select public.change_inventory_policy(pg_temp.optional_id(22),'paused','Empty controlled recount',(select inventory_version from restaurants where id=pg_temp.optional_id(22)));
select public.begin_inventory_count(pg_temp.optional_id(22),pg_temp.optional_id(95),'No controlled items to count');
select lives_ok($$select public.finish_inventory_count(pg_temp.optional_id(95),'[]','{}',true,'No controlled products or physical movements',false)$$,'empty recount is valid when no products have balances');
select is((select count(*) from inventory_balances where restaurant_id=pg_temp.optional_id(22)),0::bigint,'empty activation and recount preserve absent stock');

select ok(not exists(select 1 from inventory_balances b where b.restaurant_id=pg_temp.optional_id(2) and
  (b.on_hand<>(select coalesce(sum(m.delta_on_hand),0) from inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id)
  or b.reserved<>(select coalesce(sum(m.delta_reserved),0) from inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id))),
  'optional stock balances reconcile to append-only movement totals');
set constraints all immediate;
select pass('mixed and entirely untracked lifecycle invariants hold at transaction boundary');
select * from finish();
rollback;
