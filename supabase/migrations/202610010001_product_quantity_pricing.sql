-- Quantity pricing remains tenant-scoped and server-authoritative. Public clients
-- only receive active rules through get_public_menu and never submit prices at checkout.
create table public.product_quantity_prices (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  product_id uuid not null,
  quantity smallint not null check (quantity between 2 and 20),
  total_price_cents bigint not null check (total_price_cents between 0 and 1000000000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  unique (product_id, restaurant_id, quantity),
  foreign key (product_id, restaurant_id)
    references public.products (id, restaurant_id) on delete cascade
);

create index product_quantity_prices_public_idx
  on public.product_quantity_prices (restaurant_id, product_id, quantity)
  where active;

alter table public.product_quantity_prices enable row level security;

create policy product_quantity_prices_select_member on public.product_quantity_prices
for select to authenticated
using (private.can_view_restaurant(restaurant_id));

create policy product_quantity_prices_insert_admin on public.product_quantity_prices
for insert to authenticated
with check (private.can_manage_catalog(restaurant_id));

create policy product_quantity_prices_update_admin on public.product_quantity_prices
for update to authenticated
using (private.can_manage_catalog(restaurant_id))
with check (private.can_manage_catalog(restaurant_id));

revoke all on table public.product_quantity_prices from public, anon, authenticated;
grant all privileges on table public.product_quantity_prices to service_role;
grant select, insert, update on table public.product_quantity_prices to authenticated;

create trigger product_quantity_prices_updated_at
before update on public.product_quantity_prices
for each row execute function private.set_updated_at();

create trigger product_quantity_prices_immutable_identity
before update on public.product_quantity_prices
for each row execute function private.guard_identity_and_tenant();

-- Preserve the actual product subtotal and the exact offer decomposition used at
-- checkout. Options remain outside quantity discounts and are charged per unit.
alter table public.order_items
  add column base_subtotal_cents bigint,
  add column pricing_mode_snapshot text,
  add column pricing_breakdown_snapshot jsonb;

alter table public.order_items disable trigger order_items_append_only;
update public.order_items
set base_subtotal_cents = unit_price_cents * quantity,
    pricing_mode_snapshot = 'unit',
    pricing_breakdown_snapshot = jsonb_build_object(
      'mode', 'unit',
      'unitPriceCents', unit_price_cents::text,
      'baseSubtotalCents', (unit_price_cents * quantity)::text,
      'components', jsonb_build_array(jsonb_build_object(
        'quantity', 1,
        'count', quantity,
        'totalPriceCents', unit_price_cents::text,
        'subtotalCents', (unit_price_cents * quantity)::text
      ))
    );
alter table public.order_items enable trigger order_items_append_only;

alter table public.order_items
  alter column base_subtotal_cents set not null,
  alter column pricing_mode_snapshot set not null,
  alter column pricing_breakdown_snapshot set not null,
  drop constraint order_items_quantity_check,
  add constraint order_items_quantity_check check (quantity between 1 and 100),
  add constraint order_items_base_subtotal_check check (base_subtotal_cents >= 0),
  add constraint order_items_pricing_mode_check
    check (pricing_mode_snapshot in ('unit', 'quantity')),
  add constraint order_items_pricing_breakdown_check
    check (jsonb_typeof(pricing_breakdown_snapshot) = 'object'),
  drop constraint order_items_check,
  add constraint order_items_line_total_check check (
    line_total_cents = base_subtotal_cents + (options_total_unit_cents * quantity)
  );

-- Exact unbounded-knapsack calculation for a canonical cart line. Quantity is
-- at most 100, so a small dynamic-programming array is deterministic and bounded.
create or replace function private.calculate_product_base_pricing(
  p_restaurant_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_unit_price_cents bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_best_totals bigint[];
  v_choice_quantities integer[];
  v_choice_prices bigint[];
  v_target integer;
  v_remaining integer;
  v_candidate bigint;
  v_rule record;
  v_used_quantities integer[] := '{}'::integer[];
  v_used_prices bigint[] := '{}'::bigint[];
  v_components jsonb;
  v_mode text;
begin
  if p_quantity not between 1 and 100
     or p_unit_price_cents is null
     or p_unit_price_cents < 0 then
    raise exception using errcode = '22023', message = 'PRICING_ARGUMENT_INVALID';
  end if;

  v_best_totals := array_fill(null::bigint, array[p_quantity + 1], array[0]);
  v_choice_quantities := array_fill(null::integer, array[p_quantity + 1], array[0]);
  v_choice_prices := array_fill(null::bigint, array[p_quantity + 1], array[0]);
  v_best_totals[0] := 0;

  for v_target in 1..p_quantity loop
    v_best_totals[v_target] := v_best_totals[v_target - 1] + p_unit_price_cents;
    v_choice_quantities[v_target] := 1;
    v_choice_prices[v_target] := p_unit_price_cents;

    for v_rule in
      select pqp.quantity, pqp.total_price_cents
      from public.product_quantity_prices pqp
      where pqp.restaurant_id = p_restaurant_id
        and pqp.product_id = p_product_id
        and pqp.active
        and pqp.quantity <= v_target
      order by pqp.quantity
    loop
      v_candidate := v_best_totals[v_target - v_rule.quantity] + v_rule.total_price_cents;
      if v_candidate < v_best_totals[v_target] then
        v_best_totals[v_target] := v_candidate;
        v_choice_quantities[v_target] := v_rule.quantity;
        v_choice_prices[v_target] := v_rule.total_price_cents;
      end if;
    end loop;
  end loop;

  v_remaining := p_quantity;
  while v_remaining > 0 loop
    v_used_quantities := array_append(v_used_quantities, v_choice_quantities[v_remaining]);
    v_used_prices := array_append(v_used_prices, v_choice_prices[v_remaining]);
    v_remaining := v_remaining - v_choice_quantities[v_remaining];
  end loop;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'quantity', c.offer_quantity,
      'count', c.offer_count,
      'totalPriceCents', c.offer_price::text,
      'subtotalCents', (c.offer_price * c.offer_count)::text
    ) order by c.offer_quantity
  ), '[]'::jsonb)
  into v_components
  from (
    select u.offer_quantity, u.offer_price, count(*)::integer as offer_count
    from unnest(v_used_quantities, v_used_prices) as u(offer_quantity, offer_price)
    group by u.offer_quantity, u.offer_price
  ) c;

  v_mode := case
    when exists (select 1 from unnest(v_used_quantities) q where q > 1)
    then 'quantity'
    else 'unit'
  end;

  return jsonb_build_object(
    'mode', v_mode,
    'unitPriceCents', p_unit_price_cents::text,
    'baseSubtotalCents', v_best_totals[p_quantity]::text,
    'components', v_components
  );
end;
$$;

revoke all on function private.calculate_product_base_pricing(uuid, uuid, integer, bigint)
  from public, anon, authenticated, service_role;

-- Keep the previously reviewed projections/writes as private implementation
-- helpers and place narrow wrappers at the original public RPC signatures.
alter function public.get_public_menu(text)
  rename to get_public_menu_without_quantity_prices;
alter function public.get_public_menu_without_quantity_prices(text)
  set schema private;
revoke all on function private.get_public_menu_without_quantity_prices(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_categories jsonb := '[]'::jsonb;
  v_products jsonb;
  v_category jsonb;
  v_product jsonb;
  v_quantity_prices jsonb;
  v_quantity_price_map jsonb := '{}'::jsonb;
  v_restaurant_id uuid;
begin
  v_result := private.get_public_menu_without_quantity_prices(p_restaurant_slug);
  if v_result is null then
    return null;
  end if;

  v_restaurant_id := (v_result #>> '{restaurant,id}')::uuid;
  select coalesce(jsonb_object_agg(prices.product_id::text, prices.rules), '{}'::jsonb)
  into v_quantity_price_map
  from (
    select pqp.product_id, jsonb_agg(
      jsonb_build_object(
        'quantity', pqp.quantity,
        'totalPriceCents', pqp.total_price_cents::text
      ) order by pqp.quantity
    ) as rules
    from public.product_quantity_prices pqp
    where pqp.restaurant_id = v_restaurant_id
      and pqp.active
    group by pqp.product_id
  ) prices;

  for v_category in select value from jsonb_array_elements(v_result -> 'categories') loop
    v_products := '[]'::jsonb;
    for v_product in select value from jsonb_array_elements(v_category -> 'products') loop
      v_quantity_prices := coalesce(
        v_quantity_price_map -> (v_product ->> 'id'),
        '[]'::jsonb
      );

      v_products := v_products || jsonb_build_array(
        v_product || jsonb_build_object('quantityPrices', v_quantity_prices)
      );
    end loop;
    v_categories := v_categories || jsonb_build_array(
      jsonb_set(v_category, '{products}', v_products, true)
    );
  end loop;

  return jsonb_set(v_result, '{categories}', v_categories, true);
end;
$$;

revoke all on function public.get_public_menu(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_menu(text) to anon, authenticated;

comment on function public.get_public_menu(text) is
  'Anonymous-safe menu projection with active quantity prices. No profile, membership, order or audit fields are returned.';

alter function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[])
  rename to save_product_catalog_without_quantity_prices;
alter function public.save_product_catalog_without_quantity_prices(uuid, jsonb, jsonb, uuid[], uuid[])
  set schema private;
revoke all on function private.save_product_catalog_without_quantity_prices(uuid, jsonb, jsonb, uuid[], uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.save_product_catalog(
  p_restaurant_id uuid,
  p_product jsonb,
  p_groups jsonb,
  p_removed_group_ids uuid[] default '{}'::uuid[],
  p_removed_option_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_product_id uuid;
  v_rule jsonb;
  v_rule_quantity integer;
  v_rule_total bigint;
  v_rule_count integer := 0;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_product) <> 'object' then
    raise exception using errcode = '22023', message = 'PRODUCT_PAYLOAD_INVALID';
  end if;

  if p_product ? 'quantityPrices' then
    if jsonb_typeof(p_product -> 'quantityPrices') <> 'array'
       or jsonb_array_length(p_product -> 'quantityPrices') > 19
       or exists (
         select 1
         from jsonb_array_elements(p_product -> 'quantityPrices') qp
         where jsonb_typeof(qp) <> 'object'
            or not (qp ? 'quantity')
            or not (qp ? 'totalPriceCents')
            or jsonb_typeof(qp -> 'quantity') <> 'number'
            or jsonb_typeof(qp -> 'totalPriceCents') not in ('number', 'string')
       ) then
      raise exception using errcode = '22023', message = 'PRODUCT_QUANTITY_PRICES_INVALID';
    end if;

    begin
      if exists (
        select 1
        from jsonb_array_elements(p_product -> 'quantityPrices') qp
        group by (qp ->> 'quantity')::integer
        having count(*) > 1
      ) or exists (
        select 1
        from jsonb_array_elements(p_product -> 'quantityPrices') qp
        where (qp ->> 'quantity')::integer not between 2 and 20
           or (qp ->> 'totalPriceCents')::bigint not between 0 and 1000000000000
      ) then
        raise exception using errcode = '22023', message = 'PRODUCT_QUANTITY_PRICES_INVALID';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'PRODUCT_QUANTITY_PRICES_INVALID';
    end;
  end if;

  v_result := private.save_product_catalog_without_quantity_prices(
    p_restaurant_id,
    p_product,
    p_groups,
    p_removed_group_ids,
    p_removed_option_ids
  );

  if p_product ? 'quantityPrices' then
    v_product_id := (p_product ->> 'id')::uuid;

    update public.product_quantity_prices pqp
    set active = false
    where pqp.restaurant_id = p_restaurant_id
      and pqp.product_id = v_product_id
      and pqp.active
      and not exists (
        select 1
        from jsonb_array_elements(p_product -> 'quantityPrices') qp
        where (qp ->> 'quantity')::integer = pqp.quantity
      );

    for v_rule in
      select value from jsonb_array_elements(p_product -> 'quantityPrices')
    loop
      v_rule_quantity := (v_rule ->> 'quantity')::integer;
      v_rule_total := (v_rule ->> 'totalPriceCents')::bigint;

      insert into public.product_quantity_prices (
        restaurant_id, product_id, quantity, total_price_cents, active
      ) values (
        p_restaurant_id, v_product_id, v_rule_quantity, v_rule_total, true
      )
      on conflict (product_id, restaurant_id, quantity) do update set
        total_price_cents = excluded.total_price_cents,
        active = true,
        updated_at = now();
      v_rule_count := v_rule_count + 1;
    end loop;
  end if;

  if p_product ? 'quantityPrices' then
    return v_result || jsonb_build_object('quantityPrices', v_rule_count);
  end if;
  return v_result;
end;
$$;

revoke all on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[])
  to authenticated;

comment on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[]) is
  'Atomically saves a product graph and optionally synchronizes reusable quantity prices.';

comment on table public.product_quantity_prices is
  'Reusable exact-quantity total prices. Only active rows are projected publicly.';
comment on column public.order_items.base_subtotal_cents is
  'Canonical product subtotal after the cheapest exact unit/quantity-price combination, before options.';
comment on column public.order_items.pricing_breakdown_snapshot is
  'Immutable decomposition of unit and quantity-price components applied to this line.';

create or replace function public.create_order_transaction(
  p_request jsonb,
  p_ip_hash text,
  p_phone_hash text,
  p_client_event_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_restaurant public.restaurants%rowtype;
  v_payment public.payment_methods%rowtype;
  v_zone public.delivery_zones%rowtype;
  v_product public.products%rowtype;
  v_order_id uuid;
  v_order_number bigint;
  v_display_number text;
  v_idempotency_key uuid;
  v_payment_id uuid;
  v_zone_id uuid;
  v_fulfillment public.fulfillment_type;
  v_customer_name text;
  v_customer_phone text;
  v_notes text;
  v_delivery_address text;
  v_delivery_city text;
  v_delivery_neighborhood text;
  v_delivery_floor text;
  v_delivery_apartment text;
  v_delivery_reference text;
  v_item jsonb;
  v_option_ids jsonb;
  v_options jsonb;
  v_requested_items jsonb := '[]'::jsonb;
  v_canonical_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_total_quantity integer := 0;
  v_line_index integer := 0;
  v_normalized_notes text;
  v_selected_count integer;
  v_distinct_count integer;
  v_option_total bigint;
  v_unit_price bigint;
  v_base_subtotal bigint;
  v_pricing jsonb;
  v_line_total bigint;
  v_subtotal bigint := 0;
  v_delivery_fee bigint := 0;
  v_adjustment_base bigint := 0;
  v_adjustment bigint := 0;
  v_discount bigint := 0;
  v_surcharge bigint := 0;
  v_total bigint := 0;
  v_token_expires timestamptz;
  v_token_stored boolean := false;
begin
  if jsonb_typeof(p_request) <> 'object'
     or pg_column_size(p_request) > 131072 then
    raise exception using errcode = '22023', message = 'ORDER_PAYLOAD_INVALID';
  end if;
  if p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_phone_hash !~ '^[0-9a-f]{64}$'
     or p_client_event_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'HASH_ARGUMENT_INVALID';
  end if;

  select r.* into v_restaurant
  from public.restaurants r
  where r.slug = lower(btrim(p_request ->> 'restaurantSlug'))
    and r.status = 'active'
    and r.public_menu_enabled
  for share;
  if not found then
    raise exception using errcode = '22023', message = 'RESTAURANT_NOT_AVAILABLE';
  end if;

  begin
    v_idempotency_key := (p_request ->> 'idempotencyKey')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end;
  if v_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;

  select o.id into v_order_id
  from public.orders o
  where o.restaurant_id = v_restaurant.id and o.idempotency_key = v_idempotency_key;
  if found then
    begin
      v_token_expires := coalesce((p_request ->> 'tokenExpiresAt')::timestamptz, now() + interval '15 minutes');
    exception when others then
      v_token_expires := now() + interval '15 minutes';
    end;
    if v_token_expires <= now() or v_token_expires > now() + interval '1 hour' then
      v_token_expires := now() + interval '15 minutes';
    end if;
    update private.order_client_event_tokens t
    set token_hash = p_client_event_token_hash,
        expires_at = v_token_expires
    from public.orders o
    where t.order_id = v_order_id and o.id = t.order_id
      and t.used_at is null
      and o.status in ('generated', 'whatsapp_opened');
    get diagnostics v_selected_count = row_count;
    return private.create_order_response(v_order_id, true)
      || jsonb_build_object('clientEventTokenStored', v_selected_count = 1,
                            'clientEventExpiresAt', v_token_expires);
  end if;

  if not private.restaurant_is_open(v_restaurant.id, now()) then
    raise exception using errcode = '22023', message = 'RESTAURANT_CLOSED';
  end if;

  v_customer_name := btrim(coalesce(p_request #>> '{customer,name}', ''));
  v_customer_phone := btrim(coalesce(p_request #>> '{customer,phone}', ''));
  if char_length(v_customer_name) not between 1 and 120
     or char_length(v_customer_phone) not between 8 and 32 then
    raise exception using errcode = '22023', message = 'CUSTOMER_INVALID';
  end if;
  v_notes := nullif(btrim(coalesce(p_request ->> 'notes', '')), '');
  if char_length(coalesce(v_notes, '')) > 1000 then
    raise exception using errcode = '22023', message = 'NOTES_TOO_LONG';
  end if;

  begin
    v_fulfillment := (p_request #>> '{fulfillment,type}')::public.fulfillment_type;
    v_payment_id := (p_request ->> 'paymentMethodId')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'CHECKOUT_SELECTION_INVALID';
  end;

  if v_fulfillment = 'delivery' and not v_restaurant.delivery_enabled then
    raise exception using errcode = '22023', message = 'DELIVERY_DISABLED';
  elsif v_fulfillment = 'pickup' and not v_restaurant.pickup_enabled then
    raise exception using errcode = '22023', message = 'PICKUP_DISABLED';
  end if;

  select pm.* into v_payment from public.payment_methods pm
  where pm.id = v_payment_id and pm.restaurant_id = v_restaurant.id and pm.active
  for share;
  if not found then
    raise exception using errcode = '22023', message = 'PAYMENT_METHOD_INVALID';
  end if;

  if v_fulfillment = 'delivery' then
    begin
      v_zone_id := (p_request #>> '{fulfillment,deliveryZoneId}')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'DELIVERY_ZONE_INVALID';
    end;
    select dz.* into v_zone from public.delivery_zones dz
    where dz.id = v_zone_id and dz.restaurant_id = v_restaurant.id and dz.active
    for share;
    if not found then
      raise exception using errcode = '22023', message = 'DELIVERY_ZONE_INVALID';
    end if;
    v_delivery_address := nullif(btrim(coalesce(p_request #>> '{fulfillment,address}', '')), '');
    v_delivery_city := nullif(btrim(coalesce(p_request #>> '{fulfillment,city}', '')), '');
    v_delivery_neighborhood := nullif(btrim(coalesce(p_request #>> '{fulfillment,neighborhood}', '')), '');
    v_delivery_floor := nullif(btrim(coalesce(p_request #>> '{fulfillment,floor}', '')), '');
    v_delivery_apartment := nullif(btrim(coalesce(p_request #>> '{fulfillment,apartment}', '')), '');
    v_delivery_reference := nullif(btrim(coalesce(p_request #>> '{fulfillment,reference}', '')), '');
    if v_delivery_address is null
       or char_length(v_delivery_address) > 240
       or char_length(coalesce(v_delivery_city, '')) > 120
       or char_length(coalesce(v_delivery_neighborhood, '')) > 120
       or char_length(coalesce(v_delivery_floor, '')) > 40
       or char_length(coalesce(v_delivery_apartment, '')) > 40
       or char_length(coalesce(v_delivery_reference, '')) > 240 then
      raise exception using errcode = '22023', message = 'DELIVERY_ADDRESS_INVALID';
    end if;
  end if;

  if jsonb_typeof(p_request -> 'items') <> 'array'
     or jsonb_array_length(p_request -> 'items') not between 1 and 50 then
    raise exception using errcode = '22023', message = 'ITEMS_INVALID';
  end if;

  -- Normalize the identity of every requested line before pricing. Equal lines
  -- are one pricing scope even if option IDs arrived in a different order.
  for v_item in select value from jsonb_array_elements(p_request -> 'items') loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'ITEM_INVALID';
    end if;
    begin
      v_product_id := (v_item ->> 'productId')::uuid;
      v_quantity := (v_item ->> 'quantity')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'ITEM_INVALID';
    end;
    if v_quantity not between 1 and 100
       or char_length(coalesce(v_item ->> 'notes', '')) > 500 then
      raise exception using errcode = '22023', message = 'ITEM_LIMIT_INVALID';
    end if;
    v_total_quantity := v_total_quantity + v_quantity;
    if v_total_quantity > 100 then
      raise exception using errcode = '22023', message = 'TOTAL_QUANTITY_EXCEEDED';
    end if;

    v_option_ids := coalesce(v_item -> 'optionIds', '[]'::jsonb);
    if jsonb_typeof(v_option_ids) <> 'array' or jsonb_array_length(v_option_ids) > 50 then
      raise exception using errcode = '22023', message = 'OPTIONS_INVALID';
    end if;
    begin
      select count(*), count(distinct normalized.option_id),
             coalesce(jsonb_agg(normalized.option_id order by normalized.option_id), '[]'::jsonb)
      into v_selected_count, v_distinct_count, v_option_ids
      from (
        select (selected.value::uuid)::text as option_id
        from jsonb_array_elements_text(v_option_ids) selected(value)
      ) normalized;
    exception when others then
      raise exception using errcode = '22023', message = 'OPTIONS_INVALID';
    end;
    if v_selected_count <> v_distinct_count then
      raise exception using errcode = '22023', message = 'DUPLICATE_OPTION';
    end if;

    v_normalized_notes := nullif(btrim(coalesce(v_item ->> 'notes', '')), '');
    v_line_index := v_line_index + 1;
    v_requested_items := v_requested_items || jsonb_build_array(jsonb_build_object(
      'productId', v_product_id,
      'quantity', v_quantity,
      'optionIds', v_option_ids,
      'notes', v_normalized_notes,
      'lineIndex', v_line_index
    ));
  end loop;

  for v_item in
    select jsonb_build_object(
      'productId', grouped.product_id,
      'quantity', grouped.quantity,
      'optionIds', grouped.option_ids,
      'notes', grouped.notes
    )
    from (
      select requested ->> 'productId' as product_id,
             requested -> 'optionIds' as option_ids,
             requested ->> 'notes' as notes,
             sum((requested ->> 'quantity')::integer)::integer as quantity,
             min((requested ->> 'lineIndex')::integer) as first_line_index
      from jsonb_array_elements(v_requested_items) requested
      group by requested ->> 'productId', requested -> 'optionIds', requested ->> 'notes'
    ) grouped
    order by grouped.first_line_index
  loop
    v_product_id := (v_item ->> 'productId')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select p.* into v_product
    from public.products p
    join public.categories c on c.id = p.category_id and c.restaurant_id = p.restaurant_id
    where p.id = v_product_id and p.restaurant_id = v_restaurant.id
      and p.deleted_at is null and p.active and p.available
      and c.deleted_at is null and c.active
    for share of p;
    if not found then
      raise exception using errcode = '22023', message = 'PRODUCT_UNAVAILABLE';
    end if;

    v_option_ids := v_item -> 'optionIds';
    if jsonb_typeof(v_option_ids) <> 'array' or jsonb_array_length(v_option_ids) > 50 then
      raise exception using errcode = '22023', message = 'OPTIONS_INVALID';
    end if;
    begin
      select count(*), count(distinct value)
      into v_selected_count, v_distinct_count
      from jsonb_array_elements_text(v_option_ids);
    exception when others then
      raise exception using errcode = '22023', message = 'OPTIONS_INVALID';
    end;
    if v_selected_count <> v_distinct_count then
      raise exception using errcode = '22023', message = 'DUPLICATE_OPTION';
    end if;

    begin
      select count(*), coalesce(sum(po.price_delta_cents), 0),
             coalesce(jsonb_agg(
               jsonb_build_object(
                 'id', po.id,
                 'groupName', pog.name,
                 'name', po.name,
                 'priceDeltaCents', po.price_delta_cents::text
               ) order by pog.sort_order, po.sort_order, po.id
             ), '[]'::jsonb)
      into v_distinct_count, v_option_total, v_options
      from jsonb_array_elements_text(v_option_ids) selected(value)
      join public.product_options po on po.id = selected.value::uuid and po.active
      join public.product_option_groups pog
        on pog.id = po.option_group_id and pog.restaurant_id = po.restaurant_id
       and pog.product_id = v_product.id and pog.active;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'OPTIONS_INVALID';
    end;
    if v_distinct_count <> v_selected_count then
      raise exception using errcode = '22023', message = 'OPTION_NOT_VALID_FOR_PRODUCT';
    end if;

    if exists (
      select 1
      from public.product_option_groups pog
      where pog.product_id = v_product.id and pog.active
        and (
          (select count(*)
           from jsonb_array_elements_text(v_option_ids) selected(value)
           join public.product_options po on po.id = selected.value::uuid
           where po.option_group_id = pog.id) < pog.min_select
          or
          (select count(*)
           from jsonb_array_elements_text(v_option_ids) selected(value)
           join public.product_options po on po.id = selected.value::uuid
           where po.option_group_id = pog.id) > pog.max_select
        )
    ) then
      raise exception using errcode = '22023', message = 'OPTION_GROUP_SELECTION_INVALID';
    end if;

    v_unit_price := case
      when v_product.promotional_price_cents is not null
       and (v_product.promotion_starts_at is null or v_product.promotion_starts_at <= now())
       and (v_product.promotion_ends_at is null or v_product.promotion_ends_at > now())
      then v_product.promotional_price_cents else v_product.base_price_cents end;
    v_pricing := private.calculate_product_base_pricing(
      v_restaurant.id, v_product.id, v_quantity, v_unit_price
    );
    v_base_subtotal := (v_pricing ->> 'baseSubtotalCents')::bigint;
    v_line_total := v_base_subtotal + (v_option_total * v_quantity);
    v_subtotal := v_subtotal + v_line_total;
    v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id,
      'code', v_product.code,
      'name', v_product.name,
      'quantity', v_quantity,
      'unitPriceCents', v_unit_price::text,
      'baseSubtotalCents', v_base_subtotal::text,
      'pricingMode', v_pricing ->> 'mode',
      'pricingBreakdown', v_pricing,
      'optionsTotalUnitCents', v_option_total::text,
      'lineTotalCents', v_line_total::text,
      'notes', nullif(btrim(coalesce(v_item ->> 'notes', '')), ''),
      'options', v_options
    ));
  end loop;

  if v_subtotal < v_restaurant.minimum_order_cents then
    raise exception using errcode = '22023', message = 'MINIMUM_ORDER_NOT_REACHED';
  end if;
  if v_fulfillment = 'delivery' then
    if v_subtotal < v_zone.minimum_order_cents then
      raise exception using errcode = '22023', message = 'DELIVERY_ZONE_MINIMUM_NOT_REACHED';
    end if;
    v_delivery_fee := case
      when v_zone.free_shipping_from_cents is not null
       and v_subtotal >= v_zone.free_shipping_from_cents then 0
      else v_zone.delivery_fee_cents end;
  end if;

  v_adjustment_base := case v_payment.adjustment_scope
    when 'subtotal' then v_subtotal
    when 'shipping' then v_delivery_fee
    when 'total' then v_subtotal + v_delivery_fee
  end;
  v_adjustment := v_payment.adjustment_fixed_cents
    + ((v_adjustment_base * v_payment.adjustment_bps + 5000) / 10000);
  if v_payment.adjustment_type = 'discount' then
    v_discount := least(v_adjustment, v_adjustment_base);
  elsif v_payment.adjustment_type = 'surcharge' then
    v_surcharge := v_adjustment;
  end if;
  v_total := v_subtotal - v_discount + v_surcharge + v_delivery_fee;

  insert into public.restaurant_order_counters (restaurant_id, next_value)
  values (v_restaurant.id, 1)
  on conflict (restaurant_id) do nothing;
  update public.restaurant_order_counters
  set next_value = next_value + 1, updated_at = now()
  where restaurant_id = v_restaurant.id
  returning next_value - 1 into v_order_number;
  v_display_number := v_restaurant.order_prefix || '-' || lpad(v_order_number::text, 6, '0');

  insert into public.orders (
    restaurant_id, idempotency_key, display_number, status,
    customer_name, customer_phone, fulfillment_type, delivery_zone_id,
    delivery_address, delivery_city, delivery_neighborhood, delivery_floor,
    delivery_apartment, delivery_reference, customer_notes,
    payment_method_id, payment_method_name_snapshot,
    payment_adjustment_type_snapshot, payment_adjustment_scope_snapshot,
    payment_adjustment_bps_snapshot, payment_adjustment_fixed_cents_snapshot,
    payment_transfer_alias_snapshot, payment_account_holder_snapshot,
    payment_bank_name_snapshot, payment_instructions_snapshot,
    subtotal_cents, discount_cents, surcharge_cents, delivery_fee_cents,
    total_cents, currency_code, expires_at
  ) values (
    v_restaurant.id, v_idempotency_key, v_display_number, 'generated',
    v_customer_name, v_customer_phone, v_fulfillment, v_zone_id,
    v_delivery_address, v_delivery_city, v_delivery_neighborhood, v_delivery_floor,
    v_delivery_apartment, v_delivery_reference, v_notes,
    v_payment.id, v_payment.name,
    v_payment.adjustment_type, v_payment.adjustment_scope,
    v_payment.adjustment_bps, v_payment.adjustment_fixed_cents,
    v_payment.transfer_alias, v_payment.account_holder,
    v_payment.bank_name, v_payment.instructions,
    v_subtotal, v_discount, v_surcharge, v_delivery_fee,
    v_total, v_restaurant.currency_code, now() + interval '2 hours'
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(v_canonical_items) loop
    declare v_order_item_id uuid;
    begin
      insert into public.order_items (
        restaurant_id, order_id, product_id, product_code_snapshot,
        product_name_snapshot, quantity, unit_price_cents,
        base_subtotal_cents, pricing_mode_snapshot, pricing_breakdown_snapshot,
        options_total_unit_cents, line_total_cents, notes
      ) values (
        v_restaurant.id, v_order_id, (v_item ->> 'productId')::uuid,
        v_item ->> 'code', v_item ->> 'name', (v_item ->> 'quantity')::integer,
        (v_item ->> 'unitPriceCents')::bigint,
        (v_item ->> 'baseSubtotalCents')::bigint,
        v_item ->> 'pricingMode', v_item -> 'pricingBreakdown',
        (v_item ->> 'optionsTotalUnitCents')::bigint,
        (v_item ->> 'lineTotalCents')::bigint, v_item ->> 'notes'
      ) returning id into v_order_item_id;

      insert into public.order_item_options (
        restaurant_id, order_item_id, product_option_id,
        group_name_snapshot, option_name_snapshot, price_delta_cents
      )
      select v_restaurant.id, v_order_item_id, (opt ->> 'id')::uuid,
             opt ->> 'groupName', opt ->> 'name', (opt ->> 'priceDeltaCents')::bigint
      from jsonb_array_elements(v_item -> 'options') opt;
    end;
  end loop;

  begin
    v_token_expires := coalesce((p_request ->> 'tokenExpiresAt')::timestamptz, now() + interval '15 minutes');
  exception when others then
    v_token_expires := now() + interval '15 minutes';
  end;
  if v_token_expires <= now() or v_token_expires > now() + interval '1 hour' then
    v_token_expires := now() + interval '15 minutes';
  end if;
  insert into private.order_client_event_tokens (order_id, token_hash, expires_at)
  values (v_order_id, p_client_event_token_hash, v_token_expires);
  v_token_stored := true;

  insert into public.order_events (
    restaurant_id, order_id, event_type, to_status, actor_type,
    metadata
  ) values (
    v_restaurant.id, v_order_id, 'order_generated', 'generated', 'customer',
    jsonb_build_object('fulfillmentType', v_fulfillment)
  );

  return private.create_order_response(v_order_id, false)
    || jsonb_build_object('clientEventTokenStored', v_token_stored,
                          'clientEventExpiresAt', v_token_expires);
exception
  when unique_violation then
    select o.id into v_order_id from public.orders o
    where o.restaurant_id = v_restaurant.id and o.idempotency_key = v_idempotency_key;
    if v_order_id is not null then
      begin
        v_token_expires := coalesce((p_request ->> 'tokenExpiresAt')::timestamptz, now() + interval '15 minutes');
      exception when others then
        v_token_expires := now() + interval '15 minutes';
      end;
      if v_token_expires <= now() or v_token_expires > now() + interval '1 hour' then
        v_token_expires := now() + interval '15 minutes';
      end if;
      update private.order_client_event_tokens t
      set token_hash = p_client_event_token_hash, expires_at = v_token_expires
      from public.orders o
      where t.order_id = v_order_id and o.id = t.order_id
        and t.used_at is null and o.status in ('generated', 'whatsapp_opened');
      get diagnostics v_selected_count = row_count;
      return private.create_order_response(v_order_id, true)
        || jsonb_build_object('clientEventTokenStored', v_selected_count = 1,
                              'clientEventExpiresAt', v_token_expires);
    end if;
    raise;
end;
$$;

revoke all on function public.create_order_transaction(jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_order_transaction(jsonb, text, text, text)
  to service_role;
