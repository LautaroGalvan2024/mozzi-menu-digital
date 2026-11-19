create table public.sellers (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  whatsapp_phone text not null check (whatsapp_phone ~ '^[+][1-9][0-9]{7,14}$'),
  image_path text,
  active boolean not null default true,
  menu_enabled boolean not null default false,
  store_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (restaurant_id, id),
  check (not active or menu_enabled or store_enabled),
  check (image_path is null or image_path like 'restaurants/' || restaurant_id::text || '/promotions/' || id::text || '/%')
);

alter table public.sellers enable row level security;
revoke all on public.sellers from public, anon, authenticated, service_role;
grant select on public.sellers to authenticated;
create policy sellers_read on public.sellers for select to authenticated
  using (private.can_manage_orders(restaurant_id));
create index sellers_tenant_name_idx on public.sellers (restaurant_id, name, id);
create index sellers_image_asset_ref_idx on public.sellers (private.image_asset_primary_path(image_path));

create trigger sellers_image_reference before insert or update of image_path on public.sellers
  for each row execute function private.guard_image_asset_reference();

alter function private.image_asset_is_referenced(uuid, text) rename to image_asset_referenced_before_sellers;
create function private.image_asset_is_referenced(p_restaurant_id uuid, p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.image_asset_referenced_before_sellers(p_restaurant_id, p_path)
    or (p_path like 'restaurants/' || p_restaurant_id::text || '/%' and exists (
      select 1 from public.sellers s
      where private.image_asset_primary_path(s.image_path)=private.image_asset_primary_path(p_path)
    ))
$$;

create function public.save_seller(
  p_restaurant_id uuid, p_id uuid, p_name text, p_whatsapp_phone text, p_image_path text,
  p_active boolean, p_menu_enabled boolean, p_store_enabled boolean
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare saved uuid;
begin
  if not private.can_manage_catalog(p_restaurant_id)
    or not private.stage_one_feature_enabled(p_restaurant_id,'sellers') then
    raise exception using errcode='42501', message='FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('seller:' || p_id::text,0));
  perform 1 from public.sellers where id=p_id and restaurant_id=p_restaurant_id for update;
  if not private.can_manage_catalog(p_restaurant_id)
    or not private.stage_one_feature_enabled(p_restaurant_id,'sellers') then
    raise exception using errcode='42501', message='FORBIDDEN';
  end if;

  if p_image_path is not null and not exists (
    select 1 from public.image_assets a where a.restaurant_id=p_restaurant_id
      and a.entity_type='promotion' and a.entity_id=p_id and a.path=p_image_path and a.deleted_at is null
  ) then
    raise exception using errcode='22023', message='SELLER_IMAGE_INVALID';
  end if;

  insert into public.sellers (id, restaurant_id, name, whatsapp_phone, image_path, active, menu_enabled, store_enabled)
    values (p_id, p_restaurant_id, btrim(p_name), p_whatsapp_phone, p_image_path, p_active, p_menu_enabled, p_store_enabled)
  on conflict (id) do update set
    name=excluded.name, whatsapp_phone=excluded.whatsapp_phone, image_path=excluded.image_path, active=excluded.active,
    menu_enabled=excluded.menu_enabled, store_enabled=excluded.store_enabled
    where sellers.restaurant_id=p_restaurant_id
  returning id into saved;
  if saved is null then raise exception using errcode='42501', message='FORBIDDEN'; end if;
  return saved;
end;
$$;

create function public.get_public_seller(p_restaurant_slug text, p_channel text, p_seller_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',s.id,'name',s.name,'imagePath',s.image_path)
  from public.sellers s
  join public.restaurants r on r.id=s.restaurant_id
  where r.slug=lower(btrim(p_restaurant_slug)) and s.id=p_seller_id and s.active
    and private.stage_one_feature_enabled(r.id,'sellers')
    and private.commerce_channel_published(r.id,p_channel)
    and ((p_channel='menu' and s.menu_enabled) or (p_channel='store' and s.store_enabled))
$$;

alter table public.orders
  add column seller_id uuid,
  add column seller_name text,
  add column seller_whatsapp_phone text,
  add constraint orders_seller_tenant_fkey foreign key (restaurant_id,seller_id)
    references public.sellers(restaurant_id,id) deferrable initially deferred,
  add constraint orders_seller_snapshot_check check (
    (seller_id is null and seller_name is null and seller_whatsapp_phone is null)
    or (seller_id is not null and seller_name is not null and seller_whatsapp_phone is not null)
  );

create index orders_seller_created_idx on public.orders (restaurant_id, seller_id, created_at desc, id desc)
  where seller_id is not null;

create function private.save_order_seller_snapshot() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
  if new.seller_id is null then return new; end if;
  if not private.stage_one_feature_enabled(new.restaurant_id,'sellers') then
    raise exception using errcode='22023',message='SELLER_NOT_AVAILABLE';
  end if;

  select s.name, s.whatsapp_phone into new.seller_name, new.seller_whatsapp_phone
  from public.sellers s where s.id=new.seller_id and s.restaurant_id=new.restaurant_id and s.active
    and ((new.channel='menu' and s.menu_enabled) or (new.channel='store' and s.store_enabled))
  for share;
  if not found then raise exception using errcode='22023',message='SELLER_NOT_AVAILABLE'; end if;
  return new;
end;
$$;

create trigger orders_seller_snapshot before insert on public.orders
  for each row execute function private.save_order_seller_snapshot();

-- Hash only actual attribution. A legacy request keeps its exact existing fingerprint.
create or replace function private.order_request_fingerprint(p_request jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare
  channel text:=coalesce(p_request->>'channel','menu');
  mode text:=coalesce(p_request->>'checkoutMode','whatsapp');
  business text:=private.order_request_fingerprint_v1(p_request);
  seller uuid:=(p_request->>'sellerId')::uuid;
begin
  if seller is not null then
    return encode(extensions.digest(convert_to(jsonb_build_object('version',3,'channel',channel,
      'checkoutMode',mode,'business',business,'sellerId',seller)::text,'UTF8'),'sha256'),'hex');
  end if;
  if channel='menu' and mode='whatsapp' then return business; end if;
  return encode(extensions.digest(convert_to(jsonb_build_object('version',2,'channel',channel,'checkoutMode',mode,
    'business',business)::text,'UTF8'),'sha256'),'hex');
end;
$$;

create or replace function private.order_request_snapshot(p_order_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select private.order_request_snapshot_v1(o.id)
    || jsonb_build_object('channel',o.channel,'checkoutMode',o.checkout_mode)
    || case when o.seller_id is not null then jsonb_build_object('sellerId',o.seller_id) else '{}'::jsonb end
  from public.orders o where o.id=p_order_id
$$;

-- Both checkout modes call the same insert. The trigger captures attribution only for a new order.
do $migration$
declare
  source text:=pg_get_functiondef('private.create_order_transaction_without_request_hash(jsonb,text,text,text)'::regprocedure);
  columns text:='restaurant_id, idempotency_key, display_number, status, channel, checkout_mode,';
  values_fragment text:='coalesce(p_request->>''checkoutMode'',''whatsapp''),';
begin
  if position(columns in source)=0 or position(values_fragment in source)=0 then
    raise exception 'Unexpected commerce order insert definition';
  end if;
  execute replace(replace(source, columns, columns||' seller_id,'),
    values_fragment, values_fragment||' (p_request->>''sellerId'')::uuid,');
end $migration$;

-- Public status contains the snapshot name, never an arbitrary phone from the request.
create function private.order_seller_context(p_order public.orders)
returns jsonb language sql stable set search_path='' as $$
  select case when p_order.seller_id is not null
    then jsonb_build_object('sellerName',p_order.seller_name) else '{}'::jsonb end
$$;

create function private.order_public_context(p_order public.orders)
returns jsonb language sql stable set search_path='' as $$
  select private.order_seller_context(p_order)
$$;

create or replace function private.create_order_response(p_order_id uuid,p_replay boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_set(canonical.payload,'{order}',canonical.payload->'order'
    || jsonb_build_object('channel',o.channel,'checkoutMode',o.checkout_mode,'paymentStatus',o.payment_status)
    || private.order_public_context(o)
    || case when o.seller_id is null then '{}'::jsonb else jsonb_build_object(
      'sellerWhatsappPhone',(
        select s.whatsapp_phone from public.sellers s
        where s.id=o.seller_id and s.restaurant_id=o.restaurant_id and s.active
          and private.stage_one_feature_enabled(o.restaurant_id,'sellers')
          and s.whatsapp_phone=o.seller_whatsapp_phone
          and ((o.channel='menu' and s.menu_enabled) or (o.channel='store' and s.store_enabled))
      )
    ) end)
  from public.orders o
  cross join lateral (select private.create_order_response_without_channel(o.id,p_replay) payload offset 0) canonical
  where o.id=p_order_id
$$;

do $migration$
declare
  source text:=pg_get_functiondef('public.get_online_checkout_status(uuid,text,boolean)'::regprocedure);
  fragment text:='''checkoutMode'',o.checkout_mode,''paymentStatus'',o.payment_status),';
begin
  if position(fragment in source)=0 then raise exception 'Unexpected online status definition'; end if;
  execute replace(source,fragment, left(fragment,-1)||' || private.order_public_context(o),');
end $migration$;

revoke all on function private.image_asset_referenced_before_sellers(uuid,text),
  private.image_asset_is_referenced(uuid,text), private.save_order_seller_snapshot(),
  private.order_seller_context(public.orders), private.order_public_context(public.orders)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_seller(text,text,uuid),
  public.save_seller(uuid,uuid,text,text,text,boolean,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_seller(text,text,uuid) to anon, authenticated;
grant execute on function public.save_seller(uuid,uuid,text,text,text,boolean,boolean,boolean) to authenticated;
