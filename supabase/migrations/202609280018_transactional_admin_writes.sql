-- Close the remaining partial-write paths in catalogue and schedule administration,
-- and make "skip existing" apply to the complete imported product graph.

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
  v_outcome text;
  v_skipped_codes text[] := array[]::text[];
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
    v_products := p_rows;
    v_groups := '[]'::jsonb;
    v_options := '[]'::jsonb;
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

    select p.id into v_product_id
    from public.products p
    where p.restaurant_id = p_restaurant_id
      and lower(p.code) = lower(v_code)
      and p.deleted_at is null;
    v_exists := found;
    if v_exists and p_mode = 'create' then
      raise exception using errcode = '23505', message = 'IMPORT_PRODUCT_CODE_EXISTS';
    elsif not v_exists and p_mode = 'update' then
      raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_NOT_FOUND';
    elsif v_exists and p_mode = 'skip' then
      v_skipped := v_skipped + 1;
      v_skipped_codes := array_append(v_skipped_codes, lower(v_code));
      v_product_results := v_product_results || jsonb_build_array(
        jsonb_build_object('code', v_code, 'id', v_product_id, 'outcome', 'skipped')
      );
      continue;
    end if;

    v_slug := private.slugify(coalesce(v_row ->> 'categorySlug', v_row ->> 'category'));
    if v_slug = '' or char_length(v_slug) > 100 then
      raise exception using errcode = '22023', message = 'IMPORT_CATEGORY_INVALID';
    end if;
    select c.id into v_category_id
    from public.categories c
    where c.restaurant_id = p_restaurant_id and c.slug = v_slug and c.deleted_at is null;
    if not found then
      insert into public.categories (restaurant_id, name, slug, created_by, updated_by)
      values (p_restaurant_id, btrim(v_row ->> 'category'), v_slug, v_uid, v_uid)
      returning id into v_category_id;
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
      where id = v_product_id and restaurant_id = p_restaurant_id;
      v_updated := v_updated + 1;
      v_outcome := 'updated';
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
      v_outcome := 'created';
    end if;
    v_product_results := v_product_results || jsonb_build_array(
      jsonb_build_object('code', v_code, 'id', v_product_id, 'outcome', v_outcome)
    );
  end loop;

  for v_row in select value from jsonb_array_elements(v_groups) loop
    v_code := btrim(coalesce(v_row ->> 'productCode', ''));
    if lower(v_code) = any(v_skipped_codes) then continue; end if;
    v_group_code := btrim(coalesce(v_row ->> 'groupCode', ''));
    select p.id into v_product_id
    from public.products p
    where p.restaurant_id = p_restaurant_id
      and lower(p.code) = lower(v_code)
      and p.deleted_at is null;
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
    if lower(v_code) = any(v_skipped_codes) then continue; end if;
    v_group_code := btrim(coalesce(v_row ->> 'groupCode', ''));
    select pog.id into v_group_id
    from public.product_option_groups pog
    join public.products p on p.id = pog.product_id
    where p.restaurant_id = p_restaurant_id
      and lower(p.code) = lower(v_code)
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

create or replace function public.save_restaurant_hours(
  p_restaurant_id uuid,
  p_regular jsonb,
  p_special jsonb,
  p_delete_regular_ids uuid[] default '{}'::uuid[],
  p_delete_special_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row jsonb;
  v_regular_count integer := 0;
  v_special_count integer := 0;
begin
  if v_uid is null or not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'HOURS_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_regular) <> 'array' or jsonb_array_length(p_regular) > 147
     or jsonb_typeof(p_special) <> 'array' or jsonb_array_length(p_special) > 1000
     or pg_column_size(p_regular) + pg_column_size(p_special) > 1048576 then
    raise exception using errcode = '22023', message = 'HOURS_PAYLOAD_INVALID';
  end if;
  if exists (
    select 1 from public.business_hours bh
    where bh.id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]))
      and bh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1 from public.special_hours sh
    where sh.id = any(coalesce(p_delete_special_ids, '{}'::uuid[]))
      and sh.restaurant_id <> p_restaurant_id
  ) then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;

  delete from public.business_hours
  where restaurant_id = p_restaurant_id and id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]));
  delete from public.special_hours
  where restaurant_id = p_restaurant_id and id = any(coalesce(p_delete_special_ids, '{}'::uuid[]));

  for v_row in select value from jsonb_array_elements(p_regular) loop
    if exists (
      select 1 from public.business_hours bh
      where bh.id = (v_row ->> 'id')::uuid and bh.restaurant_id <> p_restaurant_id
    ) then
      raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
    end if;
    insert into public.business_hours (
      id, restaurant_id, day_of_week, slot_index, opens_at, closes_at, spans_next_day, active
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'dayOfWeek')::smallint,
      (v_row ->> 'slotIndex')::smallint, (v_row ->> 'opensAt')::time,
      (v_row ->> 'closesAt')::time, coalesce((v_row ->> 'spansNextDay')::boolean, false),
      coalesce((v_row ->> 'active')::boolean, true)
    ) on conflict (id) do update set
      day_of_week = excluded.day_of_week,
      slot_index = excluded.slot_index,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      active = excluded.active,
      updated_at = now()
    where public.business_hours.restaurant_id = p_restaurant_id;
    v_regular_count := v_regular_count + 1;
  end loop;

  for v_row in select value from jsonb_array_elements(p_special) loop
    if exists (
      select 1 from public.special_hours sh
      where sh.id = (v_row ->> 'id')::uuid and sh.restaurant_id <> p_restaurant_id
    ) then
      raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
    end if;
    insert into public.special_hours (
      id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at, spans_next_day, reason
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'date')::date,
      (v_row ->> 'slotIndex')::smallint, coalesce((v_row ->> 'isClosed')::boolean, false),
      nullif(v_row ->> 'opensAt', '')::time, nullif(v_row ->> 'closesAt', '')::time,
      coalesce((v_row ->> 'spansNextDay')::boolean, false), nullif(btrim(v_row ->> 'reason'), '')
    ) on conflict (id) do update set
      date = excluded.date,
      slot_index = excluded.slot_index,
      is_closed = excluded.is_closed,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      reason = excluded.reason,
      updated_at = now()
    where public.special_hours.restaurant_id = p_restaurant_id;
    v_special_count := v_special_count + 1;
  end loop;

  insert into public.audit_logs (restaurant_id, actor_user_id, action, entity_type, metadata)
  values (
    p_restaurant_id, v_uid, 'update', 'restaurant_hours',
    jsonb_build_object('regular', v_regular_count, 'special', v_special_count,
      'deletedRegular', cardinality(coalesce(p_delete_regular_ids, '{}'::uuid[])),
      'deletedSpecial', cardinality(coalesce(p_delete_special_ids, '{}'::uuid[])))
  );
  return jsonb_build_object('regular', v_regular_count, 'special', v_special_count);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or unique_violation then
  raise exception using errcode = '22023', message = 'HOURS_VALUE_INVALID';
end;
$$;

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
  v_uid uuid := auth.uid();
  v_product_id uuid;
  v_category_id uuid;
  v_group jsonb;
  v_option jsonb;
  v_group_id uuid;
  v_option_id uuid;
  v_existed boolean;
  v_group_count integer := 0;
  v_option_count integer := 0;
  v_image_path text;
begin
  if v_uid is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_product) <> 'object' or jsonb_typeof(p_groups) <> 'array'
     or jsonb_array_length(p_groups) > 100
     or pg_column_size(p_product) + pg_column_size(p_groups) > 1048576 then
    raise exception using errcode = '22023', message = 'PRODUCT_PAYLOAD_INVALID';
  end if;
  v_product_id := (p_product ->> 'id')::uuid;
  v_category_id := (p_product ->> 'categoryId')::uuid;
  v_image_path := nullif(p_product ->> 'imagePath', '');
  if v_image_path is not null
     and v_image_path not like 'restaurants/' || p_restaurant_id::text || '/%' then
    raise exception using errcode = '22023', message = 'PRODUCT_IMAGE_PATH_INVALID';
  end if;
  if exists (
    select 1 from public.products p where p.id = v_product_id and p.restaurant_id <> p_restaurant_id
  ) then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;
  select exists (
    select 1 from public.products p where p.id = v_product_id and p.restaurant_id = p_restaurant_id
  ) into v_existed;

  insert into public.products (
    id, restaurant_id, category_id, code, name, description, base_price_cents,
    promotional_price_cents, promotion_starts_at, promotion_ends_at, image_path,
    active, available, featured, sort_order, created_by, updated_by
  ) values (
    v_product_id, p_restaurant_id, v_category_id, btrim(p_product ->> 'code'),
    btrim(p_product ->> 'name'), btrim(coalesce(p_product ->> 'description', '')),
    (p_product ->> 'basePriceCents')::bigint,
    nullif(p_product ->> 'promotionalPriceCents', '')::bigint,
    nullif(p_product ->> 'promotionStartsAt', '')::timestamptz,
    nullif(p_product ->> 'promotionEndsAt', '')::timestamptz,
    v_image_path, coalesce((p_product ->> 'active')::boolean, true),
    coalesce((p_product ->> 'available')::boolean, true),
    coalesce((p_product ->> 'featured')::boolean, false),
    coalesce((p_product ->> 'sortOrder')::integer, 0), v_uid, v_uid
  ) on conflict (id) do update set
    category_id = excluded.category_id,
    code = excluded.code,
    name = excluded.name,
    description = excluded.description,
    base_price_cents = excluded.base_price_cents,
    promotional_price_cents = excluded.promotional_price_cents,
    promotion_starts_at = excluded.promotion_starts_at,
    promotion_ends_at = excluded.promotion_ends_at,
    image_path = excluded.image_path,
    active = excluded.active,
    available = excluded.available,
    featured = excluded.featured,
    sort_order = excluded.sort_order,
    deleted_at = null,
    updated_by = v_uid,
    updated_at = now()
  where public.products.restaurant_id = p_restaurant_id;

  if exists (
    select 1 from public.product_option_groups pog
    where pog.id = any(coalesce(p_removed_group_ids, '{}'::uuid[]))
      and pog.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1 from public.product_options po
    where po.id = any(coalesce(p_removed_option_ids, '{}'::uuid[]))
      and po.restaurant_id <> p_restaurant_id
  ) then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;
  if exists (
    select 1 from public.product_option_groups pog
    where pog.id = any(coalesce(p_removed_group_ids, '{}'::uuid[]))
      and pog.restaurant_id = p_restaurant_id
      and pog.product_id <> v_product_id
  ) or exists (
    select 1
    from public.product_options po
    join public.product_option_groups pog on pog.id = po.option_group_id
    where po.id = any(coalesce(p_removed_option_ids, '{}'::uuid[]))
      and po.restaurant_id = p_restaurant_id
      and pog.product_id <> v_product_id
  ) then
    raise exception using errcode = '42501', message = 'PRODUCT_REFERENCE_INVALID';
  end if;
  update public.product_option_groups set active = false, updated_at = now()
  where restaurant_id = p_restaurant_id and product_id = v_product_id
    and id = any(coalesce(p_removed_group_ids, '{}'::uuid[]));
  update public.product_options po set active = false, updated_at = now()
  from public.product_option_groups pog
  where po.option_group_id = pog.id
    and po.restaurant_id = p_restaurant_id
    and pog.restaurant_id = p_restaurant_id
    and pog.product_id = v_product_id
    and po.id = any(coalesce(p_removed_option_ids, '{}'::uuid[]));
  update public.product_options po set active = false, updated_at = now()
  where po.restaurant_id = p_restaurant_id
    and po.option_group_id = any(coalesce(p_removed_group_ids, '{}'::uuid[]));

  for v_group in select value from jsonb_array_elements(p_groups) loop
    v_group_id := (v_group ->> 'id')::uuid;
    if jsonb_typeof(coalesce(v_group -> 'options', '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(v_group -> 'options', '[]'::jsonb)) > 500 then
      raise exception using errcode = '22023', message = 'PRODUCT_OPTIONS_INVALID';
    end if;
    if exists (
      select 1 from public.product_option_groups pog
      where pog.id = v_group_id and pog.restaurant_id <> p_restaurant_id
    ) or exists (
      select 1 from public.product_option_groups pog
      where pog.id = v_group_id and pog.restaurant_id = p_restaurant_id
        and pog.product_id <> v_product_id
    ) then
      raise exception using errcode = '42501', message = 'PRODUCT_REFERENCE_INVALID';
    end if;
    insert into public.product_option_groups (
      id, restaurant_id, product_id, name, required, min_select, max_select, sort_order, active
    ) values (
      v_group_id, p_restaurant_id, v_product_id, btrim(v_group ->> 'name'),
      coalesce((v_group ->> 'required')::boolean, false),
      coalesce((v_group ->> 'minSelect')::integer, 0),
      coalesce((v_group ->> 'maxSelect')::integer, 1),
      coalesce((v_group ->> 'sortOrder')::integer, 0),
      coalesce((v_group ->> 'active')::boolean, true)
    ) on conflict (id) do update set
      name = excluded.name,
      required = excluded.required,
      min_select = excluded.min_select,
      max_select = excluded.max_select,
      sort_order = excluded.sort_order,
      active = excluded.active,
      updated_at = now()
    where public.product_option_groups.restaurant_id = p_restaurant_id
      and public.product_option_groups.product_id = v_product_id;
    v_group_count := v_group_count + 1;

    for v_option in select value from jsonb_array_elements(coalesce(v_group -> 'options', '[]'::jsonb)) loop
      v_option_id := (v_option ->> 'id')::uuid;
      if exists (
        select 1 from public.product_options po
        where po.id = v_option_id and po.restaurant_id <> p_restaurant_id
      ) or exists (
        select 1
        from public.product_options po
        join public.product_option_groups pog on pog.id = po.option_group_id
        where po.id = v_option_id and po.restaurant_id = p_restaurant_id
          and pog.product_id <> v_product_id
      ) then
        raise exception using errcode = '42501', message = 'PRODUCT_REFERENCE_INVALID';
      end if;
      insert into public.product_options (
        id, restaurant_id, option_group_id, name, price_delta_cents, sort_order, active
      ) values (
        v_option_id, p_restaurant_id, v_group_id, btrim(v_option ->> 'name'),
        (v_option ->> 'priceDeltaCents')::bigint,
        coalesce((v_option ->> 'sortOrder')::integer, 0),
        coalesce((v_option ->> 'active')::boolean, true)
      ) on conflict (id) do update set
        option_group_id = excluded.option_group_id,
        name = excluded.name,
        price_delta_cents = excluded.price_delta_cents,
        sort_order = excluded.sort_order,
        active = excluded.active,
        updated_at = now()
      where public.product_options.restaurant_id = p_restaurant_id;
      v_option_count := v_option_count + 1;
    end loop;
  end loop;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_restaurant_id, v_uid,
    case when v_existed then 'update'::public.audit_action else 'create'::public.audit_action end,
    'product', v_product_id,
    jsonb_build_object('groups', v_group_count, 'options', v_option_count, 'source', 'save_product_catalog')
  );
  return jsonb_build_object(
    'productId', v_product_id,
    'created', not v_existed,
    'groups', v_group_count,
    'options', v_option_count
  );
exception when invalid_text_representation or numeric_value_out_of_range or check_violation
  or not_null_violation or foreign_key_violation then
  raise exception using errcode = '22023', message = 'PRODUCT_VALUE_INVALID';
end;
$$;

revoke all on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[]) from public;
revoke all on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[]) from public;
grant execute on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[]) to authenticated;
grant execute on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[]) to authenticated;

