begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(88);

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
('1d000000-0000-4000-8000-000000000001','inventory-admin@example.test',now(),'{}'),
('1d000000-0000-4000-8000-000000000002','inventory-manager@example.test',now(),'{}'),
('1d000000-0000-4000-8000-000000000003','inventory-outsider@example.test',now(),'{}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by) values
('2d000000-0000-4000-8000-000000000001','Inventory A','Inventory A','inventory-a','active','+5491111111111','Synthetic','Synthetic','INA',true,'1d000000-0000-4000-8000-000000000001'),
('2d000000-0000-4000-8000-000000000002','Inventory B','Inventory B','inventory-b','active','+5492222222222','Synthetic','Synthetic','INB',true,'1d000000-0000-4000-8000-000000000003');
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values
('2d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001','restaurant_admin','active','1d000000-0000-4000-8000-000000000001'),
('2d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000002','order_manager','active','1d000000-0000-4000-8000-000000000001'),
('2d000000-0000-4000-8000-000000000002','1d000000-0000-4000-8000-000000000003','restaurant_admin','active','1d000000-0000-4000-8000-000000000003');
insert into public.categories(id,restaurant_id,name,slug,created_by,updated_by) values
('3d000000-0000-4000-8000-000000000001','2d000000-0000-4000-8000-000000000001','Stock','stock','1d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,created_by,updated_by) values
('4d000000-0000-4000-8000-000000000001','2d000000-0000-4000-8000-000000000001','3d000000-0000-4000-8000-000000000001','INV-A','Product A',100,'1d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001'),
('4d000000-0000-4000-8000-000000000002','2d000000-0000-4000-8000-000000000001','3d000000-0000-4000-8000-000000000001','INV-B','Product B',200,'1d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001');
insert into public.payment_methods(id,restaurant_id,code,name) values('7d000000-0000-4000-8000-000000000001','2d000000-0000-4000-8000-000000000001','cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
select '2d000000-0000-4000-8000-000000000001',d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
create temporary table inventory_test_orders(label text primary key,id uuid,action_id uuid);
grant select on inventory_test_orders to authenticated,service_role;
create function pg_temp.inventory_fixture_order(p_label text,p_quantity integer,p_second integer default 0,p_product_id uuid default '4d000000-0000-4000-8000-000000000001') returns uuid
language plpgsql security definer set search_path='' as $$
declare request jsonb; result jsonb; key uuid:=extensions.gen_random_uuid(); v_order_id uuid;
begin
  request:=jsonb_build_object('restaurantSlug','inventory-a','idempotencyKey',key,'customer',jsonb_build_object('name','Synthetic','phone','+5494444444444'),
    'fulfillment',jsonb_build_object('type','pickup'),'paymentMethodId','7d000000-0000-4000-8000-000000000001',
    'items',jsonb_build_array(jsonb_build_object('productId',p_product_id,'quantity',p_quantity,'optionIds','[]'::jsonb)));
  if p_second>0 then request:=jsonb_set(request,'{items}',request->'items'||jsonb_build_array(jsonb_build_object('productId','4d000000-0000-4000-8000-000000000002','quantity',p_second,'optionIds','[]'::jsonb))); end if;
  result:=public.create_order_transaction(request,repeat('a',64),repeat('b',64),repeat('c',64));
  select o.id into v_order_id from public.orders o where o.idempotency_key=key;
  insert into pg_temp.inventory_test_orders select p_label,o.id,o.action_id from public.orders o where o.id=v_order_id;
  return v_order_id;
end $$;
grant execute on function pg_temp.inventory_fixture_order(text,integer,integer,uuid) to authenticated,service_role;
select pg_temp.inventory_fixture_order('legacy',1);
select is((select inventory_mode from public.restaurants where id='2d000000-0000-4000-8000-000000000001'),'never_enabled','existing restaurant starts without inventory');
select ok(not (select inventory_tracked from public.orders where id=(select id from inventory_test_orders where label='legacy')),'legacy generated order is explicitly untracked');
select ok(not has_table_privilege('authenticated','public.inventory_balances','update') and not has_table_privilege('anon','public.inventory_movements','select'),'clients cannot write balances or read ledger anonymously');
select ok(not has_function_privilege('authenticated','private.complete_order_without_inventory(uuid)','execute'),'legacy completion implementation cannot be called by clients');

select set_config('request.jwt.claim.sub','1d000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"1d000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select is(public.get_inventory('2d000000-0000-4000-8000-000000000001')#>>'{policy,businessConfirmed}','false','business policy is not silently confirmed');
select is(public.claim_order((select action_id from inventory_test_orders where label='legacy'))->>'claimed','true','legacy acceptance remains compatible before activation');
update public.products set deleted_at=now(),active=false where id='4d000000-0000-4000-8000-000000000001';
select is((select item->>'archived' from jsonb_array_elements(public.get_inventory('2d000000-0000-4000-8000-000000000001')->'items') item where item->>'productId'='4d000000-0000-4000-8000-000000000001'),'true','archived SKU in accepted legacy order remains visible before initial count');
select lives_ok($$select public.begin_inventory_count('2d000000-0000-4000-8000-000000000001','9d000000-0000-4000-8000-000000000001','Opening physical count')$$,'administrator opens immobile physical count');
select throws_ok($$select pg_temp.inventory_fixture_order('cutover-blocked',1,0,'4d000000-0000-4000-8000-000000000002')$$,'22023','INVENTORY_CUTOVER','current order creation RPC is blocked during first count');
select throws_ok($$select public.complete_order((select id from inventory_test_orders where label='legacy'))$$,'22023','INVENTORY_CUTOVER','legacy delivery cannot bypass count cutover');
select throws_ok($$insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,created_by,updated_by) values('4d000000-0000-4000-8000-000000000003','2d000000-0000-4000-8000-000000000001','3d000000-0000-4000-8000-000000000001','CUTOVER','New during count',100,'1d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001')$$,'22023','INVENTORY_CUTOVER','new SKU cannot enter catalogue during frozen count');
reset role;
create temporary table inventory_count_rows as select jsonb_build_array(
  jsonb_build_object('productId','4d000000-0000-4000-8000-000000000001','quantity',5,'countedAt',clock_timestamp()),
  jsonb_build_object('productId','4d000000-0000-4000-8000-000000000002','quantity',0,'countedAt',clock_timestamp())) rows;
grant select on inventory_count_rows to authenticated;
set local role authenticated;
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],true,'All channels stopped and reconciled',true)$$,
 '22023','INVENTORY_BUSINESS_POLICY_PENDING','activation requires real business-policy confirmation');
select throws_ok($$select public.confirm_inventory_business_policy('2d000000-0000-4000-8000-000000000001','{}')$$,'22023','INVENTORY_BUSINESS_POLICY_UNSUPPORTED','incomplete business assumptions cannot activate stock');
select lives_ok($$select public.confirm_inventory_business_policy('2d000000-0000-4000-8000-000000000001','{"unitModel":"whole_product","sourceOfTruth":"app","otherChannels":"record_before_handoff","returns":"full_only","partialDeliveries":"none","physicalScope":"until_handoff_including_transit","acceptance":"reserve","delivery":"physical_handoff","acceptedReservationsExpire":false}')$$,'explicit supported business policy can be confirmed in synthetic test');
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows - 0 from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],true,'All channels stopped and reconciled',true)$$,
 '22023','INVENTORY_COUNT_INCOMPLETE','activation cannot omit archived SKU promised in a pending legacy order');
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),'{}',true,'All channels stopped and reconciled',true)$$,
 '22023','INVENTORY_PENDING_REVIEW_REQUIRED','activation cannot silently leave open legacy orders');
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],false,'All channels stopped and reconciled',true)$$,
 '22023','INVENTORY_COUNT_EVIDENCE_REQUIRED','physical no-movement assertion is mandatory');
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',jsonb_set((select rows from inventory_count_rows),'{0,countedAt}',to_jsonb((now()-interval '1 day')::text)),array[(select id from inventory_test_orders where label='legacy')],true,'All channels stopped and reconciled',true)$$,
 '22023','INVENTORY_COUNT_TIME_INVALID','count from before frozen window is rejected');
select is(public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],true,'All channels stopped and reconciled',true)->>'activated','true','opening count and explicit pending adoption activate atomically');
select is(public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],true,'All channels stopped and reconciled',true)->>'replayed','true','same count retry returns persisted result');
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000001',(select rows from inventory_count_rows),array[(select id from inventory_test_orders where label='legacy')],true,'Changed attestation text',true)$$,
 '22023','IDEMPOTENCY_CONFLICT','count retry with different content conflicts');
reset role;
select is((select on_hand from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000002'),0::bigint,'explicit zero initializes a balance');
select ok((select inventory_tracked from public.orders where id=(select id from inventory_test_orders where label='legacy')),'reviewed legacy pending now has controlled snapshot');
select is((select reserved from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),1::bigint,'adopting already accepted legacy order creates its reservation atomically');
update public.products set deleted_at=null,active=true where id='4d000000-0000-4000-8000-000000000001';
select pg_temp.inventory_fixture_order('four',4);
select pg_temp.inventory_fixture_order('competing',4);
select pg_temp.inventory_fixture_order('mixed',1,1);
set local role authenticated;
select is(public.claim_order((select action_id from inventory_test_orders where label='four'))->>'claimed','true','acceptance reserves available units');
select is(public.claim_order((select action_id from inventory_test_orders where label='four'))->>'alreadyClaimed','true','acceptance retry is idempotent');
select throws_ok($$select public.claim_order((select action_id from inventory_test_orders where label='competing'))$$,'22023','INSUFFICIENT_STOCK','second acceptance cannot oversell reserved stock');
select throws_ok($$select public.claim_order((select action_id from inventory_test_orders where label='mixed'))$$,'22023','INSUFFICIENT_STOCK','multi-SKU acceptance fails wholly when one SKU lacks stock');
reset role;
select is((select on_hand from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),5::bigint,'acceptance never deducts physical stock');
select is((select reserved from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),5::bigint,'failed competing and mixed requests preserve new and adopted reservations');
select is((select count(*) from public.inventory_operations where order_id=(select id from inventory_test_orders where label='four') and kind='reserve'),1::bigint,'acceptance retry creates one reserve operation');
select is((select status::text from public.orders where id=(select id from inventory_test_orders where label='mixed')),'generated','failed reservation leaves order state intact');
create function pg_temp.inventory_injected_failure() returns trigger language plpgsql as $$begin if new.kind='delivery' then raise exception 'TEST_INJECTED_FAILURE'; end if; return new; end$$;
create trigger inventory_test_failure before insert on public.inventory_operations for each row execute function pg_temp.inventory_injected_failure();
set local role authenticated;
select throws_ok($$select public.complete_order((select id from inventory_test_orders where label='four'))$$,'P0001','TEST_INJECTED_FAILURE','injected failure after balance changes aborts delivery transaction');
reset role;
drop trigger inventory_test_failure on public.inventory_operations;
select is((select on_hand from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),5::bigint,'failed delivery rolls physical debit back');
select is((select reserved from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),5::bigint,'failed delivery rolls reservation consumption back');
select is((select status::text from public.orders where id=(select id from inventory_test_orders where label='four')),'accepted','failed delivery leaves accepted state');
set local role authenticated;
select is(public.complete_order((select id from inventory_test_orders where label='four'))->>'completed','true','physical handoff completes and consumes reserved stock');
select is(public.complete_order((select id from inventory_test_orders where label='four'))->>'alreadyDelivered','true','delivery replay cannot debit twice');
reset role;
select is((select on_hand from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),1::bigint,'delivery debits four physical units once');
select is((select reserved from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),1::bigint,'delivery consumes only its own reservation');
set local role authenticated;
select is(public.reverse_order_inventory((select id from inventory_test_orders where label='four'),'ad000000-0000-4000-8000-000000000001','correction',true,'Wrong handoff confirmation')->>'kind','correction','false delivery can be compensated with reason');
select is(public.reverse_order_inventory((select id from inventory_test_orders where label='four'),'ad000000-0000-4000-8000-000000000001','correction',true,'Wrong handoff confirmation')->>'replayed','true','correction retry restores only once');
select throws_ok($$select public.reverse_order_inventory((select id from inventory_test_orders where label='four'),'ad000000-0000-4000-8000-000000000002','return',true,'Duplicate return attempt')$$,'22023','INVENTORY_ALREADY_REVERSED','return after correction cannot restore a second time');
reset role;
select pg_temp.inventory_fixture_order('replacement',2);
set local role authenticated;
select is(public.link_order_replacement((select id from inventory_test_orders where label='four'),(select id from inventory_test_orders where label='replacement'),'Correct replacement order')->>'changed','true','replacement retains explicit original and root');
select is(public.link_order_replacement((select id from inventory_test_orders where label='four'),(select id from inventory_test_orders where label='replacement'),'Correct replacement order')->>'changed','false','same replacement link is idempotent');
select throws_ok($$select public.link_order_replacement((select id from inventory_test_orders where label='four'),(select id from inventory_test_orders where label='competing'),'Another replacement order')$$,'22023','INVENTORY_REPLACEMENT_INVALID','original cannot acquire competing successors');
select public.claim_order((select action_id from inventory_test_orders where label='replacement'));
select public.complete_order((select id from inventory_test_orders where label='replacement'));
select is(public.get_order_metrics('2d000000-0000-4000-8000-000000000001',now()-interval '1 day',now()+interval '1 day')->>'completed','1','corrected original and valid replacement count once');
select is(public.reverse_order_inventory((select id from inventory_test_orders where label='replacement'),'ad000000-0000-4000-8000-000000000003','return',false,'Received damaged total return')->>'restocked','false','non-sellable total return is recorded without restocking');
reset role;
select is((select on_hand from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001'),3::bigint,'damaged return does not become available inventory');
select is((select sum(returned_quantity)::bigint from public.inventory_movements where operation_id='ad000000-0000-4000-8000-000000000003'),2::bigint,'received return quantity is separate from restocked quantity');
select pg_temp.inventory_fixture_order('partly-sellable',2);
set local role authenticated;
select public.claim_order((select action_id from inventory_test_orders where label='partly-sellable'));
select public.complete_order((select id from inventory_test_orders where label='partly-sellable'));
select throws_ok($$select public.reverse_order_inventory((select id from inventory_test_orders where label='partly-sellable'),'ad000000-0000-4000-8000-000000000004','return',true,'Total received, one damaged','[{"productId":"4d000000-0000-4000-8000-000000000001","quantity":3}]')$$,'22023','INVENTORY_RETURN_QUANTITIES_INVALID','sellable return quantity cannot exceed total delivery');
select lives_ok($$select public.reverse_order_inventory((select id from inventory_test_orders where label='partly-sellable'),'ad000000-0000-4000-8000-000000000004','return',true,'Total received, one damaged','[{"productId":"4d000000-0000-4000-8000-000000000001","quantity":1}]')$$,'total return may restore only its explicitly sellable part');
select is(public.reverse_order_inventory((select id from inventory_test_orders where label='partly-sellable'),'ad000000-0000-4000-8000-000000000004','return',true,'Total received, one damaged','[{"productId":"4d000000-0000-4000-8000-000000000001","quantity":1}]')->>'replayed','true','partly sellable total return retries without additional stock');
reset role;
select is((select sum(returned_quantity)::bigint from public.inventory_movements where operation_id='ad000000-0000-4000-8000-000000000004'),2::bigint,'total received quantity remains two even when only one is sellable');
select is((select sum(delta_on_hand)::bigint from public.inventory_movements where operation_id='ad000000-0000-4000-8000-000000000004'),1::bigint,'only explicit sellable quantity returns to on-hand stock');
set local role authenticated;
select public.claim_order((select action_id from inventory_test_orders where label='legacy'));
select is(public.cancel_order((select id from inventory_test_orders where label='legacy'),'Customer cancelled')->>'cancelled','true','cancellation releases reservation without physical receipt');
select is(public.cancel_order((select id from inventory_test_orders where label='legacy'),'Customer cancelled')->>'cancelled','false','cancellation retry does not release twice');
select ok(to_regprocedure('public.change_inventory_policy(uuid,text,text)') is null,'no policy-changing overload bypasses the reviewed version');
select throws_ok($$select public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','paused','Missing reviewed version',null)$$,'22023','INVENTORY_VERSION_REQUIRED','policy changes require the reviewed version');
select set_config('test.inventory_policy_before_pause',(select inventory_version::text from public.restaurants where id='2d000000-0000-4000-8000-000000000001'),true);
select is(public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','paused','Reconciliation requested',current_setting('test.inventory_policy_before_pause')::bigint)->>'mode','paused','operator can pause with existing protections retained');
select throws_ok($$select public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','paused','Reconciliation requested',current_setting('test.inventory_policy_before_pause')::bigint)$$,'40001','INVENTORY_VERSION_CONFLICT','uncertain policy retry requires review even when the current mode matches');
select is(public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','paused','Reviewed existing pause',(select inventory_version from public.restaurants where id='2d000000-0000-4000-8000-000000000001'))->>'changed','false','same policy is a no-op only after reviewing its current version');
select throws_ok($$select pg_temp.inventory_fixture_order('paused-blocked',1)$$,'22023','INVENTORY_PAUSED','current order creation blocks during pause');
select throws_ok($$select public.claim_order((select action_id from inventory_test_orders where label='competing'))$$,'22023','INVENTORY_PAUSED','acceptance blocks during pause');
select is(public.complete_order((select id from inventory_test_orders where label='four'))->>'alreadyDelivered','true','confirmed delivery replay stays readable during pause');
select throws_ok($$select public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','enforced','Resume without count',(select inventory_version from public.restaurants where id='2d000000-0000-4000-8000-000000000001'))$$,'22023','INVENTORY_RECONCILIATION_REQUIRED','resume requires reconciliation after pause');
select throws_ok($$select public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','never_enabled','Bypass stock attempt',(select inventory_version from public.restaurants where id='2d000000-0000-4000-8000-000000000001'))$$,'22023','INVENTORY_INPUT_INVALID','API has no revert-to-legacy switch');
select public.cancel_order((select id from inventory_test_orders where label='mixed'),'Close unaccepted fixture');
update public.products set deleted_at=now(),active=false where restaurant_id='2d000000-0000-4000-8000-000000000001';
select is(jsonb_array_length(public.get_inventory('2d000000-0000-4000-8000-000000000001')->'items'),2,'archived initialized balances remain visible, including zero without pending orders');
select public.begin_inventory_count('2d000000-0000-4000-8000-000000000001','9d000000-0000-4000-8000-000000000002','Recount paused inventory');
select throws_ok($$select public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000001','receipt','[{"productId":"4d000000-0000-4000-8000-000000000001","quantity":1}]','Receipt during frozen count')$$,'22023','INVENTORY_CUTOVER','ordinary receipt cannot change physical frontier during count');
reset role;
update inventory_count_rows set rows=jsonb_build_array(
  jsonb_build_object('productId','4d000000-0000-4000-8000-000000000001','quantity',2,'countedAt',clock_timestamp()),
  jsonb_build_object('productId','4d000000-0000-4000-8000-000000000002','quantity',0,'countedAt',clock_timestamp()));
set local role authenticated;
select throws_ok($$select public.finish_inventory_count('9d000000-0000-4000-8000-000000000002',(select rows - 1 from inventory_count_rows),'{}',true,'Physical count reconciled without any movements',false)$$,
 '22023','INVENTORY_COUNT_INCOMPLETE','recount must include archived balance even at zero with no open order');
select public.finish_inventory_count('9d000000-0000-4000-8000-000000000002',(select rows from inventory_count_rows),'{}',true,'Physical count reconciled without any movements',false);
select is((select item->>'onHand' from jsonb_array_elements(public.get_inventory('2d000000-0000-4000-8000-000000000001')->'items') item where item->>'productId'='4d000000-0000-4000-8000-000000000001'),'2','archived controlled SKU is reconciled by the same physical recount');
select is(public.get_inventory('2d000000-0000-4000-8000-000000000001')#>>'{policy,mode}','paused','finishing recount does not lift another contingency pause');
select is(public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','enforced','Count reviewed, reopening',(select inventory_version from public.restaurants where id='2d000000-0000-4000-8000-000000000001'))->>'mode','enforced','explicit resume after reconciliation reopens controlled flow');
select throws_ok($$select public.change_inventory_policy('2d000000-0000-4000-8000-000000000001','paused','Reconciliation requested',current_setting('test.inventory_policy_before_pause')::bigint)$$,'40001','INVENTORY_VERSION_CONFLICT','old pause retry cannot undo a later reconciled reopening');
select is(public.get_inventory('2d000000-0000-4000-8000-000000000001')#>>'{policy,mode}','enforced','stale retry preserves the newer reviewed policy');
reset role;
update public.products set deleted_at=null,active=true where restaurant_id='2d000000-0000-4000-8000-000000000001';
create temporary table inventory_receipt_rows as select jsonb_build_array(jsonb_build_object('productId',product_id,'quantity',2,'expectedVersion',version)) rows from public.inventory_balances where product_id='4d000000-0000-4000-8000-000000000001';
grant select on inventory_receipt_rows to authenticated;
set local role authenticated;
select is(public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000001','receipt',(select rows from inventory_receipt_rows),'Supplier receipt')->>'replayed','false','authorized receipt adds stock atomically');
select is(public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000001','receipt',(select rows from inventory_receipt_rows),'Supplier receipt')->>'replayed','true','receipt retry returns saved balances without another increase');
select throws_ok($$select public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000001','receipt',jsonb_set((select rows from inventory_receipt_rows),'{0,quantity}','3'),'Supplier receipt')$$,'22023','IDEMPOTENCY_CONFLICT','same operation key with changed receipt conflicts');
select throws_ok($$select public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000002','adjustment','[{"productId":"4d000000-0000-4000-8000-000000000001","quantity":-1,"expectedVersion":0}]','Stale adjustment')$$,'40001','INVENTORY_VERSION_CONFLICT','stale adjustment cannot overwrite a later ledger state');
select set_config('request.jwt.claim.sub','1d000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"1d000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
select lives_ok($$select public.get_inventory('2d000000-0000-4000-8000-000000000001')$$,'order manager may read own balances');
select throws_ok($$select public.inventory_adjust('2d000000-0000-4000-8000-000000000001','bd000000-0000-4000-8000-000000000001','receipt',(select rows from inventory_receipt_rows),'Supplier receipt')$$,'42501','INVENTORY_FORBIDDEN','manager cannot adjust even by replaying known operation');
select set_config('request.jwt.claim.sub','1d000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"1d000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}',true);
select throws_ok($$select public.get_inventory('2d000000-0000-4000-8000-000000000001')$$,'42501','INVENTORY_FORBIDDEN','other tenant cannot read balances or operations');
select is((select count(*) from public.inventory_balances where restaurant_id='2d000000-0000-4000-8000-000000000001'),0::bigint,'RLS hides balance rows across tenants');
reset role;
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,created_by,updated_by) values('4d000000-0000-4000-8000-000000000003','2d000000-0000-4000-8000-000000000001','3d000000-0000-4000-8000-000000000001','NEW-STOCK','Uninitialized product',100,'1d000000-0000-4000-8000-000000000001','1d000000-0000-4000-8000-000000000001');
select throws_ok($$select pg_temp.inventory_fixture_order('new-sku-blocked',1,0,'4d000000-0000-4000-8000-000000000003')$$,'22023','INVENTORY_NOT_INITIALIZED','new SKU inherits mandatory inventory and cannot use legacy checkout');
select is((select product->>'available' from jsonb_array_elements(public.get_public_menu('inventory-a')->'categories') category cross join lateral jsonb_array_elements(category->'products') product where product->>'id'='4d000000-0000-4000-8000-000000000003'),'false','uninitialized SKU is unavailable in public menu without ledger exposure');
select ok(not exists(select 1 from public.inventory_balances b where b.restaurant_id='2d000000-0000-4000-8000-000000000001' and (
 b.on_hand<>(select coalesce(sum(m.delta_on_hand),0) from public.inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id)
 or b.reserved<>(select coalesce(sum(m.delta_reserved),0) from public.inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id))), 'ledger deltas reconcile exactly to physical and reserved balances');
select throws_ok($$update public.inventory_movements set delta_on_hand=99 where restaurant_id='2d000000-0000-4000-8000-000000000001'$$,'42501','APPEND_ONLY_RECORD','ledger cannot be rewritten even through owner maintenance');
set constraints all immediate;
select pass('deferred order/ledger invariants hold at transaction boundary');
select * from finish();
rollback;
