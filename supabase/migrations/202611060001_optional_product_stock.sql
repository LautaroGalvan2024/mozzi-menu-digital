-- Stock is optional per product. An absent balance means sales are unrestricted;
-- an explicit balance, including zero, is enforced while inventory is active.
-- Historical inventory snapshots keep their original accounting. New snapshots
-- freeze the policy at order creation, including orders made before activation.
alter table public.order_inventory_lines
  add column stock_tracked boolean not null default true;
comment on column public.order_inventory_lines.stock_tracked is
  'Immutable stock policy captured at order creation. False lines never reserve, consume, or restore inventory.';

-- Shared projection for menu/store pages, product details and cart hydration.
create or replace function private.public_catalog_groups(
  p_restaurant_id uuid,
  p_group_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select group_id, min(ordinality)::bigint as requested_order
    from unnest(coalesce(p_group_ids, '{}'::uuid[])) with ordinality requested_rows(group_id, ordinality)
    where group_id is not null
    group by group_id
  ),
  selected_products as (
    select
      requested.requested_order,
      coalesce(p.family_id, p.id) as group_id,
      p.*,
      f.id as selected_family_id,
      f.name as family_name,
      f.description as family_description,
      f.image_path as family_image_path,
      f.axes as family_axes,
      r.inventory_mode,
      r.inventory_cutover_id,
      b.on_hand,
      b.reserved
    from requested
    join public.products p
      on coalesce(p.family_id, p.id) = requested.group_id
     and p.restaurant_id = p_restaurant_id
     and p.deleted_at is null
     and p.active
    join public.categories c
      on c.id = p.category_id
     and c.restaurant_id = p.restaurant_id
     and c.deleted_at is null
     and c.active
    join public.restaurants r on r.id = p.restaurant_id
    left join public.product_families f
      on f.id = p.family_id
     and f.restaurant_id = p.restaurant_id
    left join public.inventory_balances b
      on b.restaurant_id = p.restaurant_id
     and b.product_id = p.id
    where f.id is null or f.active
  ),
  quantity_prices as (
    select
      q.product_id,
      jsonb_agg(
        jsonb_build_object(
          'quantity', q.quantity,
          'totalPriceCents', q.total_price_cents::text
        ) order by q.quantity
      ) as rows
    from public.product_quantity_prices q
    join selected_products p
      on p.id = q.product_id and p.restaurant_id = q.restaurant_id
    where q.active
    group by q.product_id
  ),
  option_values as (
    select
      po.option_group_id,
      jsonb_agg(
        jsonb_build_object(
          'id', po.id,
          'name', po.name,
          'priceDeltaCents', po.price_delta_cents::text,
          'sortOrder', po.sort_order
        ) order by po.sort_order, po.name, po.id
      ) as rows
    from public.product_options po
    join public.product_option_groups pog
      on pog.id = po.option_group_id
     and pog.restaurant_id = po.restaurant_id
    join selected_products p
      on p.id = pog.product_id and p.restaurant_id = pog.restaurant_id
    where po.active and pog.active
    group by po.option_group_id
  ),
  option_groups as (
    select
      pog.product_id,
      jsonb_agg(
        jsonb_build_object(
          'id', pog.id,
          'name', pog.name,
          'required', pog.required,
          'minSelect', pog.min_select,
          'maxSelect', pog.max_select,
          'sortOrder', pog.sort_order,
          'options', coalesce(option_values.rows, '[]'::jsonb)
        ) order by pog.sort_order, pog.name, pog.id
      ) as rows
    from public.product_option_groups pog
    join selected_products p
      on p.id = pog.product_id and p.restaurant_id = pog.restaurant_id
    left join option_values on option_values.option_group_id = pog.id
    where pog.active
    group by pog.product_id
  ),
  variants as (
    select
      p.requested_order,
      p.group_id,
      p.category_id,
      p.selected_family_id,
      p.family_name,
      p.family_description,
      p.family_image_path,
      p.family_axes,
      p.featured,
      p.sort_order,
      p.name,
      p.id,
      jsonb_build_object(
        'id', p.id,
        'categoryId', p.category_id,
        'code', p.code,
        'name', p.name,
        'description', p.description,
        'basePriceCents', p.base_price_cents::text,
        'promotionalPriceCents', p.promotional_price_cents::text,
        'promotionStartsAt', p.promotion_starts_at,
        'promotionEndsAt', p.promotion_ends_at,
        'imagePath', p.image_path,
        'available', case
          when p.inventory_mode = 'never_enabled' and p.inventory_cutover_id is null
            then p.available
          else p.available
            and p.inventory_mode = 'enforced'
            and p.inventory_cutover_id is null
            and (p.on_hand is null or p.on_hand > p.reserved)
        end,
        'featured', p.featured,
        'sortOrder', p.sort_order,
        'quantityPrices', case when p.quantity_threshold_minimum is null then coalesce(quantity_prices.rows, '[]'::jsonb) else '[]'::jsonb end,
        'quantityThreshold', case when p.quantity_threshold_minimum is null then null else jsonb_build_object(
          'minimumQuantity',p.quantity_threshold_minimum,'unitPriceCents',p.quantity_threshold_unit_price_cents::text) end,
        'optionGroups', coalesce(option_groups.rows, '[]'::jsonb),
        'family', case when p.selected_family_id is null then null else jsonb_build_object(
          'id', p.selected_family_id,
          'name', p.family_name,
          'description', p.family_description,
          'imagePath', p.family_image_path,
          'axes', to_jsonb(p.family_axes)
        ) end,
        'variantAttributes', p.variant_attributes
      ) as document
    from selected_products p
    left join quantity_prices on quantity_prices.product_id = p.id
    left join option_groups on option_groups.product_id = p.id
  ),
  grouped as (
    select
      requested_order,
      group_id,
      category_id,
      selected_family_id,
      family_name,
      family_description,
      family_image_path,
      family_axes,
      jsonb_agg(document order by featured desc, sort_order, name, id) as variant_documents
    from variants
    group by requested_order, group_id, category_id, selected_family_id,
      family_name, family_description, family_image_path, family_axes
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', group_id,
      'categoryId', category_id,
      'family', case when selected_family_id is null then null else jsonb_build_object(
        'id', selected_family_id,
        'name', family_name,
        'description', family_description,
        'imagePath', family_image_path,
        'axes', to_jsonb(family_axes)
      ) end,
      'variants', variant_documents
    ) order by requested_order
  ), '[]'::jsonb)
  from grouped
$$;

create or replace function private.inventory_snapshot(p_order_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  if not exists(select 1 from public.order_items where order_id=p_order_id)
     or exists(select 1 from public.order_items where order_id=p_order_id and product_id is null) then
    raise exception using errcode='22023',message='INVENTORY_SNAPSHOT_INVALID';
  end if;
  -- Legacy orders without snapshots arrived before stock control. Adoption must
  -- preserve that promise even if a balance has since been entered. Existing
  -- snapshots (including historical tracked lines) remain immutable.
  insert into public.order_inventory_lines(order_item_id,restaurant_id,order_id,product_id,quantity,stock_tracked)
  select oi.id,oi.restaurant_id,oi.order_id,oi.product_id,oi.quantity,false
  from public.order_items oi join public.orders o on o.id=oi.order_id and o.restaurant_id=oi.restaurant_id
  where oi.order_id=p_order_id and not o.inventory_tracked
  on conflict(order_item_id) do nothing;
  -- Missing snapshots on an already tracked order are an integrity failure,
  -- never an opportunity to silently exempt its items from stock control.
  if exists(select 1 from public.order_items oi left join public.order_inventory_lines il on il.order_item_id=oi.id
    where oi.order_id=p_order_id and (il.order_item_id is null or il.product_id is distinct from oi.product_id or il.quantity<>oi.quantity)) then
    raise exception using errcode='22023',message='INVENTORY_SNAPSHOT_INVALID';
  end if;
end $$;

create or replace function private.inventory_item_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.product_id is null then
    raise exception using errcode='22023',message='INVENTORY_SNAPSHOT_INVALID';
  end if;
  -- Every new order freezes its per-item policy. The order insertion guard
  -- holds the restaurant lock, serializing this with first stock loads and
  -- activation. Loading stock later affects only subsequently created orders.
  insert into public.order_inventory_lines(order_item_id,restaurant_id,order_id,product_id,quantity,stock_tracked)
  select new.id,new.restaurant_id,new.order_id,new.product_id,new.quantity,
    o.inventory_tracked and exists(select 1 from public.inventory_balances b
      where b.restaurant_id=new.restaurant_id and b.product_id=new.product_id)
  from public.orders o where o.id=new.order_id and o.restaurant_id=new.restaurant_id;
  return new;
end $$;

-- Keep operation markers even when no lines are controlled, preserving order
-- lifecycle integrity and durable idempotency without inventing stock.
create or replace function private.inventory_order_operation(p_order_id uuid,p_kind text,p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_order public.orders%rowtype; v_op public.inventory_operations%rowtype; v_rows jsonb; v_result jsonb; v_id uuid:=extensions.gen_random_uuid();
begin
  select * into v_order from public.orders where id=p_order_id;
  select * into v_op from public.inventory_operations where order_id=p_order_id and kind=p_kind;
  if found then return v_op.result; end if;
  perform private.inventory_snapshot(p_order_id);
  if p_kind in ('delivery','release') and not exists(select 1 from public.inventory_operations where order_id=p_order_id and kind='reserve') then
    raise exception using errcode='22023',message='INVENTORY_RESERVATION_MISSING';
  end if;
  if p_kind not in ('reserve','delivery','release') then raise exception 'INVENTORY_OPERATION_INVALID'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',case when p_kind='delivery' then -x.quantity else 0 end,
    'deltaReserved',case when p_kind='reserve' then x.quantity else -x.quantity end) order by x.product_id),'[]'::jsonb)
  into v_rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=p_order_id and stock_tracked group by product_id) x;
  v_result:=jsonb_build_object('operationId',v_id,'kind',p_kind,'orderId',p_order_id,'items',private.inventory_apply(v_order.restaurant_id,v_id,v_rows));
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,result)
  values(v_id,v_order.restaurant_id,v_id,private.inventory_hash(jsonb_build_object('orderId',p_order_id,'kind',p_kind)),p_kind,p_order_id,p_kind,p_actor,v_result);
  return v_result;
end $$;

create or replace function private.online_stock_operation(p_attempt_id uuid,p_kind text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare a private.online_payment_attempts%rowtype; rows jsonb; result jsonb; operation_id uuid:=extensions.gen_random_uuid();
begin
  select * into strict a from private.online_payment_attempts where id=p_attempt_id;
  if p_kind='payment_hold' and a.reservation_state in ('held','committed') then return; end if;
  if p_kind='payment_release' and a.reservation_state<>'held' then return; end if;
  if p_kind='reserve' and a.reservation_state='committed' then return; end if;
  if p_kind not in ('payment_hold','payment_release','reserve') or (p_kind='reserve' and a.reservation_state<>'held') then raise exception 'PAYMENT_RESERVATION_INVALID'; end if;
  if p_kind in ('payment_hold','payment_release') and exists(select 1 from public.restaurants where id=a.restaurant_id and inventory_cutover_id is not null) then
    raise exception using errcode='22023',message='INVENTORY_CUTOVER';
  end if;
  if p_kind='payment_hold' then perform private.inventory_require_sales(a.restaurant_id,true); end if;
  perform private.inventory_snapshot(a.order_id);
  if p_kind='reserve' then
    -- The units are already reserved by the hold; conversion is a ledger marker.
    result:=jsonb_build_object('operationId',operation_id,'kind','reserve','orderId',a.order_id,'items','[]'::jsonb,'fromPaymentHold',true);
  else
    select coalesce(jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',0,
      'deltaReserved',case when p_kind='payment_hold' then x.quantity else -x.quantity end) order by x.product_id),'[]'::jsonb)
      into rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=a.order_id and stock_tracked group by product_id)x;
    result:=jsonb_build_object('operationId',operation_id,'kind',p_kind,'orderId',a.order_id,'items',private.inventory_apply(a.restaurant_id,operation_id,rows));
  end if;
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,actor_type,result)
    values(operation_id,a.restaurant_id,operation_id,private.inventory_hash(jsonb_build_object('attemptId',a.id,'kind',p_kind)),p_kind,a.order_id,
      'Mercado Pago: '||p_kind,null,'system',result);
  update private.online_payment_attempts set reservation_state=case p_kind when 'payment_hold' then 'held' when 'payment_release' then 'released' else 'committed' end where id=a.id;
end $$;

create or replace function private.release_paid_order(p_order_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; rows jsonb; result jsonb; operation_id uuid:=extensions.gen_random_uuid();
begin
  select * into o from public.orders where id=p_order_id;
  if exists(select 1 from public.inventory_operations where order_id=o.id and kind in ('delivery','release')) then return; end if;
  if not exists(select 1 from public.inventory_operations where order_id=o.id and kind='reserve') then return; end if;
  if exists(select 1 from public.restaurants where id=o.restaurant_id and inventory_cutover_id is not null) then
    raise exception using errcode='22023',message='INVENTORY_CUTOVER';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',0,'deltaReserved',-x.quantity) order by x.product_id),'[]'::jsonb)
    into rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=o.id and stock_tracked group by product_id)x;
  result:=jsonb_build_object('operationId',operation_id,'kind','release','orderId',o.id,'items',private.inventory_apply(o.restaurant_id,operation_id,rows));
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,actor_type,result)
    values(operation_id,o.restaurant_id,operation_id,private.inventory_hash(jsonb_build_object('orderId',o.id,'kind','release')),
      'release',o.id,'Mercado Pago: pago revertido',null,'system',result);
end $$;

create or replace function public.finish_inventory_count(
  p_count_id uuid,p_rows jsonb,p_pending_order_ids uuid[],p_no_movements_confirmed boolean,p_note text,p_activate boolean default false
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c public.inventory_counts%rowtype; r public.restaurants%rowtype; v_actor uuid; v_hash text; v_rows jsonb:='[]'; v_row jsonb; v_product uuid; v_quantity bigint; v_time timestamptz;
  v_on bigint; v_reserved bigint; v_id uuid:=extensions.gen_random_uuid(); v_result jsonb; o public.orders%rowtype;
begin
  select * into c from public.inventory_counts where id=p_count_id;
  if not found then raise exception using errcode='42501',message='INVENTORY_FORBIDDEN'; end if;
  v_actor:=private.inventory_authorize(c.restaurant_id,true,true);
  select * into c from public.inventory_counts where id=p_count_id for update;
  v_hash:=private.inventory_hash(jsonb_build_object('rows',p_rows,'pendingOrderIds',coalesce(p_pending_order_ids,'{}'::uuid[]),'noMovements',p_no_movements_confirmed,'note',p_note,'activate',p_activate));
  if c.finished_at is not null then
    if c.finish_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return c.result||jsonb_build_object('replayed',true);
  end if;
  select * into r from public.restaurants where id=c.restaurant_id;
  if r.inventory_cutover_id is distinct from c.id then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if p_no_movements_confirmed is distinct from true or char_length(btrim(coalesce(p_note,''))) not between 10 and 2000
     or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 0 and 5000 or pg_column_size(p_rows)>2097152 then
    raise exception using errcode='22023',message='INVENTORY_COUNT_EVIDENCE_REQUIRED';
  end if;
  if p_activate and (r.inventory_mode<>'never_enabled' or r.inventory_business_policy is null) then
    raise exception using errcode='22023',message='INVENTORY_BUSINESS_POLICY_PENDING';
  end if;
  if p_activate is null then raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID'; end if;
  perform id from public.orders where restaurant_id=c.restaurant_id and status in ('generated','whatsapp_opened','accepted') order by id for update;
  if p_activate and (
    exists(select 1 from public.orders where restaurant_id=c.restaurant_id and not inventory_tracked and status in ('generated','whatsapp_opened','accepted') and not(id=any(coalesce(p_pending_order_ids,'{}'::uuid[]))))
    or exists(select 1 from unnest(coalesce(p_pending_order_ids,'{}'::uuid[])) x where not exists(select 1 from public.orders o2 where o2.id=x and o2.restaurant_id=c.restaurant_id and not o2.inventory_tracked and o2.status in ('generated','whatsapp_opened','accepted')))
  ) then raise exception using errcode='22023',message='INVENTORY_PENDING_REVIEW_REQUIRED'; end if;
  if not p_activate and coalesce(cardinality(p_pending_order_ids),0)>0 then raise exception using errcode='22023',message='INVENTORY_PENDING_REVIEW_REQUIRED'; end if;
  if (select count(distinct x->>'productId') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then raise exception using errcode='22023',message='INVENTORY_DUPLICATE_PRODUCT'; end if;
  for v_row in select x from jsonb_array_elements(p_rows) x loop
    if coalesce(v_row->>'quantity','')!~'^[0-9]{1,13}$' then raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID'; end if;
    v_product:=(v_row->>'productId')::uuid; v_quantity:=(v_row->>'quantity')::bigint; v_time:=(v_row->>'countedAt')::timestamptz;
    if v_time is null or v_time<c.started_at or v_time>clock_timestamp() then raise exception using errcode='22023',message='INVENTORY_COUNT_TIME_INVALID'; end if;
    if not exists(select 1 from public.products where id=v_product and restaurant_id=c.restaurant_id) then raise exception using errcode='22023',message='INVENTORY_PRODUCT_INVALID'; end if;
    select on_hand,reserved into v_on,v_reserved from public.inventory_balances where restaurant_id=c.restaurant_id and product_id=v_product;
    if v_quantity<coalesce(v_reserved,0) then raise exception using errcode='22023',message='INSUFFICIENT_STOCK'; end if;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('productId',v_product,'deltaOnHand',v_quantity-coalesce(v_on,0),'deltaReserved',0,'initialize',true));
  end loop;
  -- A reconciliation must cover every controlled balance, including archived
  -- and zero-stock products. Uncontrolled products may be left blank; an
  -- explicit quantity opts them into stock control for future orders.
  if exists(select 1 from public.inventory_balances b where b.restaurant_id=c.restaurant_id
    and not exists(select 1 from jsonb_array_elements(p_rows) x where (x->>'productId')::uuid=b.product_id)) then
    raise exception using errcode='22023',message='INVENTORY_COUNT_INCOMPLETE';
  end if;
  v_result:=jsonb_build_object('operationId',v_id,'countId',c.id,'kind','count','items',private.inventory_apply(c.restaurant_id,v_id,v_rows),'activated',p_activate,'replayed',false);
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,reason,actor_user_id,result)
  values(v_id,c.restaurant_id,c.id,v_hash,'count',c.reason,v_actor,v_result);
  if p_activate then
    perform set_config('app.order_mutation','on',true);
    for o in select * from public.orders where restaurant_id=c.restaurant_id and id=any(coalesce(p_pending_order_ids,'{}'::uuid[])) order by id loop
      perform private.inventory_snapshot(o.id);
      update public.orders set inventory_tracked=true,inventory_policy_version=r.inventory_version+1 where id=o.id;
      if o.status='accepted' then perform private.inventory_order_operation(o.id,'reserve',v_actor); end if;
    end loop;
    update public.restaurants set inventory_mode='enforced',inventory_activated_at=clock_timestamp(),inventory_version=inventory_version+1 where id=c.restaurant_id;
  end if;
  update public.inventory_counts set finished_at=clock_timestamp(),finish_hash=v_hash,
    evidence=jsonb_build_object('rows',p_rows,'pendingOrderIds',coalesce(p_pending_order_ids,'{}'::uuid[]),'noMovementsConfirmed',true,'note',p_note,'recordedBy',v_actor),result=v_result where id=c.id;
  update public.restaurants set inventory_cutover_id=null where id=c.restaurant_id;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(c.restaurant_id,v_actor,'update','inventory_count',c.id,jsonb_build_object('operationId',v_id,'activated',p_activate));
  return v_result;
end $$;

create or replace function public.activate_inventory_from_product_stock(
  p_restaurant_id uuid,p_operation_id uuid,p_expected_policy_version bigint,p_other_channels text default 'record_before_handoff'
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid; v_hash text; v_previous private.catalog_stock_commands%rowtype; r public.restaurants%rowtype;
  o public.orders%rowtype; v_result jsonb; v_adopted integer:=0;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  if p_operation_id is null or p_expected_policy_version is null or p_other_channels is null
    or p_other_channels not in ('none','record_before_handoff') then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  v_hash:=private.inventory_hash(jsonb_build_object('kind','activate_from_product_stock','expectedPolicyVersion',p_expected_policy_version,'otherChannels',p_other_channels));
  select * into v_previous from private.catalog_stock_commands where restaurant_id=p_restaurant_id and operation_id=p_operation_id;
  if found then
    if v_previous.request_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return v_previous.result||jsonb_build_object('replayed',true);
  end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if r.inventory_mode='paused' then raise exception using errcode='22023',message='INVENTORY_PAUSED'; end if;
  if r.inventory_version<>p_expected_policy_version then raise exception using errcode='40001',message='INVENTORY_VERSION_CONFLICT'; end if;
  if r.inventory_mode<>'never_enabled' then raise exception using errcode='22023',message='INVENTORY_ALREADY_ENABLED'; end if;
  if r.inventory_business_policy is null then
    perform public.confirm_inventory_business_policy(p_restaurant_id,jsonb_build_object('unitModel','whole_product',
      'sourceOfTruth','app','otherChannels',p_other_channels,'returns','full_only','partialDeliveries','none',
      'physicalScope','until_handoff_including_transit','acceptance','reserve','delivery','physical_handoff','acceptedReservationsExpire',false));
  end if;
  -- The exclusive restaurant lock prevents new orders/claims from entering.
  -- Snapshot before changing the order policy so legacy orders stay untracked
  -- at the item level; accepted orders still receive their reservation marker.
  perform set_config('app.order_mutation','on',true);
  for o in select * from public.orders where restaurant_id=p_restaurant_id and not inventory_tracked
    and status in ('generated','whatsapp_opened','accepted') order by id for update loop
    perform private.inventory_snapshot(o.id);
    update public.orders set inventory_tracked=true,inventory_policy_version=r.inventory_version+1 where id=o.id;
    if o.status='accepted' then perform private.inventory_order_operation(o.id,'reserve',v_actor); end if;
    v_adopted:=v_adopted+1;
  end loop;
  update public.restaurants set inventory_mode='enforced',inventory_activated_at=clock_timestamp(),inventory_version=inventory_version+1
    where id=p_restaurant_id returning * into r;
  v_result:=jsonb_build_object('mode',r.inventory_mode,'version',r.inventory_version::text,'changed',true,'adoptedOrders',v_adopted,'replayed',false);
  insert into private.catalog_stock_commands(restaurant_id,operation_id,request_hash,actor_user_id,result)
  values(p_restaurant_id,p_operation_id,v_hash,v_actor,v_result);
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,v_actor,'update','inventory_policy',p_restaurant_id,
    jsonb_build_object('source','product_stock_activation','operationId',p_operation_id,'adoptedOrders',v_adopted));
  return v_result;
end $$;

-- CREATE OR REPLACE above preserves the existing function owners and ACLs.
-- Refresh clients whose cached catalog previously marked absent balances empty.
insert into private.catalog_revisions as current_revision(restaurant_id,revision,updated_at)
select id,1,clock_timestamp() from public.restaurants
on conflict(restaurant_id) do update
  set revision=current_revision.revision+1,updated_at=excluded.updated_at;
