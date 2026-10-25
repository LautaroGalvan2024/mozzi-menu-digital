-- O03: bind an idempotency key to the complete normalized business request.
-- Volatile anti-spam data, token expiry, transport hashes and untrusted prices are excluded.
create table private.order_request_receipts (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  idempotency_key uuid not null,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key(restaurant_id,idempotency_key)
);
create table private.order_client_event_token_history (
  order_id uuid not null references public.orders(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  primary key(order_id,token_hash)
);
revoke all on private.order_request_receipts,private.order_client_event_token_history
  from public,anon,authenticated,service_role;

create function private.order_request_fingerprint(p_request jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare v_items jsonb; v_fulfillment jsonb; v_type text := p_request #>> '{fulfillment,type}';
begin
  -- Match the pricing identity: sorted UUID options, trimmed notes, aggregated equal lines.
  -- JSONB object order, option order and split identical lines do not change the intent.
  with requested as (
    select (item->>'productId')::uuid as product_id,(item->>'quantity')::integer as quantity,
      nullif(btrim(item->>'notes'),'') as notes,
      (select coalesce(jsonb_agg((option_id::uuid)::text order by (option_id::uuid)::text),'[]'::jsonb)
       from jsonb_array_elements_text(coalesce(item->'optionIds','[]'::jsonb)) selected(option_id)) as options
    from jsonb_array_elements(p_request->'items') item
  ), grouped as (
    select product_id,sum(quantity) as quantity,notes,options
    from requested group by product_id,notes,options
  ) select coalesce(jsonb_agg(jsonb_build_object('productId',product_id,'quantity',quantity,
      'notes',notes,'optionIds',options) order by product_id,options::text,notes),'[]'::jsonb)
    into v_items from grouped;
  v_fulfillment := jsonb_build_object('type',v_type);
  if v_type='delivery' then
    v_fulfillment := v_fulfillment || jsonb_build_object(
      'deliveryZoneId',(p_request #>> '{fulfillment,deliveryZoneId}')::uuid,
      'address',nullif(btrim(p_request #>> '{fulfillment,address}'),''),
      'city',nullif(btrim(p_request #>> '{fulfillment,city}'),''),
      'neighborhood',nullif(btrim(p_request #>> '{fulfillment,neighborhood}'),''),
      'floor',nullif(btrim(p_request #>> '{fulfillment,floor}'),''),
      'apartment',nullif(btrim(p_request #>> '{fulfillment,apartment}'),''),
      'reference',nullif(btrim(p_request #>> '{fulfillment,reference}'),''));
  end if;
  return encode(extensions.digest(convert_to(jsonb_build_object(
    'version',1,'restaurantSlug',lower(btrim(p_request->>'restaurantSlug')),
    'customer',jsonb_build_object('name',btrim(p_request #>> '{customer,name}'),
      'phone',btrim(p_request #>> '{customer,phone}')),
    'fulfillment',v_fulfillment,'paymentMethodId',(p_request->>'paymentMethodId')::uuid,
    'notes',nullif(btrim(p_request->>'notes'),''),'items',v_items)::text,'UTF8'),'sha256'),'hex');
end;
$$;

create function private.order_request_snapshot(p_order_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when o.payment_method_id is null
      or (o.fulfillment_type='delivery' and o.delivery_zone_id is null)
      or not exists(select 1 from public.order_items i where i.order_id=o.id)
      or exists(select 1 from public.order_items i where i.order_id=o.id and i.product_id is null)
      or exists(select 1 from public.order_item_options x join public.order_items i on i.id=x.order_item_id
        where i.order_id=o.id and x.product_option_id is null)
    then null else jsonb_build_object(
      'restaurantSlug',r.slug,'customer',jsonb_build_object('name',o.customer_name,'phone',o.customer_phone),
      'fulfillment',jsonb_build_object('type',o.fulfillment_type,'deliveryZoneId',o.delivery_zone_id,
        'address',o.delivery_address,'city',o.delivery_city,'neighborhood',o.delivery_neighborhood,
        'floor',o.delivery_floor,'apartment',o.delivery_apartment,'reference',o.delivery_reference),
      'paymentMethodId',o.payment_method_id,'notes',o.customer_notes,
      'items',(select jsonb_agg(jsonb_build_object('productId',i.product_id,'quantity',i.quantity,'notes',i.notes,
        'optionIds',(select coalesce(jsonb_agg(x.product_option_id order by x.product_option_id),'[]'::jsonb)
          from public.order_item_options x where x.order_item_id=i.id)) order by i.id)
        from public.order_items i where i.order_id=o.id)) end
  from public.orders o join public.restaurants r on r.id=o.restaurant_id where o.id=p_order_id
$$;

-- Verify legacy retries from immutable request snapshots, never from the changed request.
insert into private.order_request_receipts(restaurant_id,idempotency_key,order_id,request_hash)
select o.restaurant_id,o.idempotency_key,o.id,private.order_request_fingerprint(s.request)
from public.orders o cross join lateral(select private.order_request_snapshot(o.id) request) s
where s.request is not null;
insert into private.order_client_event_token_history(order_id,token_hash,expires_at)
select order_id,token_hash,expires_at from private.order_client_event_tokens where expires_at>now();

alter function public.create_order_transaction(jsonb,text,text,text) rename to create_order_transaction_without_request_hash;
alter function public.create_order_transaction_without_request_hash(jsonb,text,text,text) set schema private;
revoke all on function private.create_order_transaction_without_request_hash(jsonb,text,text,text)
  from public,anon,authenticated,service_role;

create function public.create_order_transaction(p_request jsonb,p_ip_hash text,p_phone_hash text,p_client_event_token_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_restaurant uuid; v_key uuid; v_order uuid; v_hash text; v_saved text; v_snapshot jsonb; v_result jsonb;
begin
  if jsonb_typeof(p_request) is distinct from 'object' or pg_column_size(p_request)>131072 then
    raise exception using errcode='22023',message='ORDER_PAYLOAD_INVALID';
  end if;
  if p_ip_hash is null or p_phone_hash is null or p_client_event_token_hash is null
    or p_ip_hash !~ '^[0-9a-f]{64}$' or p_phone_hash !~ '^[0-9a-f]{64}$'
    or p_client_event_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='HASH_ARGUMENT_INVALID';
  end if;
  select id into v_restaurant from public.restaurants
  where slug=lower(btrim(p_request->>'restaurantSlug')) and status='active' and public_menu_enabled for share;
  if not found then raise exception using errcode='22023',message='RESTAURANT_NOT_AVAILABLE'; end if;
  begin v_key := (p_request->>'idempotencyKey')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode='22023',message='IDEMPOTENCY_KEY_INVALID'; end;
  if v_key is null then raise exception using errcode='22023',message='IDEMPOTENCY_KEY_INVALID'; end if;
  -- Serialize only this tenant/key. Restaurant policy is acquired before intent/order locks.
  perform pg_advisory_xact_lock(hashtextextended('order-intent:'||v_restaurant::text||':'||v_key::text,0));
  select id into v_order from public.orders where restaurant_id=v_restaurant and idempotency_key=v_key for update;
  if found then
    begin v_hash := private.order_request_fingerprint(p_request);
    exception when others then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end;
    select request_hash into v_saved from private.order_request_receipts
    where restaurant_id=v_restaurant and idempotency_key=v_key;
    if not found then
      -- Covers an old RPC transaction that committed across the deployment boundary.
      v_snapshot := private.order_request_snapshot(v_order);
      if v_snapshot is null then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
      v_saved := private.order_request_fingerprint(v_snapshot);
      insert into private.order_request_receipts(restaurant_id,idempotency_key,order_id,request_hash)
      values(v_restaurant,v_key,v_order,v_saved);
    end if;
    if v_hash is distinct from v_saved then
      raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT';
    end if;
    -- Preserve the token from a response still in flight before the old RPC rotates it.
    insert into private.order_client_event_token_history(order_id,token_hash,expires_at)
    select order_id,token_hash,expires_at from private.order_client_event_tokens
    where order_id=v_order and expires_at>now()
    on conflict(order_id,token_hash) do update set expires_at=greatest(excluded.expires_at,private.order_client_event_token_history.expires_at);
  end if;
  v_result := private.create_order_transaction_without_request_hash(p_request,p_ip_hash,p_phone_hash,p_client_event_token_hash);
  if v_order is null then
    select id into strict v_order from public.orders where restaurant_id=v_restaurant and idempotency_key=v_key;
    v_hash := private.order_request_fingerprint(p_request);
    insert into private.order_request_receipts(restaurant_id,idempotency_key,order_id,request_hash)
    values(v_restaurant,v_key,v_order,v_hash);
  end if;
  insert into private.order_client_event_token_history(order_id,token_hash,expires_at)
  select order_id,token_hash,expires_at from private.order_client_event_tokens
  where order_id=v_order and expires_at>now()
  on conflict(order_id,token_hash) do update set expires_at=greatest(excluded.expires_at,private.order_client_event_token_history.expires_at);
  delete from private.order_client_event_token_history where order_id=v_order and expires_at<=now();
  return v_result;
end;
$$;

alter function public.register_whatsapp_opened(uuid,text) rename to register_whatsapp_opened_single_token;
alter function public.register_whatsapp_opened_single_token(uuid,text) set schema private;
revoke all on function private.register_whatsapp_opened_single_token(uuid,text) from public,anon,authenticated,service_role;
create function public.register_whatsapp_opened(p_action_id uuid,p_token_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_order uuid; v_restaurant uuid; v_expires timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('registered',false,'code','INVALID_OR_EXPIRED_TOKEN');
  end if;
  select restaurant_id into v_restaurant from public.orders where action_id=p_action_id;
  if not found then return jsonb_build_object('registered',false,'code','INVALID_OR_EXPIRED_TOKEN'); end if;
  perform 1 from public.restaurants where id=v_restaurant for share;
  select id into v_order from public.orders where action_id=p_action_id for update;
  select max(expires_at) into v_expires from (
    select expires_at from private.order_client_event_token_history where order_id=v_order and token_hash=p_token_hash
    union all
    select expires_at from private.order_client_event_tokens where order_id=v_order and token_hash=p_token_hash
  ) valid_tokens;
  if v_expires is null or v_expires<=now() then
    return jsonb_build_object('registered',false,'code','INVALID_OR_EXPIRED_TOKEN');
  end if;
  insert into private.order_client_event_token_history(order_id,token_hash,expires_at)
  select order_id,token_hash,expires_at from private.order_client_event_tokens where order_id=v_order and expires_at>now()
  on conflict(order_id,token_hash) do update set expires_at=greatest(excluded.expires_at,private.order_client_event_token_history.expires_at);
  update private.order_client_event_tokens set token_hash=p_token_hash,expires_at=v_expires where order_id=v_order;
  -- The existing order lock and shared used_at keep event/state mutation exactly once.
  return private.register_whatsapp_opened_single_token(p_action_id,p_token_hash);
end;
$$;
revoke all on function private.order_request_fingerprint(jsonb),private.order_request_snapshot(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.create_order_transaction(jsonb,text,text,text),public.register_whatsapp_opened(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_order_transaction(jsonb,text,text,text),public.register_whatsapp_opened(uuid,text) to service_role;
