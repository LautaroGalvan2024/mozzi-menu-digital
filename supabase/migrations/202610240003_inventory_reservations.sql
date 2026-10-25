-- Integer, one-product/one-physical-SKU implementation. Activation is opt-in and
-- requires an explicit business-policy confirmation plus an immobile count.
-- Existing tenants remain never_enabled; no historical inventory is invented.
alter table public.restaurants
  add column inventory_mode text not null default 'never_enabled' check (inventory_mode in ('never_enabled','enforced','paused')),
  add column inventory_version bigint not null default 0,
  add column inventory_activated_at timestamptz,
  add column inventory_paused_at timestamptz,
  add column inventory_cutover_id uuid,
  add column inventory_business_policy jsonb;
alter table public.restaurants add constraint inventory_activation_state check (
  (inventory_mode = 'never_enabled' and inventory_activated_at is null)
  or (inventory_mode in ('enforced','paused') and inventory_activated_at is not null)
);
alter table public.orders
  add column inventory_tracked boolean not null default false,
  add column inventory_policy_version bigint,
  add column inventory_outcome text not null default 'none' check (inventory_outcome in ('none','delivered','corrected','returned')),
  add column replaces_order_id uuid,
  add column root_order_id uuid,
  add column replacement_reason text;
alter table public.orders
  add foreign key (replaces_order_id,restaurant_id) references public.orders(id,restaurant_id),
  add foreign key (root_order_id,restaurant_id) references public.orders(id,restaurant_id),
  add check (replaces_order_id is null or replaces_order_id <> id);
create unique index orders_one_replacement_idx on public.orders(replaces_order_id) where replaces_order_id is not null;

create table public.inventory_balances (
  restaurant_id uuid not null,
  product_id uuid not null,
  on_hand bigint not null default 0 check (on_hand between 0 and 9007199254740991),
  reserved bigint not null default 0 check (reserved >= 0 and reserved <= on_hand),
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (restaurant_id,product_id),
  foreign key (product_id,restaurant_id) references public.products(id,restaurant_id) on delete restrict
);
create table public.inventory_operations (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  idempotency_key uuid not null,
  request_hash text not null,
  kind text not null check (kind in ('count','reserve','release','delivery','receipt','adjustment','external_sale','correction','return')),
  order_id uuid,
  source_operation_id uuid,
  external_reference text,
  reason text not null,
  actor_user_id uuid not null references auth.users(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (id,restaurant_id),
  unique (restaurant_id,idempotency_key),
  foreign key (order_id,restaurant_id) references public.orders(id,restaurant_id),
  foreign key (source_operation_id,restaurant_id) references public.inventory_operations(id,restaurant_id)
);
create unique index inventory_order_operation_idx on public.inventory_operations(order_id,kind)
  where kind in ('reserve','release','delivery');
create unique index inventory_total_reversal_idx on public.inventory_operations(source_operation_id)
  where kind in ('correction','return');
create unique index inventory_external_reference_idx on public.inventory_operations(restaurant_id,external_reference)
  where kind = 'external_sale';
create index inventory_operations_tenant_created_idx on public.inventory_operations(restaurant_id,created_at desc,id);
create table public.inventory_movements (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null,
  product_id uuid not null,
  operation_id uuid not null,
  delta_on_hand bigint not null,
  delta_reserved bigint not null,
  returned_quantity bigint not null default 0 check (returned_quantity >= 0),
  initializes_balance boolean not null default false,
  on_hand_after bigint not null check (on_hand_after >= 0),
  reserved_after bigint not null check (reserved_after >= 0 and reserved_after <= on_hand_after),
  created_at timestamptz not null default now(),
  unique (operation_id,product_id),
  foreign key (product_id,restaurant_id) references public.products(id,restaurant_id),
  foreign key (operation_id,restaurant_id) references public.inventory_operations(id,restaurant_id) deferrable initially deferred,
  check (delta_on_hand <> 0 or delta_reserved <> 0 or returned_quantity > 0 or initializes_balance)
);
create index inventory_movements_product_idx on public.inventory_movements(restaurant_id,product_id,created_at desc,id);
create table public.order_inventory_lines (
  order_item_id uuid primary key,
  restaurant_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  quantity bigint not null check (quantity > 0),
  foreign key (order_item_id,restaurant_id) references public.order_items(id,restaurant_id),
  foreign key (order_id,restaurant_id) references public.orders(id,restaurant_id),
  foreign key (product_id,restaurant_id) references public.products(id,restaurant_id)
);
create index order_inventory_lines_order_idx on public.order_inventory_lines(order_id,product_id);
create table public.inventory_counts (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  reason text not null,
  actor_user_id uuid not null references auth.users(id),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  finish_hash text,
  evidence jsonb,
  result jsonb,
  unique (id,restaurant_id)
);
create unique index inventory_one_open_count_idx on public.inventory_counts(restaurant_id) where finished_at is null;
alter table public.restaurants add foreign key (inventory_cutover_id,id) references public.inventory_counts(id,restaurant_id);

do $$
declare t text;
begin
  foreach t in array array['inventory_balances','inventory_operations','inventory_movements','order_inventory_lines','inventory_counts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    execute format('grant select on table public.%I to authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
    execute format('create policy inventory_tenant_read on public.%I for select to authenticated using (private.can_view_restaurant(restaurant_id))',t);
  end loop;
  foreach t in array array['inventory_operations','inventory_movements','order_inventory_lines'] loop
    execute format('create trigger inventory_append_only before update or delete on public.%I for each row execute function private.guard_append_only()',t);
  end loop;
end $$;

create function private.inventory_authorize(p_restaurant_id uuid,p_admin boolean default false,p_exclusive boolean default false)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null or not (case when p_admin then private.can_manage_restaurant(p_restaurant_id) else private.can_manage_orders(p_restaurant_id) end) then
    raise exception using errcode='42501',message='INVENTORY_FORBIDDEN';
  end if;
  perform p.id from public.profiles p where p.id=v_uid for share;
  perform pur.user_id from public.platform_user_roles pur where pur.user_id=v_uid for share;
  if p_exclusive then
    perform r.id from public.restaurants r where r.id=p_restaurant_id for update;
  else
    perform r.id from public.restaurants r where r.id=p_restaurant_id for share;
  end if;
  if not found then raise exception using errcode='42501',message='INVENTORY_FORBIDDEN'; end if;
  perform rm.id from public.restaurant_members rm where rm.restaurant_id=p_restaurant_id and rm.user_id=v_uid for share;
  if not (case when p_admin then private.can_manage_restaurant(p_restaurant_id) else private.can_manage_orders(p_restaurant_id) end) then
    raise exception using errcode='42501',message='INVENTORY_FORBIDDEN';
  end if;
  return v_uid;
end $$;

create function private.inventory_hash(p_value jsonb) returns text
language sql immutable security definer set search_path='' as $$
  select encode(extensions.digest(p_value::text,'sha256'),'hex')
$$;

-- Archiving catalogue visibility does not remove physical stock or obligations.
-- Use the same universe for display, pagination and mandatory physical counts.
create function private.inventory_product_in_scope(p_restaurant_id uuid,p_product_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.products p where p.restaurant_id=p_restaurant_id and p.id=p_product_id and (
    p.deleted_at is null
    or exists(select 1 from public.inventory_balances b where b.restaurant_id=p_restaurant_id and b.product_id=p.id)
    or exists(select 1 from public.order_items oi join public.orders o on o.id=oi.order_id and o.restaurant_id=oi.restaurant_id
      where oi.restaurant_id=p_restaurant_id and oi.product_id=p.id and o.status in ('generated','whatsapp_opened','accepted'))
  ))
$$;

-- Rows are aggregated/validated by the caller. All balances are locked before
-- any writes; a failure rolls the whole operation back, including its ledger.
create function private.inventory_apply(p_restaurant_id uuid,p_operation_id uuid,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row jsonb; v_balance public.inventory_balances%rowtype; v_result jsonb:='[]'; v_on bigint; v_reserved bigint; v_initial boolean;
begin
  perform b.product_id from public.inventory_balances b
  where b.restaurant_id=p_restaurant_id and b.product_id in (select (x->>'productId')::uuid from jsonb_array_elements(p_rows) x)
  order by b.product_id for update;
  for v_row in select x from jsonb_array_elements(p_rows) x order by (x->>'productId')::uuid loop
    v_initial:=coalesce((v_row->>'initialize')::boolean,false);
    select * into v_balance from public.inventory_balances b where b.restaurant_id=p_restaurant_id and b.product_id=(v_row->>'productId')::uuid;
    if not found then
      if not v_initial then raise exception using errcode='22023',message='INVENTORY_NOT_INITIALIZED'; end if;
      insert into public.inventory_balances(restaurant_id,product_id) values(p_restaurant_id,(v_row->>'productId')::uuid) returning * into v_balance;
    else
      v_initial:=false;
    end if;
    if v_row ? 'expectedVersion' and (v_row->>'expectedVersion')::bigint <> v_balance.version then
      raise exception using errcode='40001',message='INVENTORY_VERSION_CONFLICT';
    end if;
    v_on:=v_balance.on_hand+(v_row->>'deltaOnHand')::bigint;
    v_reserved:=v_balance.reserved+(v_row->>'deltaReserved')::bigint;
    if v_on<0 or v_reserved<0 or v_reserved>v_on then raise exception using errcode='22023',message='INSUFFICIENT_STOCK'; end if;
    if v_on<>v_balance.on_hand or v_reserved<>v_balance.reserved or v_initial or coalesce((v_row->>'returnedQuantity')::bigint,0)>0 then
      update public.inventory_balances set on_hand=v_on,reserved=v_reserved,version=version+1,updated_at=now()
      where restaurant_id=p_restaurant_id and product_id=v_balance.product_id returning * into v_balance;
      insert into public.inventory_movements(restaurant_id,product_id,operation_id,delta_on_hand,delta_reserved,returned_quantity,initializes_balance,on_hand_after,reserved_after)
      values(p_restaurant_id,v_balance.product_id,p_operation_id,(v_row->>'deltaOnHand')::bigint,(v_row->>'deltaReserved')::bigint,coalesce((v_row->>'returnedQuantity')::bigint,0),v_initial,v_on,v_reserved);
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('productId',v_balance.product_id,'onHand',v_balance.on_hand::text,'reserved',v_balance.reserved::text,'available',(v_balance.on_hand-v_balance.reserved)::text,'version',v_balance.version::text));
  end loop;
  return v_result;
end $$;

create function private.inventory_snapshot(p_order_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  if not exists(select 1 from public.order_items where order_id=p_order_id)
     or exists(select 1 from public.order_items where order_id=p_order_id and product_id is null) then
    raise exception using errcode='22023',message='INVENTORY_SNAPSHOT_INVALID';
  end if;
  insert into public.order_inventory_lines(order_item_id,restaurant_id,order_id,product_id,quantity)
  select id,restaurant_id,order_id,product_id,quantity from public.order_items where order_id=p_order_id
  on conflict(order_item_id) do nothing;
  if exists(select 1 from public.order_items oi left join public.order_inventory_lines il on il.order_item_id=oi.id
    where oi.order_id=p_order_id and (il.order_item_id is null or il.product_id is distinct from oi.product_id or il.quantity<>oi.quantity)) then
    raise exception using errcode='22023',message='INVENTORY_SNAPSHOT_INVALID';
  end if;
end $$;

create function private.inventory_order_operation(p_order_id uuid,p_kind text,p_actor uuid)
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
  select jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',case when p_kind='delivery' then -x.quantity else 0 end,
    'deltaReserved',case when p_kind='reserve' then x.quantity else -x.quantity end) order by x.product_id)
  into v_rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=p_order_id group by product_id) x;
  v_result:=jsonb_build_object('operationId',v_id,'kind',p_kind,'orderId',p_order_id,'items',private.inventory_apply(v_order.restaurant_id,v_id,v_rows));
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,result)
  values(v_id,v_order.restaurant_id,v_id,private.inventory_hash(jsonb_build_object('orderId',p_order_id,'kind',p_kind)),p_kind,p_order_id,p_kind,p_actor,v_result);
  return v_result;
end $$;

create function private.inventory_order_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_r public.restaurants%rowtype;
begin
  select * into v_r from public.restaurants where id=new.restaurant_id for share;
  if v_r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if v_r.inventory_mode='paused' then raise exception using errcode='22023',message='INVENTORY_PAUSED'; end if;
  new.inventory_tracked:=v_r.inventory_mode='enforced';
  new.inventory_policy_version:=case when new.inventory_tracked then v_r.inventory_version else null end;
  new.inventory_outcome:='none';
  new.replaces_order_id:=null; new.root_order_id:=null; new.replacement_reason:=null;
  return new;
end $$;
create trigger orders_inventory_policy before insert on public.orders for each row execute function private.inventory_order_insert_guard();
create function private.inventory_item_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (select inventory_tracked from public.orders where id=new.order_id) then
    if not exists(select 1 from public.inventory_balances where restaurant_id=new.restaurant_id and product_id=new.product_id) then
      raise exception using errcode='22023',message='INVENTORY_NOT_INITIALIZED';
    end if;
    insert into public.order_inventory_lines(order_item_id,restaurant_id,order_id,product_id,quantity)
    values(new.id,new.restaurant_id,new.order_id,new.product_id,new.quantity);
  end if;
  return new;
end $$;
create trigger order_items_inventory_snapshot after insert on public.order_items for each row execute function private.inventory_item_snapshot();

create function private.inventory_product_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_cutover uuid;
begin
  select inventory_cutover_id into v_cutover from public.restaurants where id=new.restaurant_id for share;
  if v_cutover is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  return new;
end $$;
create trigger products_inventory_cutover before insert on public.products for each row execute function private.inventory_product_insert_guard();

create function private.inventory_policy_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.inventory_activated_at is not null and (new.inventory_activated_at is distinct from old.inventory_activated_at or new.inventory_mode='never_enabled') then
    raise exception using errcode='22023',message='INVENTORY_ACTIVATION_IRREVERSIBLE';
  end if;
  if new.inventory_mode='enforced' and new.inventory_business_policy is null then
    raise exception using errcode='22023',message='INVENTORY_BUSINESS_POLICY_PENDING';
  end if;
  return new;
end $$;
create trigger restaurants_inventory_policy_guard before update on public.restaurants for each row execute function private.inventory_policy_guard();

-- Deferrable verification protects every order mutation route, not a caller-set
-- GUC. Only controlled RPCs have table write capabilities; legacy helpers become
-- private and lose EXECUTE for all client roles below.
create function private.inventory_order_integrity() returns trigger
language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype; r public.restaurants%rowtype;
begin
  select * into o from public.orders where id=new.id;
  select * into r from public.restaurants where id=o.restaurant_id;
  if o.inventory_tracked then
    perform private.inventory_snapshot(o.id);
    if o.status in ('accepted','completed') and not exists(select 1 from public.inventory_operations where order_id=o.id and kind='reserve') then raise exception 'INVENTORY_RESERVATION_MISSING'; end if;
    if o.status='completed' and not exists(select 1 from public.inventory_operations where order_id=o.id and kind='delivery') then raise exception 'INVENTORY_DELIVERY_MISSING'; end if;
    if o.status='cancelled' and exists(select 1 from public.inventory_operations where order_id=o.id and kind='reserve')
      and not exists(select 1 from public.inventory_operations where order_id=o.id and kind='release') then raise exception 'INVENTORY_RELEASE_MISSING'; end if;
  elsif r.inventory_mode<>'never_enabled' and o.status in ('generated','whatsapp_opened','accepted') then
    raise exception 'INVENTORY_LEGACY_PENDING';
  end if;
  return null;
end $$;
create constraint trigger orders_inventory_integrity after insert or update on public.orders
deferrable initially deferred for each row execute function private.inventory_order_integrity();

alter function public.claim_order(uuid) rename to claim_order_without_inventory;
alter function public.claim_order_without_inventory(uuid) set schema private;
alter function public.complete_order(uuid) rename to complete_order_without_inventory;
alter function public.complete_order_without_inventory(uuid) set schema private;
alter function public.cancel_order(uuid,text) rename to cancel_order_without_inventory;
alter function public.cancel_order_without_inventory(uuid,text) set schema private;
alter function private.order_admin_json(uuid) rename to order_admin_json_without_inventory;

create function private.order_admin_json(p_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select private.order_admin_json_without_inventory(o.id)||jsonb_build_object(
    'inventoryTracked',o.inventory_tracked,'inventoryOutcome',o.inventory_outcome,
    'replacesOrderId',o.replaces_order_id,'rootOrderId',coalesce(o.root_order_id,o.id),'replacementReason',o.replacement_reason,
    'replacementOrderId',(select x.id from public.orders x where x.replaces_order_id=o.id),
    'inventoryOperations',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'reason',x.reason,'createdAt',x.created_at,'actorUserId',x.actor_user_id,'result',x.result) order by x.created_at,x.id)
      from public.inventory_operations x where x.order_id=o.id),'[]'::jsonb))
  from public.orders o where o.id=p_order_id
$$;

create function private.inventory_lock_order(p_order_id uuid,p_admin boolean default false) returns public.orders
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype;
begin
  if auth.uid() is null then raise exception using errcode='28000',message='AUTHENTICATION_REQUIRED'; end if;
  select * into o from public.orders where id=p_order_id;
  if not found or not (case when p_admin then private.can_manage_restaurant(o.restaurant_id) else private.can_manage_orders(o.restaurant_id) end) then
    raise exception using errcode='42501',message='ORDER_NOT_FOUND_OR_FORBIDDEN';
  end if;
  begin
    perform private.inventory_authorize(o.restaurant_id,p_admin,false);
  exception when insufficient_privilege then
    raise exception using errcode='42501',message='ORDER_NOT_FOUND_OR_FORBIDDEN';
  end;
  select * into o from public.orders where id=p_order_id for update;
  return o;
end $$;
create function private.inventory_require_sales(p_restaurant_id uuid,p_tracked boolean) returns void
language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants%rowtype;
begin
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if r.inventory_mode='paused' then raise exception using errcode='22023',message='INVENTORY_PAUSED'; end if;
  if (r.inventory_mode='enforced') is distinct from p_tracked then raise exception using errcode='22023',message='INVENTORY_POLICY_MISMATCH'; end if;
end $$;

create function public.claim_order(p_action_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; v_id uuid; v_inventory jsonb;
begin
  select id into v_id from public.orders where action_id=p_action_id;
  o:=private.inventory_lock_order(v_id);
  if o.status in ('generated','whatsapp_opened') and (o.expires_at is null or o.expires_at>now()) then
    perform private.inventory_require_sales(o.restaurant_id,o.inventory_tracked);
    if o.inventory_tracked then v_inventory:=private.inventory_order_operation(o.id,'reserve',auth.uid()); end if;
  end if;
  return private.claim_order_without_inventory(p_action_id)||jsonb_build_object('inventory',v_inventory);
end $$;
create function public.complete_order(p_order_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; v_inventory jsonb;
begin
  o:=private.inventory_lock_order(p_order_id);
  if o.status='accepted' then
    perform private.inventory_require_sales(o.restaurant_id,o.inventory_tracked);
    if o.inventory_tracked then
      v_inventory:=private.inventory_order_operation(o.id,'delivery',auth.uid());
      perform set_config('app.order_mutation','on',true);
      update public.orders set inventory_outcome='delivered' where id=o.id;
    end if;
  elsif o.status='completed' and o.inventory_tracked then
    select result into v_inventory from public.inventory_operations where order_id=o.id and kind='delivery';
    if not found then raise exception using errcode='22023',message='INVENTORY_DELIVERY_MISSING'; end if;
  end if;
  return private.complete_order_without_inventory(p_order_id)||jsonb_build_object('inventory',v_inventory,'alreadyDelivered',o.status='completed');
end $$;
create function public.cancel_order(p_order_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; v_inventory jsonb;
begin
  o:=private.inventory_lock_order(p_order_id);
  if o.status in ('generated','whatsapp_opened','accepted') then
    if (select inventory_cutover_id from public.restaurants where id=o.restaurant_id) is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
    if o.inventory_tracked and o.status='accepted' then v_inventory:=private.inventory_order_operation(o.id,'release',auth.uid()); end if;
  end if;
  return private.cancel_order_without_inventory(p_order_id,p_reason)||jsonb_build_object('inventory',v_inventory);
end $$;

create function public.confirm_inventory_business_policy(p_restaurant_id uuid,p_policy jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; v_actor uuid;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  -- These values describe the supported implementation, not presumed business
  -- decisions. A responsible administrator must explicitly confirm all of them.
  if p_policy is null or jsonb_typeof(p_policy)<>'object'
    or p_policy->>'unitModel' is distinct from 'whole_product'
    or p_policy->>'sourceOfTruth' is distinct from 'app'
    or coalesce(p_policy->>'otherChannels','') not in ('none','record_before_handoff')
    or p_policy->>'returns' is distinct from 'full_only'
    or p_policy->>'partialDeliveries' is distinct from 'none'
    or p_policy->>'physicalScope' is distinct from 'until_handoff_including_transit'
    or p_policy->>'acceptance' is distinct from 'reserve'
    or p_policy->>'delivery' is distinct from 'physical_handoff'
    or p_policy->'acceptedReservationsExpire' is distinct from 'false'::jsonb then
    raise exception using errcode='22023',message='INVENTORY_BUSINESS_POLICY_UNSUPPORTED';
  end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_business_policy is not null then
    if r.inventory_business_policy<>p_policy then raise exception using errcode='22023',message='INVENTORY_BUSINESS_POLICY_ALREADY_CONFIRMED'; end if;
    return p_policy;
  end if;
  update public.restaurants set inventory_business_policy=p_policy where id=p_restaurant_id;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(p_restaurant_id,v_actor,'update','inventory_business_policy',p_restaurant_id,p_policy);
  return p_policy;
end $$;

create function public.begin_inventory_count(p_restaurant_id uuid,p_operation_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; c public.inventory_counts%rowtype; v_actor uuid;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  if p_operation_id is null or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID'; end if;
  select * into c from public.inventory_counts where restaurant_id=p_restaurant_id and id=p_operation_id;
  if found then
    if c.reason<>btrim(p_reason) then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('countId',c.id,'startedAt',c.started_at,'finishedAt',c.finished_at);
  end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_mode='enforced' then raise exception using errcode='22023',message='INVENTORY_PAUSE_REQUIRED'; end if;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  insert into public.inventory_counts(id,restaurant_id,reason,actor_user_id) values(p_operation_id,p_restaurant_id,btrim(p_reason),v_actor) returning * into c;
  update public.restaurants set inventory_cutover_id=c.id,inventory_version=inventory_version+1 where id=p_restaurant_id;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,v_actor,'create','inventory_count',c.id,jsonb_build_object('startedAt',c.started_at,'reason',c.reason));
  return jsonb_build_object('countId',c.id,'startedAt',c.started_at,'finishedAt',null);
end $$;

create function public.finish_inventory_count(
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
     or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 5000 or pg_column_size(p_rows)>2097152 then
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
  if exists(select 1 from public.products p where p.restaurant_id=c.restaurant_id and private.inventory_product_in_scope(c.restaurant_id,p.id) and not exists(select 1 from jsonb_array_elements(p_rows) x where (x->>'productId')::uuid=p.id)) then
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

create function public.change_inventory_policy(p_restaurant_id uuid,p_mode text,p_reason text,p_expected_policy_version bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; v_actor uuid;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,true);
  select * into r from public.restaurants where id=p_restaurant_id;
  if coalesce(p_mode,'') not in ('paused','enforced') or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID'; end if;
  if p_expected_policy_version is null then raise exception using errcode='22023',message='INVENTORY_VERSION_REQUIRED'; end if;
  -- Check the reviewed version under the policy lock, even for a same-mode call.
  -- A lost-response retry must never replay a pause/resume over a later review.
  if r.inventory_version<>p_expected_policy_version then raise exception using errcode='40001',message='INVENTORY_VERSION_CONFLICT'; end if;
  if r.inventory_mode='never_enabled' then raise exception using errcode='22023',message='INVENTORY_INITIAL_COUNT_REQUIRED'; end if;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if r.inventory_mode=p_mode then return jsonb_build_object('mode',r.inventory_mode,'version',r.inventory_version::text,'changed',false); end if;
  if p_mode='enforced' and not exists(select 1 from public.inventory_counts where restaurant_id=p_restaurant_id and finished_at>=r.inventory_paused_at) then
    raise exception using errcode='22023',message='INVENTORY_RECONCILIATION_REQUIRED';
  end if;
  update public.restaurants set inventory_mode=p_mode,inventory_paused_at=case when p_mode='paused' then clock_timestamp() else inventory_paused_at end,inventory_version=inventory_version+1 where id=p_restaurant_id returning * into r;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,v_actor,case when p_mode='paused' then 'suspend'::public.audit_action else 'activate'::public.audit_action end,'inventory_policy',p_restaurant_id,jsonb_build_object('mode',p_mode,'reason',p_reason,'version',r.inventory_version));
  return jsonb_build_object('mode',r.inventory_mode,'version',r.inventory_version::text,'changed',true);
end $$;

create function public.inventory_adjust(
  p_restaurant_id uuid,p_operation_id uuid,p_kind text,p_rows jsonb,p_reason text,p_external_reference text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; op public.inventory_operations%rowtype; v_actor uuid; v_hash text; v_rows jsonb:='[]'; x jsonb; q bigint; v_result jsonb;
begin
  v_actor:=private.inventory_authorize(p_restaurant_id,true,false);
  if p_operation_id is null or coalesce(p_kind,'') not in ('receipt','adjustment','external_sale')
    or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500
    or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 5000 or pg_column_size(p_rows)>2097152 then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_restaurant_id::text),hashtext(p_operation_id::text));
  v_hash:=private.inventory_hash(jsonb_build_object('kind',p_kind,'rows',p_rows,'reason',p_reason,'externalReference',p_external_reference));
  select * into op from public.inventory_operations where restaurant_id=p_restaurant_id and idempotency_key=p_operation_id;
  if found then
    if op.request_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return op.result||jsonb_build_object('replayed',true);
  end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  if r.inventory_cutover_id is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if r.inventory_mode='never_enabled' then raise exception using errcode='22023',message='INVENTORY_NOT_ENABLED'; end if;
  if p_kind='external_sale' then
    if r.inventory_mode='paused' then raise exception using errcode='22023',message='INVENTORY_PAUSED'; end if;
    if r.inventory_business_policy->>'otherChannels' is distinct from 'record_before_handoff' then raise exception using errcode='22023',message='INVENTORY_EXTERNAL_CHANNELS_DISABLED'; end if;
    if char_length(btrim(coalesce(p_external_reference,''))) not between 3 and 120 then raise exception using errcode='22023',message='INVENTORY_EXTERNAL_REFERENCE_REQUIRED'; end if;
    perform pg_advisory_xact_lock(hashtext('inventory-external:'||p_restaurant_id::text),hashtext(btrim(p_external_reference)));
    if exists(select 1 from public.inventory_operations where restaurant_id=p_restaurant_id and kind='external_sale' and external_reference=btrim(p_external_reference)) then raise exception using errcode='22023',message='INVENTORY_EXTERNAL_REFERENCE_DUPLICATE'; end if;
    if exists(select 1 from public.orders where restaurant_id=p_restaurant_id and (id::text=btrim(p_external_reference) or display_number=btrim(p_external_reference))) then raise exception using errcode='22023',message='INVENTORY_EXTERNAL_ORDER_DUPLICATE'; end if;
  end if;
  if (select count(distinct value->>'productId') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) then raise exception using errcode='22023',message='INVENTORY_DUPLICATE_PRODUCT'; end if;
  for x in select value from jsonb_array_elements(p_rows) loop
    if coalesce(x->>'quantity','')!~'^-?[0-9]{1,13}$' then raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID'; end if;
    q:=(x->>'quantity')::bigint;
    if q=0 or (p_kind<>'adjustment' and q<0) then raise exception using errcode='22023',message='INVENTORY_QUANTITY_INVALID'; end if;
    if not exists(select 1 from public.products where id=(x->>'productId')::uuid and restaurant_id=p_restaurant_id) then raise exception using errcode='22023',message='INVENTORY_PRODUCT_INVALID'; end if;
    if coalesce(x->>'expectedVersion','')!~'^[0-9]+$' then raise exception using errcode='22023',message='INVENTORY_VERSION_REQUIRED'; end if;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('productId',(x->>'productId')::uuid,'deltaOnHand',case when p_kind='external_sale' then -q else q end,'deltaReserved',0)
      ||case when x?'expectedVersion' then jsonb_build_object('expectedVersion',x->'expectedVersion') else '{}'::jsonb end);
  end loop;
  v_result:=jsonb_build_object('operationId',p_operation_id,'kind',p_kind,'items',private.inventory_apply(p_restaurant_id,p_operation_id,v_rows),'replayed',false);
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,external_reference,reason,actor_user_id,result)
  values(p_operation_id,p_restaurant_id,p_operation_id,v_hash,p_kind,case when p_kind='external_sale' then btrim(p_external_reference) else null end,btrim(p_reason),v_actor,v_result);
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,v_actor,'update','inventory_operation',p_operation_id,jsonb_build_object('kind',p_kind,'reason',p_reason));
  return v_result;
end $$;

create function public.reverse_order_inventory(p_order_id uuid,p_operation_id uuid,p_kind text,p_restock boolean,p_reason text,p_restock_quantities jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; source public.inventory_operations%rowtype; op public.inventory_operations%rowtype; v_rows jsonb; v_hash text; v_result jsonb;
begin
  o:=private.inventory_lock_order(p_order_id,true);
  if p_operation_id is null or coalesce(p_kind,'') not in ('correction','return') or p_restock is null
    or (p_kind='correction' and not p_restock) or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID';
  end if;
  select * into source from public.inventory_operations where order_id=o.id and kind='delivery' for update;
  if not found then raise exception using errcode='22023',message='INVENTORY_DELIVERY_MISSING'; end if;
  perform pg_advisory_xact_lock(hashtext(o.restaurant_id::text),hashtext(p_operation_id::text));
  v_hash:=private.inventory_hash(jsonb_build_object('orderId',o.id,'kind',p_kind,'restock',p_restock,'reason',p_reason,'restockQuantities',p_restock_quantities));
  select * into op from public.inventory_operations where restaurant_id=o.restaurant_id and idempotency_key=p_operation_id;
  if found then
    if op.request_hash<>v_hash then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return op.result||jsonb_build_object('replayed',true);
  end if;
  if (select inventory_cutover_id from public.restaurants where id=o.restaurant_id) is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
  if o.status<>'completed' or o.inventory_outcome<>'delivered' or exists(select 1 from public.inventory_operations where source_operation_id=source.id) then
    raise exception using errcode='22023',message='INVENTORY_ALREADY_REVERSED';
  end if;
  if p_restock_quantities is not null then
    if p_kind<>'return' or not p_restock or jsonb_typeof(p_restock_quantities)<>'array' or jsonb_array_length(p_restock_quantities) not between 1 and 5000 then
      raise exception using errcode='22023',message='INVENTORY_RETURN_QUANTITIES_INVALID';
    end if;
    if (select count(distinct x->>'productId') from jsonb_array_elements(p_restock_quantities) x)<>jsonb_array_length(p_restock_quantities)
      or jsonb_array_length(p_restock_quantities)<>(select count(*) from public.inventory_movements where operation_id=source.id)
      or exists(select 1 from jsonb_array_elements(p_restock_quantities) x where coalesce(x->>'quantity','')!~'^[0-9]{1,13}$') then
      raise exception using errcode='22023',message='INVENTORY_RETURN_QUANTITIES_INVALID';
    end if;
    if exists(select 1 from jsonb_array_elements(p_restock_quantities) x where not exists(select 1 from public.inventory_movements m
      where m.operation_id=source.id and m.product_id=(x->>'productId')::uuid and (x->>'quantity')::bigint<=-m.delta_on_hand)) then
      raise exception using errcode='22023',message='INVENTORY_RETURN_QUANTITIES_INVALID';
    end if;
  end if;
  select jsonb_agg(jsonb_build_object('productId',m.product_id,'deltaOnHand',case when p_restock_quantities is not null then
      (select (x->>'quantity')::bigint from jsonb_array_elements(p_restock_quantities) x where (x->>'productId')::uuid=m.product_id)
      when p_restock then -m.delta_on_hand else 0 end,
    'deltaReserved',0,'returnedQuantity',case when p_kind='return' then -m.delta_on_hand else 0 end) order by m.product_id)
  into v_rows from public.inventory_movements m where m.operation_id=source.id;
  v_result:=jsonb_build_object('operationId',p_operation_id,'kind',p_kind,'orderId',o.id,'sourceOperationId',source.id,'restocked',p_restock,'restockQuantities',p_restock_quantities,
    'items',private.inventory_apply(o.restaurant_id,p_operation_id,v_rows),'replayed',false);
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,source_operation_id,reason,actor_user_id,result)
  values(p_operation_id,o.restaurant_id,p_operation_id,v_hash,p_kind,o.id,source.id,btrim(p_reason),auth.uid(),v_result);
  perform set_config('app.order_mutation','on',true);
  update public.orders set inventory_outcome=case when p_kind='correction' then 'corrected' else 'returned' end where id=o.id;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(o.restaurant_id,auth.uid(),'update','inventory_reversal',o.id,jsonb_build_object('operationId',p_operation_id,'sourceOperationId',source.id,'kind',p_kind,'reason',p_reason));
  return v_result;
end $$;

create function public.link_order_replacement(p_original_order_id uuid,p_replacement_order_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare original public.orders%rowtype; replacement public.orders%rowtype;
begin
  select * into original from public.orders where id=p_original_order_id;
  if not found then raise exception using errcode='42501',message='ORDER_NOT_FOUND_OR_FORBIDDEN'; end if;
  perform private.inventory_authorize(original.restaurant_id,true,false);
  perform id from public.orders where id in (p_original_order_id,p_replacement_order_id) order by id for update;
  select * into original from public.orders where id=p_original_order_id;
  select * into replacement from public.orders where id=p_replacement_order_id;
  if not found or replacement.restaurant_id<>original.restaurant_id then raise exception using errcode='42501',message='ORDER_NOT_FOUND_OR_FORBIDDEN'; end if;
  if p_original_order_id=p_replacement_order_id or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception using errcode='22023',message='INVENTORY_INPUT_INVALID'; end if;
  if replacement.replaces_order_id=original.id then
    if replacement.replacement_reason<>btrim(p_reason) then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('originalOrderId',original.id,'replacementOrderId',replacement.id,'rootOrderId',replacement.root_order_id,'changed',false);
  end if;
  if original.inventory_outcome not in ('corrected','returned') or original.status<>'completed'
    or replacement.status not in ('generated','whatsapp_opened') or replacement.replaces_order_id is not null
    or exists(select 1 from public.orders where replaces_order_id=original.id)
    or replacement.id=coalesce(original.root_order_id,original.id) then raise exception using errcode='22023',message='INVENTORY_REPLACEMENT_INVALID'; end if;
  -- A fresh pending order cannot be an ancestor of a completed original. The
  -- tenant FK and unique predecessor index additionally rule out cross-tenant
  -- references and competing successors.
  perform set_config('app.order_mutation','on',true);
  update public.orders set replaces_order_id=original.id,root_order_id=coalesce(original.root_order_id,original.id),replacement_reason=btrim(p_reason) where id=replacement.id;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(original.restaurant_id,auth.uid(),'update','order_replacement',replacement.id,jsonb_build_object('originalOrderId',original.id,'rootOrderId',coalesce(original.root_order_id,original.id),'reason',p_reason));
  return jsonb_build_object('originalOrderId',original.id,'replacementOrderId',replacement.id,'rootOrderId',coalesce(original.root_order_id,original.id),'changed',true);
end $$;

create function public.get_inventory(p_restaurant_id uuid,p_after uuid default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants%rowtype; v_items jsonb; v_next uuid;
begin
  if auth.uid() is null or not private.can_view_restaurant(p_restaurant_id) then raise exception using errcode='42501',message='INVENTORY_FORBIDDEN'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception using errcode='22023',message='LIMIT_INVALID'; end if;
  select * into r from public.restaurants where id=p_restaurant_id;
  select coalesce(jsonb_agg(jsonb_build_object('productId',p.id,'code',p.code,'name',p.name,'archived',p.deleted_at is not null,'initialized',b.product_id is not null,
    'onHand',b.on_hand::text,'reserved',b.reserved::text,'available',(b.on_hand-b.reserved)::text,'version',b.version::text) order by p.id),'[]'::jsonb)
  into v_items from (select * from public.products where restaurant_id=p_restaurant_id and private.inventory_product_in_scope(p_restaurant_id,id) and (p_after is null or id>p_after) order by id limit p_limit) p
  left join public.inventory_balances b on b.restaurant_id=p.restaurant_id and b.product_id=p.id;
  if jsonb_array_length(v_items)=p_limit then
    v_next:=(v_items->(p_limit-1)->>'productId')::uuid;
    if not exists(select 1 from public.products where restaurant_id=p_restaurant_id and private.inventory_product_in_scope(p_restaurant_id,id) and id>v_next) then v_next:=null; end if;
  end if;
  return jsonb_build_object('policy',jsonb_build_object('mode',r.inventory_mode,'version',r.inventory_version::text,'activatedAt',r.inventory_activated_at,'pausedAt',r.inventory_paused_at,
    'cutoverId',r.inventory_cutover_id,'countStartedAt',(select started_at from public.inventory_counts where id=r.inventory_cutover_id),
    'businessConfirmed',r.inventory_business_policy is not null,'businessPolicy',r.inventory_business_policy),
    'items',v_items,'nextCursor',v_next,
    'operations',coalesce((select jsonb_agg(x.row order by x.created_at desc,x.id desc) from (select op.id,op.created_at,jsonb_build_object('id',op.id,'kind',op.kind,'orderId',op.order_id,'sourceOperationId',op.source_operation_id,'reason',op.reason,'actorUserId',op.actor_user_id,'actorName',(select full_name from public.profiles where id=op.actor_user_id),'createdAt',op.created_at,'result',op.result,
      'movements',coalesce((select jsonb_agg(jsonb_build_object('productId',m.product_id,'deltaOnHand',m.delta_on_hand::text,'deltaReserved',m.delta_reserved::text,'returnedQuantity',m.returned_quantity::text,'onHandAfter',m.on_hand_after::text,'reservedAfter',m.reserved_after::text) order by m.product_id) from public.inventory_movements m where m.operation_id=op.id),'[]'::jsonb)) row
      from public.inventory_operations op where op.restaurant_id=p_restaurant_id order by op.created_at desc,op.id desc limit 100) x),'[]'::jsonb));
end $$;

alter function public.get_public_menu(text) rename to get_public_menu_without_inventory;
alter function public.get_public_menu_without_inventory(text) set schema private;
create function public.get_public_menu(p_restaurant_slug text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; r public.restaurants%rowtype; c jsonb; p jsonb; v_categories jsonb:='[]'; v_products jsonb;
begin
  v_result:=private.get_public_menu_without_inventory(p_restaurant_slug);
  if v_result is null then return null; end if;
  select * into r from public.restaurants where id=(v_result#>>'{restaurant,id}')::uuid;
  if r.inventory_mode='never_enabled' and r.inventory_cutover_id is null then return v_result; end if;
  for c in select value from jsonb_array_elements(v_result->'categories') loop
    v_products:='[]';
    for p in select value from jsonb_array_elements(c->'products') loop
      v_products:=v_products||jsonb_build_array(p||jsonb_build_object('available',coalesce((p->>'available')::boolean,true)
        and r.inventory_mode='enforced' and r.inventory_cutover_id is null
        and exists(select 1 from public.inventory_balances b where b.restaurant_id=r.id and b.product_id=(p->>'id')::uuid and b.on_hand>b.reserved)));
    end loop;
    v_categories:=v_categories||jsonb_build_array(jsonb_set(c,'{products}',v_products));
  end loop;
  return jsonb_set(v_result,'{categories}',v_categories);
end $$;

-- Preserve the existing report shape while distinguishing the currently valid
-- delivery from historical completed rows. Date attribution stays explicit:
-- existing aggregates use order creation; new delivery totals use completed_at.
alter function public.get_order_metrics(uuid,timestamptz,timestamptz) rename to get_order_metrics_without_inventory;
alter function public.get_order_metrics_without_inventory(uuid,timestamptz,timestamptz) set schema private;
create function public.get_order_metrics(p_restaurant_id uuid,p_from timestamptz,p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; corrected bigint; returned bigint;
begin
  result:=private.get_order_metrics_without_inventory(p_restaurant_id,p_from,p_to);
  select count(*) filter(where inventory_outcome='corrected'),count(*) filter(where inventory_outcome='returned') into corrected,returned
  from public.orders where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to;
  return result||jsonb_build_object(
    'completed',(result->>'completed')::bigint-corrected-returned,'corrected',corrected,'returned',returned,
    'completedAmountCents',(select coalesce(sum(total_cents),0)::text from public.orders where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to and status='completed' and inventory_outcome not in ('corrected','returned')),
    'acceptedAmountCents',(select coalesce(sum(total_cents),0)::text from public.orders where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to and status in ('accepted','completed') and inventory_outcome not in ('corrected','returned')),
    'byPaymentMethod',coalesce((select jsonb_agg(jsonb_build_object('name',x.payment_method_name_snapshot,'count',x.quantity,'amountCents',x.amount_cents::text) order by x.payment_method_name_snapshot)
      from (select payment_method_name_snapshot,count(*) quantity,sum(total_cents) amount_cents from public.orders where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to and status in ('accepted','completed') and inventory_outcome not in ('corrected','returned') group by payment_method_name_snapshot) x),'[]'::jsonb),
    'validDeliveredByCompletionDate',(select count(*) from public.orders where restaurant_id=p_restaurant_id and completed_at>=p_from and completed_at<p_to and status='completed' and inventory_outcome not in ('corrected','returned')),
    'validDeliveredCommercialCases',(select count(distinct coalesce(root_order_id,id)) from public.orders where restaurant_id=p_restaurant_id and completed_at>=p_from and completed_at<p_to and status='completed' and inventory_outcome not in ('corrected','returned')),
    'physicalDispatches',(select count(*) from public.inventory_operations delivery where delivery.restaurant_id=p_restaurant_id and delivery.kind='delivery' and delivery.created_at>=p_from and delivery.created_at<p_to and not exists(select 1 from public.inventory_operations correction where correction.source_operation_id=delivery.id and correction.kind='correction')),
    'receivedReturnUnits',(select coalesce(sum(returned_quantity),0)::text from public.inventory_movements where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to),
    'sellableRestockedReturnUnits',(select coalesce(sum(m.delta_on_hand),0)::text from public.inventory_movements m join public.inventory_operations op on op.id=m.operation_id where m.restaurant_id=p_restaurant_id and m.created_at>=p_from and m.created_at<p_to and op.kind='return'),
    'inventoryMovementTotals',coalesce((select jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',x.delta_on_hand::text,'deltaReserved',x.delta_reserved::text,'returnedQuantity',x.returned_quantity::text)) from (
      select product_id,sum(delta_on_hand) delta_on_hand,sum(delta_reserved) delta_reserved,sum(returned_quantity) returned_quantity from public.inventory_movements where restaurant_id=p_restaurant_id and created_at>=p_from and created_at<p_to group by product_id) x),'[]'::jsonb));
end $$;

-- Private implementation paths are never callable using an API role. Global
-- default privileges already deny new EXECUTE; repeat explicit ACLs here.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and (p.proname like 'inventory_%' or p.proname in ('claim_order_without_inventory','complete_order_without_inventory','cancel_order_without_inventory','order_admin_json','order_admin_json_without_inventory','get_public_menu_without_inventory','get_order_metrics_without_inventory')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('get_inventory','confirm_inventory_business_policy','begin_inventory_count','finish_inventory_count','change_inventory_policy','inventory_adjust','reverse_order_inventory','link_order_replacement','claim_order','complete_order','cancel_order','get_order_metrics') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
revoke all on function public.get_public_menu(text) from public,anon,authenticated,service_role;
grant execute on function public.get_public_menu(text) to anon,authenticated;
