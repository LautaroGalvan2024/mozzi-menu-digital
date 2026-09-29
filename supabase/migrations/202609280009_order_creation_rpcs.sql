create or replace function public.check_rate_limit(
  p_key_hash text,
  p_restaurant_id uuid,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_key_hash !~ '^[0-9a-f]{64}$'
     or p_limit not between 1 and 100000
     or p_window_seconds not between 10 and 86400 then
    raise exception using errcode = '22023', message = 'RATE_LIMIT_ARGUMENT_INVALID';
  end if;
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    raise exception using errcode = '22023', message = 'RESTAURANT_NOT_FOUND';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into private.rate_limits (key_hash, restaurant_id, window_start, request_count, updated_at)
  values (p_key_hash, p_restaurant_id, v_window_start, 1, now())
  on conflict (key_hash, restaurant_id, window_start) do update
    set request_count = private.rate_limits.request_count + 1,
        updated_at = now()
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

create or replace function public.cleanup_rate_limits(p_before timestamptz default now() - interval '2 days')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  delete from private.rate_limits where window_start < p_before;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Called by the public Edge Function in its own database transaction before order creation.
-- Keeping this consumption separate ensures invalid-but-well-formed catalogue attempts cannot
-- roll back their rate-limit counters together with the order transaction.
create or replace function public.check_order_rate_limits(
  p_restaurant_slug text,
  p_ip_hash text,
  p_phone_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_restaurant_hash text;
  v_ip_allowed boolean;
  v_phone_allowed boolean;
  v_restaurant_allowed boolean;
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$' or p_phone_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'HASH_ARGUMENT_INVALID';
  end if;
  select r.id into v_restaurant_id
  from public.restaurants r
  where r.slug = lower(btrim(p_restaurant_slug));
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'RESTAURANT_NOT_AVAILABLE');
  end if;

  v_restaurant_hash := encode(
    extensions.digest(convert_to('restaurant:' || v_restaurant_id::text, 'UTF8'), 'sha256'),
    'hex'
  );
  -- Deliberately evaluate all three so every dimension observes every attempt.
  v_ip_allowed := public.check_rate_limit(p_ip_hash, v_restaurant_id, 10, 600);
  v_phone_allowed := public.check_rate_limit(p_phone_hash, v_restaurant_id, 5, 600);
  v_restaurant_allowed := public.check_rate_limit(v_restaurant_hash, v_restaurant_id, 100, 600);

  if not (v_ip_allowed and v_phone_allowed and v_restaurant_allowed) then
    return jsonb_build_object('allowed', false, 'code', 'RATE_LIMITED');
  end if;
  return jsonb_build_object('allowed', true, 'code', null);
end;
$$;

create or replace function private.create_order_response(p_order_id uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'idempotentReplay', p_replay,
    'order', jsonb_build_object(
      'actionId', o.action_id,
      'displayNumber', o.display_number,
      'status', o.status,
      'totalCents', o.total_cents::text,
      'currencyCode', o.currency_code,
      'createdAt', o.created_at,
      'customerName', o.customer_name,
      'customerPhone', o.customer_phone,
      'fulfillmentType', o.fulfillment_type,
      'deliveryAddress', o.delivery_address,
      'deliveryCity', o.delivery_city,
      'deliveryNeighborhood', o.delivery_neighborhood,
      'deliveryFloor', o.delivery_floor,
      'deliveryApartment', o.delivery_apartment,
      'deliveryReference', o.delivery_reference,
      'customerNotes', o.customer_notes,
      'subtotalCents', o.subtotal_cents::text,
      'discountCents', o.discount_cents::text,
      'surchargeCents', o.surcharge_cents::text,
      'deliveryFeeCents', o.delivery_fee_cents::text,
      'paymentMethodName', o.payment_method_name_snapshot,
      'paymentInstructions', o.payment_instructions_snapshot,
      'transferAlias', o.payment_transfer_alias_snapshot
    ),
    'restaurant', jsonb_build_object(
      'name', r.trade_name,
      'timezone', r.timezone,
      'locale', r.locale,
      'whatsappPhone', r.whatsapp_phone_e164
    ),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', oi.product_name_snapshot,
          'quantity', oi.quantity,
          'lineTotalCents', oi.line_total_cents::text,
          'notes', oi.notes,
          'options', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'name', oio.option_name_snapshot,
                'priceDeltaCents', oio.price_delta_cents::text
              ) order by oio.created_at, oio.id
            ) from public.order_item_options oio where oio.order_item_id = oi.id
          ), '[]'::jsonb)
        ) order by oi.created_at, oi.id
      ) from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.restaurants r on r.id = o.restaurant_id
  where o.id = p_order_id
$$;

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
  v_canonical_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_total_quantity integer := 0;
  v_selected_count integer;
  v_distinct_count integer;
  v_option_total bigint;
  v_unit_price bigint;
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

  -- A genuine retry is returned before consuming a new rate-limit slot. The UUID key
  -- carries 122 random bits and the Edge Function still applies its outer abuse controls.
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
    if v_quantity not between 1 and 50
       or char_length(coalesce(v_item ->> 'notes', '')) > 500 then
      raise exception using errcode = '22023', message = 'ITEM_LIMIT_INVALID';
    end if;
    v_total_quantity := v_total_quantity + v_quantity;
    if v_total_quantity > 100 then
      raise exception using errcode = '22023', message = 'TOTAL_QUANTITY_EXCEEDED';
    end if;

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

    v_option_ids := coalesce(v_item -> 'optionIds', '[]'::jsonb);
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
    v_line_total := (v_unit_price + v_option_total) * v_quantity;
    v_subtotal := v_subtotal + v_line_total;
    v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id,
      'code', v_product.code,
      'name', v_product.name,
      'quantity', v_quantity,
      'unitPriceCents', v_unit_price::text,
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
        options_total_unit_cents, line_total_cents, notes
      ) values (
        v_restaurant.id, v_order_id, (v_item ->> 'productId')::uuid,
        v_item ->> 'code', v_item ->> 'name', (v_item ->> 'quantity')::integer,
        (v_item ->> 'unitPriceCents')::bigint,
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

create or replace function public.register_whatsapp_opened(
  p_action_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_token private.order_client_event_tokens%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('registered', false, 'code', 'INVALID_OR_EXPIRED_TOKEN');
  end if;

  select o.* into v_order from public.orders o where o.action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('registered', false, 'code', 'INVALID_OR_EXPIRED_TOKEN');
  end if;
  select t.* into v_token from private.order_client_event_tokens t
  where t.order_id = v_order.id
    and extensions.digest(convert_to(t.token_hash, 'UTF8'), 'sha256')
      = extensions.digest(convert_to(p_token_hash, 'UTF8'), 'sha256')
  for update;
  if not found or v_token.expires_at <= now() then
    return jsonb_build_object('registered', false, 'code', 'INVALID_OR_EXPIRED_TOKEN');
  end if;

  if v_token.used_at is not null then
    return jsonb_build_object(
      'registered', v_order.whatsapp_opened_at is not null,
      'idempotentReplay', true
    );
  end if;

  update private.order_client_event_tokens set used_at = now() where order_id = v_order.id;
  if v_order.status = 'generated' then
    perform set_config('app.order_mutation', 'on', true);
    update public.orders
    set status = 'whatsapp_opened', whatsapp_opened_at = now()
    where id = v_order.id;
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type
    ) values (
      v_order.restaurant_id, v_order.id, 'whatsapp_opened', 'generated',
      'whatsapp_opened', 'customer'
    );
    return jsonb_build_object('registered', true, 'idempotentReplay', false);
  end if;

  return jsonb_build_object(
    'registered', v_order.whatsapp_opened_at is not null,
    'idempotentReplay', false,
    'alreadyAdvanced', true
  );
end;
$$;

revoke all on function public.check_rate_limit(text, uuid, integer, integer) from public;
revoke all on function public.cleanup_rate_limits(timestamptz) from public;
revoke all on function public.check_order_rate_limits(text, text, text) from public;
revoke all on function private.create_order_response(uuid, boolean) from public, anon, authenticated;
revoke all on function public.create_order_transaction(jsonb, text, text, text) from public;
revoke all on function public.register_whatsapp_opened(uuid, text) from public;

grant execute on function public.check_rate_limit(text, uuid, integer, integer) to service_role;
grant execute on function public.cleanup_rate_limits(timestamptz) to service_role;
grant execute on function public.check_order_rate_limits(text, text, text) to service_role;
grant execute on function public.create_order_transaction(jsonb, text, text, text) to service_role;
grant execute on function public.register_whatsapp_opened(uuid, text) to service_role;
