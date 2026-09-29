create or replace function private.slugify(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(
    lower(translate(coalesce(p_value, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')),
    '[^a-z0-9]+', '-', 'g'
  ))
$$;

create or replace function public.create_restaurant_transaction(
  p_payload jsonb,
  p_actor_id uuid,
  p_admin_user_id uuid,
  p_admin_email text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_slug text;
  v_prefix text;
  v_response jsonb;
  v_inserted integer;
  v_membership_status public.membership_status;
  v_initial_fee bigint;
begin
  if jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 32768 then
    raise exception using errcode = '22023', message = 'RESTAURANT_PAYLOAD_INVALID';
  end if;
  if not exists (
    select 1 from public.platform_user_roles pur
    join public.profiles p on p.id = pur.user_id and p.active
    where pur.user_id = p_actor_id and pur.role = 'super_admin'
  ) then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_REQUIRED';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_admin_user_id and lower(u.email) = lower(btrim(p_admin_email))
  ) then
    raise exception using errcode = '22023', message = 'ADMIN_USER_MISMATCH';
  end if;

  insert into private.operation_idempotency (operation, idempotency_key, actor_user_id)
  values ('create_restaurant', p_idempotency_key, p_actor_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select oi.response into v_response
    from private.operation_idempotency oi
    where oi.operation = 'create_restaurant' and oi.idempotency_key = p_idempotency_key
      and oi.actor_user_id = p_actor_id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'IDEMPOTENCY_KEY_OWNERSHIP_MISMATCH';
    end if;
    if v_response is not null then
      if v_response #>> '{membership,userId}' <> p_admin_user_id::text
         or v_response #>> '{restaurant,slug}' <>
            private.slugify(coalesce(p_payload ->> 'slug', p_payload ->> 'name')) then
        raise exception using errcode = '22023', message = 'IDEMPOTENCY_CONFLICT';
      end if;
      return v_response || jsonb_build_object('idempotentReplay', true);
    end if;
  end if;

  v_slug := private.slugify(coalesce(p_payload ->> 'slug', p_payload ->> 'name'));
  if char_length(v_slug) not between 2 and 80 then
    raise exception using errcode = '22023', message = 'SLUG_INVALID';
  end if;
  v_prefix := upper(coalesce(nullif(p_payload ->> 'orderPrefix', ''),
                             left(regexp_replace(v_slug, '[^a-z0-9]', '', 'g'), 6)));
  if char_length(v_prefix) < 2 then v_prefix := 'ORD'; end if;

  begin
    v_initial_fee := coalesce((p_payload ->> 'initialDeliveryFeeCents')::bigint, 0);
  exception when others then
    raise exception using errcode = '22023', message = 'INITIAL_DELIVERY_FEE_INVALID';
  end;
  if v_initial_fee < 0 then
    raise exception using errcode = '22023', message = 'INITIAL_DELIVERY_FEE_INVALID';
  end if;

  insert into public.restaurants (
    name, trade_name, slug, description, whatsapp_phone_e164, address, city,
    timezone, currency_code, locale, primary_color, secondary_color,
    delivery_enabled, pickup_enabled, minimum_order_cents,
    default_preparation_minutes, order_prefix, created_by
  ) values (
    btrim(p_payload ->> 'name'),
    btrim(coalesce(p_payload ->> 'tradeName', p_payload ->> 'name')),
    v_slug,
    btrim(coalesce(p_payload ->> 'description', '')),
    btrim(coalesce(p_payload ->> 'whatsappPhoneE164', p_payload ->> 'whatsappPhone')),
    btrim(coalesce(p_payload ->> 'address', '')),
    btrim(coalesce(p_payload ->> 'city', '')),
    coalesce(nullif(p_payload ->> 'timezone', ''), 'America/Argentina/Cordoba'),
    upper(coalesce(nullif(p_payload ->> 'currencyCode', ''), 'ARS')),
    coalesce(nullif(p_payload ->> 'locale', ''), 'es-AR'),
    coalesce(nullif(p_payload ->> 'primaryColor', ''), '#E85D2A'),
    coalesce(nullif(p_payload ->> 'secondaryColor', ''), '#1F2937'),
    coalesce((p_payload ->> 'deliveryEnabled')::boolean, true),
    coalesce((p_payload ->> 'pickupEnabled')::boolean, true),
    coalesce((p_payload ->> 'minimumOrderCents')::bigint, 0),
    coalesce((p_payload ->> 'defaultPreparationMinutes')::integer, 30),
    v_prefix,
    p_actor_id
  ) returning id into v_restaurant_id;

  insert into public.restaurant_order_counters (restaurant_id, next_value)
  values (v_restaurant_id, 1);

  if coalesce((p_payload ->> 'createDefaultPaymentMethods')::boolean, true) then
    insert into public.payment_methods (
      restaurant_id, code, name, description, sort_order
    ) values
      (v_restaurant_id, 'cash', 'Efectivo', '', 10),
      (v_restaurant_id, 'transfer', 'Transferencia', '', 20);
  end if;

  if (p_payload ? 'initialDeliveryFeeCents') then
    insert into public.delivery_zones (
      restaurant_id, name, description, delivery_fee_cents, sort_order
    ) values (v_restaurant_id, 'Zona inicial', '', v_initial_fee, 10);
  end if;

  insert into public.profiles (id, full_name, email, active)
  select u.id, left(btrim(coalesce(p_payload ->> 'adminName', '')), 120), lower(u.email), true
  from auth.users u where u.id = p_admin_user_id
  on conflict (id) do update set
    full_name = case when excluded.full_name <> '' then excluded.full_name else public.profiles.full_name end,
    email = excluded.email,
    updated_at = now();

  select case when u.email_confirmed_at is null then 'invited'::public.membership_status
                   else 'active'::public.membership_status end
  into v_membership_status from auth.users u where u.id = p_admin_user_id;

  insert into public.restaurant_members (
    restaurant_id, user_id, role, status, invited_by
  ) values (
    v_restaurant_id, p_admin_user_id, 'restaurant_admin', v_membership_status, p_actor_id
  );

  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id, after_data, metadata
  ) values
    (v_restaurant_id, p_actor_id, 'create', 'restaurant', v_restaurant_id,
     jsonb_build_object('slug', v_slug, 'status', 'draft'), '{}'::jsonb),
    (v_restaurant_id, p_actor_id, 'invite', 'restaurant_member', p_admin_user_id,
     jsonb_build_object('role', 'restaurant_admin', 'status', v_membership_status), '{}'::jsonb);

  v_response := jsonb_build_object(
    'idempotentReplay', false,
    'restaurant', jsonb_build_object('id', v_restaurant_id, 'slug', v_slug, 'status', 'draft'),
    'membership', jsonb_build_object(
      'userId', p_admin_user_id, 'role', 'restaurant_admin', 'status', v_membership_status
    )
  );
  update private.operation_idempotency set response = v_response
  where operation = 'create_restaurant' and idempotency_key = p_idempotency_key;
  return v_response;
exception when unique_violation then
  if exists (select 1 from public.restaurants r where r.slug = v_slug) then
    raise exception using errcode = '23505', message = 'RESTAURANT_SLUG_ALREADY_EXISTS';
  end if;
  raise;
end;
$$;

create or replace function public.upsert_restaurant_membership(
  p_restaurant_id uuid,
  p_user_id uuid,
  p_role public.restaurant_role,
  p_status public.membership_status,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_super boolean;
  v_member public.restaurant_members%rowtype;
begin
  select exists (
    select 1 from public.platform_user_roles pur
    join public.profiles p on p.id = pur.user_id and p.active
    where pur.user_id = p_actor_id and pur.role = 'super_admin'
  ) into v_actor_super;

  if not v_actor_super and not exists (
    select 1 from public.restaurant_members rm
    join public.profiles p on p.id = rm.user_id and p.active
    where rm.restaurant_id = p_restaurant_id and rm.user_id = p_actor_id
      and rm.role = 'restaurant_admin' and rm.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_MANAGEMENT_FORBIDDEN';
  end if;
  if not v_actor_super and p_role <> 'order_manager' then
    raise exception using errcode = '42501', message = 'ROLE_ASSIGNMENT_FORBIDDEN';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.active) then
    raise exception using errcode = '22023', message = 'TARGET_USER_INVALID';
  end if;

  insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by)
  values (p_restaurant_id, p_user_id, p_role, p_status, p_actor_id)
  on conflict (restaurant_id, user_id) do update
    set role = excluded.role, status = excluded.status,
        invited_by = excluded.invited_by, updated_at = now()
  returning * into v_member;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id, after_data
  ) values (
    p_restaurant_id, p_actor_id,
    case when p_status = 'suspended' then 'suspend'::public.audit_action else 'invite'::public.audit_action end,
    'restaurant_member', v_member.id,
    jsonb_build_object('userId', p_user_id, 'role', p_role, 'status', p_status)
  );

  return jsonb_build_object(
    'id', v_member.id, 'restaurantId', v_member.restaurant_id,
    'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status
  );
end;
$$;

create or replace function public.import_products_batch(
  p_restaurant_id uuid,
  p_rows jsonb,
  p_mode text default 'upsert'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_products jsonb;
  v_groups jsonb;
  v_options jsonb;
  v_row jsonb;
  v_category_id uuid;
  v_product_id uuid;
  v_group_id uuid;
  v_slug text;
  v_code text;
  v_group_code text;
  v_exists boolean;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_groups_count integer := 0;
  v_options_count integer := 0;
  v_product_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_IMPORT_FORBIDDEN';
  end if;
  if p_mode not in ('create', 'update', 'skip', 'upsert') then
    raise exception using errcode = '22023', message = 'IMPORT_MODE_INVALID';
  end if;
  if pg_column_size(p_rows) > 2097152 then
    raise exception using errcode = '22023', message = 'IMPORT_PAYLOAD_TOO_LARGE';
  end if;

  if jsonb_typeof(p_rows) = 'array' then
    v_products := p_rows; v_groups := '[]'::jsonb; v_options := '[]'::jsonb;
  elsif jsonb_typeof(p_rows) = 'object' then
    v_products := coalesce(p_rows -> 'products', '[]'::jsonb);
    v_groups := coalesce(p_rows -> 'optionGroups', '[]'::jsonb);
    v_options := coalesce(p_rows -> 'options', '[]'::jsonb);
  else
    raise exception using errcode = '22023', message = 'IMPORT_ROWS_INVALID';
  end if;
  if jsonb_typeof(v_products) <> 'array' or jsonb_array_length(v_products) > 500
     or jsonb_typeof(v_groups) <> 'array' or jsonb_array_length(v_groups) > 2500
     or jsonb_typeof(v_options) <> 'array' or jsonb_array_length(v_options) > 10000 then
    raise exception using errcode = '22023', message = 'IMPORT_LIMIT_EXCEEDED';
  end if;

  for v_row in select value from jsonb_array_elements(v_products) loop
    v_code := btrim(coalesce(v_row ->> 'code', ''));
    if char_length(v_code) not between 1 and 80
       or char_length(btrim(coalesce(v_row ->> 'name', ''))) not between 1 and 160 then
      raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_INVALID';
    end if;
    v_slug := private.slugify(coalesce(v_row ->> 'categorySlug', v_row ->> 'category'));
    if v_slug = '' then raise exception using errcode = '22023', message = 'IMPORT_CATEGORY_INVALID'; end if;

    select c.id into v_category_id from public.categories c
    where c.restaurant_id = p_restaurant_id and c.slug = v_slug and c.deleted_at is null;
    if not found then
      insert into public.categories (restaurant_id, name, slug, created_by, updated_by)
      values (p_restaurant_id, btrim(v_row ->> 'category'), v_slug, v_uid, v_uid)
      returning id into v_category_id;
    end if;

    select p.id into v_product_id from public.products p
    where p.restaurant_id = p_restaurant_id and lower(p.code) = lower(v_code) and p.deleted_at is null;
    v_exists := found;
    if v_exists and p_mode = 'create' then
      raise exception using errcode = '23505', message = 'IMPORT_PRODUCT_CODE_EXISTS';
    elsif not v_exists and p_mode = 'update' then
      raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_NOT_FOUND';
    elsif v_exists and p_mode = 'skip' then
      v_skipped := v_skipped + 1;
      v_product_results := v_product_results || jsonb_build_array(
        jsonb_build_object('code', v_code, 'id', v_product_id)
      );
      continue;
    end if;

    if v_exists then
      update public.products set
        category_id = v_category_id,
        name = btrim(v_row ->> 'name'),
        description = btrim(coalesce(v_row ->> 'description', '')),
        base_price_cents = (v_row ->> 'basePriceCents')::bigint,
        promotional_price_cents = nullif(v_row ->> 'promotionalPriceCents', '')::bigint,
        promotion_starts_at = nullif(v_row ->> 'promotionStartsAt', '')::timestamptz,
        promotion_ends_at = nullif(v_row ->> 'promotionEndsAt', '')::timestamptz,
        active = coalesce((v_row ->> 'active')::boolean, true),
        available = coalesce((v_row ->> 'available')::boolean, true),
        featured = coalesce((v_row ->> 'featured')::boolean, false),
        sort_order = coalesce((v_row ->> 'sortOrder')::integer, 0),
        updated_by = v_uid
      where id = v_product_id;
      v_updated := v_updated + 1;
    else
      insert into public.products (
        restaurant_id, category_id, code, name, description, base_price_cents,
        promotional_price_cents, promotion_starts_at, promotion_ends_at,
        active, available, featured, sort_order, created_by, updated_by
      ) values (
        p_restaurant_id, v_category_id, v_code, btrim(v_row ->> 'name'),
        btrim(coalesce(v_row ->> 'description', '')), (v_row ->> 'basePriceCents')::bigint,
        nullif(v_row ->> 'promotionalPriceCents', '')::bigint,
        nullif(v_row ->> 'promotionStartsAt', '')::timestamptz,
        nullif(v_row ->> 'promotionEndsAt', '')::timestamptz,
        coalesce((v_row ->> 'active')::boolean, true),
        coalesce((v_row ->> 'available')::boolean, true),
        coalesce((v_row ->> 'featured')::boolean, false),
        coalesce((v_row ->> 'sortOrder')::integer, 0), v_uid, v_uid
      ) returning id into v_product_id;
      v_created := v_created + 1;
    end if;
    v_product_results := v_product_results || jsonb_build_array(
      jsonb_build_object('code', v_code, 'id', v_product_id)
    );
  end loop;

  for v_row in select value from jsonb_array_elements(v_groups) loop
    v_code := btrim(coalesce(v_row ->> 'productCode', ''));
    v_group_code := btrim(coalesce(v_row ->> 'groupCode', ''));
    select p.id into v_product_id from public.products p
    where p.restaurant_id = p_restaurant_id and lower(p.code) = lower(v_code) and p.deleted_at is null;
    if not found or v_group_code = '' then
      raise exception using errcode = '22023', message = 'IMPORT_OPTION_GROUP_INVALID';
    end if;
    insert into public.product_option_groups (
      restaurant_id, product_id, code, name, required, min_select, max_select, sort_order, active
    ) values (
      p_restaurant_id, v_product_id, v_group_code, btrim(v_row ->> 'name'),
      coalesce((v_row ->> 'required')::boolean, false),
      coalesce((v_row ->> 'minSelect')::integer, 0),
      coalesce((v_row ->> 'maxSelect')::integer, 1),
      coalesce((v_row ->> 'sortOrder')::integer, 0),
      coalesce((v_row ->> 'active')::boolean, true)
    ) on conflict (product_id, lower(code)) where code is not null do update set
      name = excluded.name, required = excluded.required,
      min_select = excluded.min_select, max_select = excluded.max_select,
      sort_order = excluded.sort_order, active = excluded.active, updated_at = now()
    returning id into v_group_id;
    v_groups_count := v_groups_count + 1;
  end loop;

  for v_row in select value from jsonb_array_elements(v_options) loop
    v_code := btrim(coalesce(v_row ->> 'productCode', ''));
    v_group_code := btrim(coalesce(v_row ->> 'groupCode', ''));
    select pog.id into v_group_id
    from public.product_option_groups pog
    join public.products p on p.id = pog.product_id
    where p.restaurant_id = p_restaurant_id and lower(p.code) = lower(v_code)
      and lower(pog.code) = lower(v_group_code);
    if not found or btrim(coalesce(v_row ->> 'optionCode', '')) = '' then
      raise exception using errcode = '22023', message = 'IMPORT_OPTION_INVALID';
    end if;
    insert into public.product_options (
      restaurant_id, option_group_id, code, name, price_delta_cents, sort_order, active
    ) values (
      p_restaurant_id, v_group_id, btrim(v_row ->> 'optionCode'), btrim(v_row ->> 'name'),
      coalesce((v_row ->> 'priceDeltaCents')::bigint, 0),
      coalesce((v_row ->> 'sortOrder')::integer, 0),
      coalesce((v_row ->> 'active')::boolean, true)
    ) on conflict (option_group_id, lower(code)) where code is not null do update set
      name = excluded.name, price_delta_cents = excluded.price_delta_cents,
      sort_order = excluded.sort_order, active = excluded.active, updated_at = now();
    v_options_count := v_options_count + 1;
  end loop;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, metadata
  ) values (
    p_restaurant_id, v_uid, 'import', 'product_batch',
    jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped,
                       'groups', v_groups_count, 'options', v_options_count, 'mode', p_mode)
  );
  return jsonb_build_object(
    'summary', jsonb_build_object(
      'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
      'optionGroups', v_groups_count, 'options', v_options_count
    ),
    'products', v_product_results,
    'errors', '[]'::jsonb
  );
exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
  raise exception using errcode = '22023', message = 'IMPORT_VALUE_INVALID';
end;
$$;

revoke all on function private.slugify(text) from public, anon, authenticated;
revoke all on function public.create_restaurant_transaction(jsonb, uuid, uuid, text, uuid) from public;
revoke all on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) from public;
revoke all on function public.import_products_batch(uuid, jsonb, text) from public;

grant execute on function public.create_restaurant_transaction(jsonb, uuid, uuid, text, uuid) to service_role;
grant execute on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) to service_role;
grant execute on function public.import_products_batch(uuid, jsonb, text) to authenticated;
