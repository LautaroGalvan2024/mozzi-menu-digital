-- Explicit absolute quantities in catalogue forms. Initial quantities do not
-- activate inventory or invent balances for other SKUs. Catalogue + stock and
-- initial activation are durable commands so retrying cannot reset later sales.
create table private.catalog_stock_commands (
  restaurant_id uuid not null references public.restaurants(id),
  operation_id uuid not null,
  request_hash text not null,
  actor_user_id uuid not null references auth.users(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (restaurant_id,operation_id)
);
revoke all on private.catalog_stock_commands from public,anon,authenticated,service_role;

create function public.get_catalog_stock(p_restaurant_id uuid,p_product_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants%rowtype; v_items jsonb;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='INVENTORY_FORBIDDEN';
  end if;
  if p_product_ids is null or cardinality(p_product_ids)>5000 then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  if exists(select 1 from unnest(p_product_ids) x where x is null or not exists(
    select 1 from public.products p where p.id=x and p.restaurant_id=p_restaurant_id)) then
    raise exception using errcode='22023',message='INVENTORY_PRODUCT_INVALID';
  end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  select coalesce(jsonb_agg(jsonb_build_object('productId',p.id,'initialized',b.product_id is not null,
    'onHand',b.on_hand::text,'reserved',b.reserved::text,'available',(b.on_hand-b.reserved)::text,
    'version',b.version::text) order by p.id),'[]'::jsonb) into v_items
  from public.products p left join public.inventory_balances b on b.restaurant_id=p.restaurant_id and b.product_id=p.id
  where p.restaurant_id=p_restaurant_id and p.id=any(p_product_ids);
  return jsonb_build_object('policy',jsonb_build_object('mode',r.inventory_mode,'version',r.inventory_version::text,
    'cutoverId',r.inventory_cutover_id,'businessConfirmed',r.inventory_business_policy is not null,
    'businessPolicy',r.inventory_business_policy),'items',v_items);
end $$;

-- Callers hold the restaurant exclusively before the catalogue allocator and
-- product locks. This also serializes absent balances with orders and cutovers.
create function private.set_catalog_absolute_stock(p_restaurant_id uuid,p_operation_id uuid,p_rows jsonb,p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; b public.inventory_balances%rowtype; v_row jsonb;
  v_rows jsonb:='[]'; v_id uuid:=extensions.gen_random_uuid(); v_product uuid; v_on bigint; v_exists boolean; v_result jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>500 or pg_column_size(p_rows)>2097152 then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  if jsonb_array_length(p_rows)=0 then return jsonb_build_object('items','[]'::jsonb); end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if r.inventory_mode='paused' then raise exception using errcode='22023',message='INVENTORY_PAUSED'; end if;
  if exists(select 1 from public.inventory_operations where restaurant_id=p_restaurant_id and idempotency_key=p_operation_id) then
    raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT';
  end if;
  if (select count(distinct x->>'productId') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
    raise exception using errcode='22023',message='INVENTORY_DUPLICATE_PRODUCT';
  end if;
  perform b2.product_id from public.inventory_balances b2 where b2.restaurant_id=p_restaurant_id
    and b2.product_id in (select (x->>'productId')::uuid from jsonb_array_elements(p_rows) x)
    order by b2.product_id for update;
  for v_row in select x from jsonb_array_elements(p_rows) x order by (x->>'productId')::uuid loop
    if jsonb_typeof(v_row) is distinct from 'object' or coalesce(v_row->>'onHand','')!~'^[0-9]{1,13}$'
      or not(v_row ? 'expectedVersion') then
      raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID';
    end if;
    if jsonb_typeof(v_row->'expectedVersion')<>'null' then
      if coalesce(v_row->>'expectedVersion','')!~'^[0-9]{1,19}$' then
        raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID';
      end if;
      if (v_row->>'expectedVersion')::numeric>9223372036854775807 then
        raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID';
      end if;
    end if;
    v_product:=(v_row->>'productId')::uuid; v_on:=(v_row->>'onHand')::bigint;
    if v_product is null or not exists(select 1 from public.products where id=v_product and restaurant_id=p_restaurant_id) then
      raise exception using errcode='22023',message='INVENTORY_PRODUCT_INVALID';
    end if;
    select * into b from public.inventory_balances where restaurant_id=p_restaurant_id and product_id=v_product;
    v_exists:=found;
    if (v_exists and ((v_row->>'expectedVersion') is null or (v_row->>'expectedVersion')::bigint<>b.version))
      or (not v_exists and jsonb_typeof(v_row->'expectedVersion')<>'null') then
      raise exception using errcode='40001',message='INVENTORY_VERSION_CONFLICT';
    end if;
    if v_on<coalesce(b.reserved,0) then raise exception using errcode='22023',message='INSUFFICIENT_STOCK'; end if;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('productId',v_product,'deltaOnHand',v_on-coalesce(b.on_hand,0),
      'deltaReserved',0,'initialize',not v_exists));
  end loop;
  v_result:=jsonb_build_object('operationId',v_id,'kind','adjustment','items',private.inventory_apply(p_restaurant_id,v_id,v_rows));
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,reason,actor_user_id,result)
  values(v_id,p_restaurant_id,p_operation_id,private.inventory_hash(p_rows),'adjustment','Cantidad total guardada desde productos',p_actor,v_result);
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,p_actor,'update','inventory_operation',v_id,jsonb_build_object('source','catalog_absolute_stock','items',jsonb_array_length(p_rows)));
  return v_result;
end $$;

create function public.save_product_catalog_with_stock(
  p_restaurant_id uuid,p_product jsonb,p_groups jsonb,p_removed_group_ids uuid[],p_removed_option_ids uuid[],
  p_operation_id uuid,p_stock jsonb default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid; v_hash text; v_previous private.catalog_stock_commands%rowtype; v_result jsonb; v_stock jsonb; v_rows jsonb;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  if p_operation_id is null then raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID'; end if;
  v_hash:=private.inventory_hash(jsonb_build_object('kind','product','product',p_product,'groups',p_groups,
    'removedGroupIds',p_removed_group_ids,'removedOptionIds',p_removed_option_ids,'stock',p_stock));
  select * into v_previous from private.catalog_stock_commands where restaurant_id=p_restaurant_id and operation_id=p_operation_id;
  if found then
    if v_previous.request_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return v_previous.result||jsonb_build_object('replayed',true);
  end if;
  if p_stock is not null and jsonb_typeof(p_stock) is distinct from 'object' then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  v_result:=public.save_product_catalog(p_restaurant_id,p_product,p_groups,p_removed_group_ids,p_removed_option_ids);
  v_rows:=case when p_stock is null then '[]'::jsonb else jsonb_build_array(p_stock||jsonb_build_object('productId',p_product->>'id')) end;
  v_stock:=private.set_catalog_absolute_stock(p_restaurant_id,p_operation_id,v_rows,v_actor);
  v_result:=v_result||jsonb_build_object('stock',v_stock,'replayed',false);
  insert into private.catalog_stock_commands(restaurant_id,operation_id,request_hash,actor_user_id,result)
  values(p_restaurant_id,p_operation_id,v_hash,v_actor,v_result);
  return v_result;
end $$;

create function public.save_product_family_with_stock(
  p_restaurant_id uuid,p_family jsonb,p_variants jsonb,p_operation_id uuid,p_stock_rows jsonb default '[]'::jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid; v_hash text; v_previous private.catalog_stock_commands%rowtype; v_result jsonb; v_stock jsonb;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  if p_operation_id is null or jsonb_typeof(p_stock_rows) is distinct from 'array' or jsonb_typeof(p_variants) is distinct from 'array' then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  v_hash:=private.inventory_hash(jsonb_build_object('kind','family','family',p_family,'variants',p_variants,'stockRows',p_stock_rows));
  select * into v_previous from private.catalog_stock_commands where restaurant_id=p_restaurant_id and operation_id=p_operation_id;
  if found then
    if v_previous.request_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return v_previous.result||jsonb_build_object('replayed',true);
  end if;
  if exists(select 1 from jsonb_array_elements(p_stock_rows) s where not exists(
    select 1 from jsonb_array_elements(p_variants) v where v->>'productId'=s->>'productId')) then
    raise exception using errcode='22023',message='INVENTORY_PRODUCT_INVALID';
  end if;
  v_result:=public.save_product_family(p_restaurant_id,p_family,p_variants);
  v_stock:=private.set_catalog_absolute_stock(p_restaurant_id,p_operation_id,p_stock_rows,v_actor);
  v_result:=v_result||jsonb_build_object('stock',v_stock,'replayed',false);
  insert into private.catalog_stock_commands(restaurant_id,operation_id,request_hash,actor_user_id,result)
  values(p_restaurant_id,p_operation_id,v_hash,v_actor,v_result);
  return v_result;
end $$;

create function public.activate_inventory_from_product_stock(
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
  if exists(select 1 from public.products p where p.restaurant_id=p_restaurant_id
    and private.inventory_product_in_scope(p_restaurant_id,p.id)
    and not exists(select 1 from public.inventory_balances b where b.restaurant_id=p_restaurant_id and b.product_id=p.id)) then
    raise exception using errcode='22023',message='INVENTORY_NOT_INITIALIZED';
  end if;
  if r.inventory_business_policy is null then
    perform public.confirm_inventory_business_policy(p_restaurant_id,jsonb_build_object('unitModel','whole_product',
      'sourceOfTruth','app','otherChannels',p_other_channels,'returns','full_only','partialDeliveries','none',
      'physicalScope','until_handoff_including_transit','acceptance','reserve','delivery','physical_handoff','acceptedReservationsExpire',false));
  end if;
  -- The exclusive restaurant lock prevents new orders/claims from entering while
  -- all outstanding legacy orders are snapshotted and accepted units reserved.
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

revoke all on function private.set_catalog_absolute_stock(uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_catalog_stock(uuid,uuid[]),
  public.save_product_catalog_with_stock(uuid,jsonb,jsonb,uuid[],uuid[],uuid,jsonb),
  public.save_product_family_with_stock(uuid,jsonb,jsonb,uuid,jsonb),
  public.activate_inventory_from_product_stock(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.get_catalog_stock(uuid,uuid[]),
  public.save_product_catalog_with_stock(uuid,jsonb,jsonb,uuid[],uuid[],uuid,jsonb),
  public.save_product_family_with_stock(uuid,jsonb,jsonb,uuid,jsonb),
  public.activate_inventory_from_product_stock(uuid,uuid,bigint,text) to authenticated;
