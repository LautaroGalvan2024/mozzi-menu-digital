-- One catalogue, independently published menu/store channels. Legacy requests
-- retain their v1 fingerprint and the existing menu URL remains valid.
alter table public.restaurants
  add column store_enabled boolean not null default false,
  add column store_ordering_policy text not null default 'always' check (store_ordering_policy in ('always','business_hours')),
  add column store_checkout_whatsapp_enabled boolean not null default true,
  add column store_checkout_online_enabled boolean not null default false;
grant update(store_enabled,store_ordering_policy,store_checkout_whatsapp_enabled,store_checkout_online_enabled)
  on public.restaurants to authenticated;
alter table public.orders
  add column channel text not null default 'menu' check(channel in ('menu','store')),
  add column checkout_mode text not null default 'whatsapp' check(checkout_mode in ('whatsapp','online')),
  add column payment_status text not null default 'unpaid' check(payment_status in
    ('unpaid','pending','approved','rejected','cancelled','refunded','partially_refunded','charged_back','requires_refund')),
  add constraint online_store_only check(checkout_mode<>'online' or channel='store');

create function private.commerce_channel_published(p_restaurant_id uuid,p_channel text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select status='active' and case p_channel when 'menu' then public_menu_enabled
    when 'store' then store_enabled else false end from public.restaurants where id=p_restaurant_id),false)
$$;
create function private.commerce_accepts_orders(p_restaurant_id uuid,p_channel text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.commerce_channel_published(p_restaurant_id,p_channel) and coalesce((select
    (p_channel='store' and store_ordering_policy='always') or private.restaurant_is_open(id,now())
    from public.restaurants where id=p_restaurant_id),false)
$$;

-- Build a channel-aware version of the original curated projection, preserving
-- its complete anonymous field allowlist. No settings/GUC can bypass publishing.
do $migration$
declare source text;
begin
  source:=pg_get_functiondef('private.get_public_menu_without_quantity_prices(text)'::regprocedure);
  if position('and r.public_menu_enabled' in source)=0 then raise exception 'Unexpected public catalogue definition'; end if;
  source:=replace(source,'private.get_public_menu_without_quantity_prices(p_restaurant_slug text)',
    'private.get_public_catalog_base(p_restaurant_slug text, p_channel text)');
  source:=replace(source,'and r.public_menu_enabled','and private.commerce_channel_published(r.id,p_channel)');
  execute source;
end $migration$;

create function public.get_public_catalog(p_restaurant_slug text,p_channel text default 'menu')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; r public.restaurants%rowtype; c jsonb; p jsonb; categories jsonb:='[]'; products jsonb; rules jsonb;
begin
  if p_channel is null or p_channel not in ('menu','store') then return null; end if;
  result:=private.get_public_catalog_base(p_restaurant_slug,p_channel);
  if result is null then return null; end if;
  select * into r from public.restaurants where id=(result#>>'{restaurant,id}')::uuid;
  for c in select value from jsonb_array_elements(result->'categories') loop
    products:='[]';
    for p in select value from jsonb_array_elements(c->'products') loop
      select coalesce(jsonb_agg(jsonb_build_object('quantity',quantity,'totalPriceCents',total_price_cents::text) order by quantity),'[]')
        into rules from public.product_quantity_prices where product_id=(p->>'id')::uuid and restaurant_id=r.id and active;
      p:=p||jsonb_build_object('quantityPrices',rules);
      if r.inventory_mode<>'never_enabled' or r.inventory_cutover_id is not null then
        p:=p||jsonb_build_object('available',coalesce((p->>'available')::boolean,true)
          and r.inventory_mode='enforced' and r.inventory_cutover_id is null
          and exists(select 1 from public.inventory_balances b where b.restaurant_id=r.id and b.product_id=(p->>'id')::uuid and b.on_hand>b.reserved));
      end if;
      products:=products||jsonb_build_array(p);
    end loop;
    categories:=categories||jsonb_build_array(jsonb_set(c,'{products}',products));
  end loop;
  result:=jsonb_set(result,'{categories}',categories);
  return jsonb_set(result,'{restaurant}',result->'restaurant'||jsonb_build_object(
    'channel',p_channel,'acceptsOrders',private.commerce_accepts_orders(r.id,p_channel),
    'storeCheckoutWhatsappEnabled',r.store_checkout_whatsapp_enabled,
    'storeCheckoutOnlineEnabled',r.store_checkout_online_enabled,'storeOrderingPolicy',r.store_ordering_policy));
end $$;
create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.get_public_catalog(p_restaurant_slug,'menu')
$$;

alter function private.order_request_fingerprint(jsonb) rename to order_request_fingerprint_v1;
create function private.order_request_fingerprint(p_request jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare channel text:=coalesce(p_request->>'channel','menu'); mode text:=coalesce(p_request->>'checkoutMode','whatsapp');
begin
  if channel='menu' and mode='whatsapp' then return private.order_request_fingerprint_v1(p_request); end if;
  return encode(extensions.digest(convert_to(jsonb_build_object('version',2,'channel',channel,'checkoutMode',mode,
    'business',private.order_request_fingerprint_v1(p_request))::text,'UTF8'),'sha256'),'hex');
end $$;
alter function private.order_request_snapshot(uuid) rename to order_request_snapshot_v1;
create function private.order_request_snapshot(p_order_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select private.order_request_snapshot_v1(o.id)||jsonb_build_object('channel',o.channel,'checkoutMode',o.checkout_mode)
  from public.orders o where o.id=p_order_id
$$;

-- Amend both the idempotency gate and the pricing core. These exact-source
-- replacements fail the migration if the expected versioned boundary changed.
do $migration$
declare source text;
begin
  source:=pg_get_functiondef('private.create_order_transaction_with_request_hash(jsonb,text,text,text)'::regprocedure);
  if position('and public_menu_enabled for share' in source)=0 then raise exception 'Unexpected order wrapper definition'; end if;
  source:=replace(source,'and public_menu_enabled for share',
    'and private.commerce_channel_published(id,coalesce(p_request->>''channel'',''menu'')) for share');
  source:=replace(source,'  if jsonb_typeof(p_request)',
    E'  if coalesce(p_request->>''channel'',''menu'') not in (''menu'',''store'') or coalesce(p_request->>''checkoutMode'',''whatsapp'') not in (''whatsapp'',''online'') or (coalesce(p_request->>''checkoutMode'',''whatsapp'')=''online'' and coalesce(p_request->>''channel'',''menu'')<>''store'') then raise exception using errcode=''22023'',message=''CHECKOUT_CHANNEL_INVALID''; end if;\n  if jsonb_typeof(p_request)');
  execute source;
  source:=pg_get_functiondef('private.create_order_transaction_without_request_hash(jsonb,text,text,text)'::regprocedure);
  if position('and r.public_menu_enabled' in source)=0 or position('if not private.restaurant_is_open(v_restaurant.id, now()) then' in source)=0
    or position('restaurant_id, idempotency_key, display_number, status,' in source)=0 then raise exception 'Unexpected order pricing definition'; end if;
  source:=replace(source,'and r.public_menu_enabled','and private.commerce_channel_published(r.id,coalesce(p_request->>''channel'',''menu''))');
  source:=replace(source,'if not private.restaurant_is_open(v_restaurant.id, now()) then',
    'if not private.commerce_accepts_orders(v_restaurant.id,coalesce(p_request->>''channel'',''menu'')) then');
  source:=replace(source,'  v_customer_name :=',
    E'  if coalesce(p_request->>''channel'',''menu'')=''store'' and ((coalesce(p_request->>''checkoutMode'',''whatsapp'')=''whatsapp'' and not v_restaurant.store_checkout_whatsapp_enabled) or (p_request->>''checkoutMode''=''online'' and not v_restaurant.store_checkout_online_enabled)) then raise exception using errcode=''22023'',message=''CHECKOUT_MODE_DISABLED''; end if;\n  v_customer_name :=');
  source:=replace(source,'restaurant_id, idempotency_key, display_number, status,','restaurant_id, idempotency_key, display_number, status, channel, checkout_mode,');
  source:=replace(source,'v_restaurant.id, v_idempotency_key, v_display_number, ''generated'',',
    'v_restaurant.id, v_idempotency_key, v_display_number, ''generated'', coalesce(p_request->>''channel'',''menu''), coalesce(p_request->>''checkoutMode'',''whatsapp''),');
  execute source;
end $migration$;

alter function private.create_order_response(uuid,boolean) rename to create_order_response_without_channel;
create function private.create_order_response(p_order_id uuid,p_replay boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_set(private.create_order_response_without_channel(o.id,p_replay),'{order}',
    private.create_order_response_without_channel(o.id,p_replay)->'order'||jsonb_build_object(
      'channel',o.channel,'checkoutMode',o.checkout_mode,'paymentStatus',o.payment_status))
  from public.orders o where o.id=p_order_id
$$;
alter function private.order_admin_json(uuid) rename to order_admin_json_without_channel;
create function private.order_admin_json(p_order_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select private.order_admin_json_without_channel(o.id)||jsonb_build_object('channel',o.channel,'checkoutMode',o.checkout_mode,'paymentStatus',o.payment_status)
  from public.orders o where o.id=p_order_id
$$;

revoke all on function private.commerce_channel_published(uuid,text),private.commerce_accepts_orders(uuid,text),
  private.get_public_catalog_base(text,text),private.order_request_fingerprint(jsonb),private.order_request_fingerprint_v1(jsonb),
  private.order_request_snapshot(uuid),private.order_request_snapshot_v1(uuid),private.create_order_response(uuid,boolean),
  private.create_order_response_without_channel(uuid,boolean),private.order_admin_json(uuid),private.order_admin_json_without_channel(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.get_public_catalog(text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_public_catalog(text,text) to anon,authenticated;
