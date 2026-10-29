-- Fast, revisioned catalogue reads. All changes stay in the application
-- schema: no hosted-project, region, plan, or deployment setting is changed.

create extension if not exists pg_trgm with schema extensions;

-- One monotonically increasing value per tenant lets public clients poll a
-- tiny document instead of repeatedly downloading the complete catalogue.
create table private.catalog_revisions (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into private.catalog_revisions(restaurant_id)
select id from public.restaurants
on conflict (restaurant_id) do nothing;

alter table private.catalog_revisions enable row level security;
revoke all on table private.catalog_revisions from public, anon, authenticated, service_role;

create function private.bump_catalog_revision_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct changed.restaurant_id, 1, clock_timestamp()
  from new_rows changed
  join public.restaurants restaurant on restaurant.id = changed.restaurant_id
  where changed.restaurant_id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

-- Set-based group projection shared by paged, direct-detail, cart, and legacy
-- reads. Every nested collection is aggregated once per selected page.
create function private.public_catalog_groups(
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
            and coalesce(p.on_hand > p.reserved, false)
        end,
        'featured', p.featured,
        'sortOrder', p.sort_order,
        'quantityPrices', coalesce(quantity_prices.rows, '[]'::jsonb),
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

create function private.bump_catalog_revision_from_old_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct changed.restaurant_id, 1, clock_timestamp()
  from old_rows changed
  join public.restaurants restaurant on restaurant.id = changed.restaurant_id
  where changed.restaurant_id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

create function private.bump_restaurant_catalog_revision_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct id, 1, clock_timestamp()
  from new_rows
  where id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

-- Statement-level transition tables make a 5,000-row import advance the
-- revision once, not 5,000 times.
do $catalog_revision_triggers$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'categories',
    'products',
    'product_families',
    'product_option_groups',
    'product_options',
    'product_quantity_prices',
    'business_hours',
    'special_hours',
    'payment_methods',
    'delivery_zones',
    'inventory_balances'
  ] loop
    execute format(
      'create trigger %I after insert on public.%I referencing new table as new_rows for each statement execute function private.bump_catalog_revision_from_new_rows()',
      'catalog_revision_' || relation_name || '_insert', relation_name
    );
    execute format(
      'create trigger %I after update on public.%I referencing new table as new_rows for each statement execute function private.bump_catalog_revision_from_new_rows()',
      'catalog_revision_' || relation_name || '_update', relation_name
    );
    execute format(
      'create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function private.bump_catalog_revision_from_old_rows()',
      'catalog_revision_' || relation_name || '_delete', relation_name
    );
  end loop;
end;
$catalog_revision_triggers$;

create trigger catalog_revision_restaurants_insert
after insert on public.restaurants
referencing new table as new_rows
for each statement execute function private.bump_restaurant_catalog_revision_from_new_rows();

create trigger catalog_revision_restaurants_update
after update on public.restaurants
referencing new table as new_rows
for each statement execute function private.bump_restaurant_catalog_revision_from_new_rows();

create function public.get_public_catalog_revision(
  p_restaurant_slug text,
  p_channel text default 'menu'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', cr.revision,
    'updatedAt', cr.updated_at
  )
  from public.restaurants r
  join private.catalog_revisions cr on cr.restaurant_id = r.id
  where r.slug = lower(btrim(p_restaurant_slug))
    and p_channel in ('menu', 'store')
    and private.commerce_channel_published(r.id, p_channel)
$$;

-- Compatibility projection. Legacy callers still receive one flat products
-- array per category while the implementation no longer runs one query per
-- product, option group, or quantity rule.
create function private.get_public_catalog_set_based(
  p_restaurant_slug text,
  p_channel text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
  v_restaurant_id uuid;
  v_group_ids uuid[] := '{}'::uuid[];
  v_groups jsonb;
  v_categories jsonb;
begin
  v_meta := public.get_public_catalog_meta(p_restaurant_slug, p_channel);
  if v_meta is null then return null; end if;
  v_restaurant_id := (v_meta #>> '{restaurant,id}')::uuid;

  with candidates as (
    select
      coalesce(p.family_id, p.id) as group_id,
      c.sort_order as category_sort_order,
      lower(c.name) as category_name,
      c.id as category_id,
      case when bool_or(p.featured) then 0 else 1 end as featured_rank,
      min(p.sort_order) as group_sort_order,
      lower(coalesce(max(f.name), min(p.name))) as group_name
    from public.products p
    join public.categories c
      on c.id = p.category_id
     and c.restaurant_id = p.restaurant_id
     and c.deleted_at is null
     and c.active
    left join public.product_families f
      on f.id = p.family_id and f.restaurant_id = p.restaurant_id
    where p.restaurant_id = v_restaurant_id
      and p.deleted_at is null
      and p.active
      and (f.id is null or f.active)
    group by coalesce(p.family_id, p.id), c.sort_order, lower(c.name), c.id
  )
  select coalesce(array_agg(group_id order by category_sort_order, category_name,
    category_id, featured_rank, group_sort_order, group_name, group_id), '{}'::uuid[])
  into v_group_ids
  from candidates;

  v_groups := private.public_catalog_groups(v_restaurant_id, v_group_ids);

  select coalesce(jsonb_agg(
    category.value || jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(variant.value order by
          (variant.value ->> 'featured')::boolean desc,
          (variant.value ->> 'sortOrder')::integer,
          variant.value ->> 'name',
          variant.value ->> 'id')
        from jsonb_array_elements(v_groups) catalog_group(value)
        cross join lateral jsonb_array_elements(catalog_group.value -> 'variants') variant(value)
        where (catalog_group.value ->> 'categoryId')::uuid = (category.value ->> 'id')::uuid
      ), '[]'::jsonb)
    ) order by category.ordinality
  ), '[]'::jsonb)
  into v_categories
  from jsonb_array_elements(v_meta -> 'categories') with ordinality category(value, ordinality);

  return jsonb_set(v_meta - 'revision', '{categories}', v_categories);
end;
$$;

create or replace function public.get_public_catalog(
  p_restaurant_slug text,
  p_channel text default 'menu'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_public_catalog_set_based(p_restaurant_slug, p_channel)
$$;

create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_public_catalog_set_based(p_restaurant_slug, 'menu')
$$;

create function public.list_catalog_products(
  p_restaurant_id uuid,
  p_search text default null,
  p_family_id uuid default null,
  p_unassigned_only boolean default false,
  p_after_sort_order integer default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}'::uuid[];
  v_page_ids uuid[] := '{}'::uuid[];
  v_items jsonb;
  v_total bigint;
  v_has_more boolean := false;
  v_next_cursor jsonb;
begin
  if auth.uid() is null or not private.can_view_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_FORBIDDEN';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'CATALOG_LIMIT_INVALID';
  end if;
  if p_search is not null and char_length(btrim(p_search)) > 120 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  if (p_after_sort_order is null) <> (p_after_id is null) then
    raise exception using errcode = '22023', message = 'CATALOG_CURSOR_INVALID';
  end if;
  if p_family_id is not null and coalesce(p_unassigned_only, false) then
    raise exception using errcode = '22023', message = 'CATALOG_FILTER_INVALID';
  end if;
  if p_family_id is not null and not exists (
    select 1 from public.product_families f
    where f.id = p_family_id and f.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '22023', message = 'CATALOG_FAMILY_INVALID';
  end if;

  select count(*)
  into v_total
  from public.products p
  where p.restaurant_id = p_restaurant_id
    and p.deleted_at is null
    and (p_family_id is null or p.family_id = p_family_id)
    and (not coalesce(p_unassigned_only, false) or p.family_id is null)
    and (nullif(btrim(p_search), '') is null
      or lower(p.name) like '%' || lower(btrim(p_search)) || '%'
      or lower(p.code) like '%' || lower(btrim(p_search)) || '%'
      or lower(p.description) like '%' || lower(btrim(p_search)) || '%');

  select coalesce(array_agg(selected.id order by selected.sort_order, selected.id), '{}'::uuid[])
  into v_ids
  from (
    select p.id, p.sort_order
    from public.products p
    where p.restaurant_id = p_restaurant_id
      and p.deleted_at is null
      and (p_family_id is null or p.family_id = p_family_id)
      and (not coalesce(p_unassigned_only, false) or p.family_id is null)
      and (nullif(btrim(p_search), '') is null
        or lower(p.name) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.code) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.description) like '%' || lower(btrim(p_search)) || '%')
      and (p_after_id is null or (p.sort_order, p.id) > (p_after_sort_order, p_after_id))
    order by p.sort_order, p.id
    limit p_limit + 1
  ) selected;

  v_has_more := cardinality(v_ids) > p_limit;
  v_page_ids := coalesce(v_ids[1:p_limit], '{}'::uuid[]);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'categoryId', p.category_id,
      'categoryName', c.name,
      'familyId', p.family_id,
      'family', case when f.id is null then null else jsonb_build_object(
        'id', f.id,
        'name', f.name,
        'axes', to_jsonb(f.axes),
        'active', f.active
      ) end,
      'code', p.code,
      'name', p.name,
      'description', p.description,
      'basePriceCents', p.base_price_cents::text,
      'promotionalPriceCents', p.promotional_price_cents::text,
      'promotionStartsAt', p.promotion_starts_at,
      'promotionEndsAt', p.promotion_ends_at,
      'imagePath', p.image_path,
      'active', p.active,
      'available', p.available,
      'featured', p.featured,
      'sortOrder', p.sort_order,
      'archived', p.deleted_at is not null,
      'variantAttributes', p.variant_attributes
    ) order by requested.ordinality
  ), '[]'::jsonb)
  into v_items
  from unnest(v_page_ids) with ordinality requested(id, ordinality)
  join public.products p on p.id = requested.id and p.restaurant_id = p_restaurant_id
  join public.categories c on c.id = p.category_id and c.restaurant_id = p.restaurant_id
  left join public.product_families f on f.id = p.family_id and f.restaurant_id = p.restaurant_id;

  if v_has_more then
    select jsonb_build_object('sortOrder', p.sort_order, 'id', p.id)
    into v_next_cursor
    from public.products p
    where p.id = v_page_ids[cardinality(v_page_ids)];
  end if;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor,
    'total', v_total
  );
end;
$$;

create function public.get_public_catalog_page(
  p_restaurant_slug text,
  p_channel text default 'menu',
  p_category_id uuid default null,
  p_search text default null,
  p_after_group_id uuid default null,
  p_limit integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_revision bigint;
  v_group_ids uuid[] := '{}'::uuid[];
  v_page_ids uuid[] := '{}'::uuid[];
  v_cursor_found boolean;
  v_has_more boolean := false;
  v_next_cursor uuid;
begin
  if p_channel is null or p_channel not in ('menu', 'store') then
    return null;
  end if;
  if p_limit is null or p_limit not between 1 and 48 then
    raise exception using errcode = '22023', message = 'CATALOG_LIMIT_INVALID';
  end if;
  if p_search is not null and char_length(btrim(p_search)) > 120 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;

  select r.id, cr.revision
  into v_restaurant_id, v_revision
  from public.restaurants r
  join private.catalog_revisions cr on cr.restaurant_id = r.id
  where r.slug = lower(btrim(p_restaurant_slug))
    and private.commerce_channel_published(r.id, p_channel);

  if not found then return null; end if;

  if p_category_id is not null and not exists (
    select 1 from public.categories c
    where c.id = p_category_id
      and c.restaurant_id = v_restaurant_id
      and c.deleted_at is null
      and c.active
  ) then
    raise exception using errcode = '22023', message = 'CATALOG_CATEGORY_INVALID';
  end if;

  if p_after_group_id is not null then
    select exists(
      select 1
      from public.products p
      join public.categories c
        on c.id = p.category_id
       and c.restaurant_id = p.restaurant_id
       and c.deleted_at is null
       and c.active
      left join public.product_families f
        on f.id = p.family_id and f.restaurant_id = p.restaurant_id
      where p.restaurant_id = v_restaurant_id
        and p.deleted_at is null
        and p.active
        and (f.id is null or f.active)
        and coalesce(p.family_id, p.id) = p_after_group_id
        and (p_category_id is null or p.category_id = p_category_id)
        and (nullif(btrim(p_search), '') is null
          or lower(p.name) like '%' || lower(btrim(p_search)) || '%'
          or lower(p.code) like '%' || lower(btrim(p_search)) || '%'
          or lower(p.description) like '%' || lower(btrim(p_search)) || '%'
          or lower(p.variant_attributes::text) like '%' || lower(btrim(p_search)) || '%'
          or lower(coalesce(f.name, '')) like '%' || lower(btrim(p_search)) || '%'
          or lower(coalesce(f.code, '')) like '%' || lower(btrim(p_search)) || '%'
          or lower(coalesce(f.description, '')) like '%' || lower(btrim(p_search)) || '%')
    ) into v_cursor_found;
    if not v_cursor_found then
      raise exception using errcode = '22023', message = 'CATALOG_CURSOR_INVALID';
    end if;
  end if;

  with candidates as (
    select
      coalesce(p.family_id, p.id) as group_id,
      c.sort_order as category_sort_order,
      lower(c.name) as category_name,
      c.id as category_id,
      case when bool_or(p.featured) then 0 else 1 end as featured_rank,
      min(p.sort_order) as group_sort_order,
      lower(coalesce(max(f.name), min(p.name))) as group_name
    from public.products p
    join public.categories c
      on c.id = p.category_id
     and c.restaurant_id = p.restaurant_id
     and c.deleted_at is null
     and c.active
    left join public.product_families f
      on f.id = p.family_id and f.restaurant_id = p.restaurant_id
    where p.restaurant_id = v_restaurant_id
      and p.deleted_at is null
      and p.active
      and (f.id is null or f.active)
      and (p_category_id is null or p.category_id = p_category_id)
      and (nullif(btrim(p_search), '') is null
        or lower(p.name) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.code) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.description) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.variant_attributes::text) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(f.name, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(f.code, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(f.description, '')) like '%' || lower(btrim(p_search)) || '%')
    group by coalesce(p.family_id, p.id), c.sort_order, lower(c.name), c.id
  ),
  anchor as (
    select * from candidates where group_id = p_after_group_id
  ),
  selected as (
    select candidates.*
    from candidates
    where p_after_group_id is null
       or (
        candidates.category_sort_order,
        candidates.category_name,
        candidates.category_id,
        candidates.featured_rank,
        candidates.group_sort_order,
        candidates.group_name,
        candidates.group_id
      ) > (
        select
          anchor.category_sort_order,
          anchor.category_name,
          anchor.category_id,
          anchor.featured_rank,
          anchor.group_sort_order,
          anchor.group_name,
          anchor.group_id
        from anchor
      )
    order by category_sort_order, category_name, category_id, featured_rank,
      group_sort_order, group_name, group_id
    limit p_limit + 1
  )
  select coalesce(array_agg(group_id order by category_sort_order, category_name,
    category_id, featured_rank, group_sort_order, group_name, group_id), '{}'::uuid[])
  into v_group_ids
  from selected;

  v_has_more := cardinality(v_group_ids) > p_limit;
  v_page_ids := coalesce(v_group_ids[1:p_limit], '{}'::uuid[]);
  if v_has_more then
    v_next_cursor := v_page_ids[cardinality(v_page_ids)];
  end if;

  return jsonb_build_object(
    'revision', v_revision,
    'items', private.public_catalog_groups(v_restaurant_id, v_page_ids),
    'nextCursor', v_next_cursor
  );
end;
$$;

create function public.get_public_catalog_group(
  p_restaurant_slug text,
  p_channel text default 'menu',
  p_group_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_revision bigint;
  v_resolved_group_id uuid;
  v_groups jsonb;
begin
  if p_channel is null or p_channel not in ('menu', 'store') then return null; end if;
  select r.id, cr.revision
  into v_restaurant_id, v_revision
  from public.restaurants r
  join private.catalog_revisions cr on cr.restaurant_id = r.id
  where r.slug = lower(btrim(p_restaurant_slug))
    and private.commerce_channel_published(r.id, p_channel);
  if not found then return null; end if;

  -- Accept either a family/group id or a concrete variant id.
  select coalesce(p.family_id, p.id)
  into v_resolved_group_id
  from public.products p
  join public.categories c
    on c.id = p.category_id
   and c.restaurant_id = p.restaurant_id
   and c.deleted_at is null
   and c.active
  left join public.product_families f
    on f.id = p.family_id and f.restaurant_id = p.restaurant_id
  where p.restaurant_id = v_restaurant_id
    and p.deleted_at is null
    and p.active
    and (f.id is null or f.active)
    and (p.id = p_group_id or p.family_id = p_group_id)
  order by (p.id = p_group_id) desc, p.id
  limit 1;

  v_groups := private.public_catalog_groups(
    v_restaurant_id,
    case when v_resolved_group_id is null then '{}'::uuid[] else array[v_resolved_group_id] end
  );
  return jsonb_build_object(
    'revision', v_revision,
    'group', v_groups -> 0
  );
end;
$$;

create function public.get_public_products_by_ids(
  p_restaurant_slug text,
  p_channel text default 'menu',
  p_product_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_revision bigint;
  v_group_ids uuid[] := '{}'::uuid[];
  v_groups jsonb;
  v_products jsonb;
begin
  if p_channel is null or p_channel not in ('menu', 'store') then return null; end if;
  if cardinality(coalesce(p_product_ids, '{}'::uuid[])) > 100 then
    raise exception using errcode = '22023', message = 'CATALOG_PRODUCT_IDS_INVALID';
  end if;

  select r.id, cr.revision
  into v_restaurant_id, v_revision
  from public.restaurants r
  join private.catalog_revisions cr on cr.restaurant_id = r.id
  where r.slug = lower(btrim(p_restaurant_slug))
    and private.commerce_channel_published(r.id, p_channel);
  if not found then return null; end if;

  with requested as (
    select product_id, min(ordinality)::bigint as requested_order
    from unnest(coalesce(p_product_ids, '{}'::uuid[])) with ordinality requested_rows(product_id, ordinality)
    where product_id is not null
    group by product_id
  ),
  requested_groups as (
    select coalesce(p.family_id, p.id) as group_id, min(requested.requested_order) as requested_order
    from requested
    join public.products p
      on p.id = requested.product_id
     and p.restaurant_id = v_restaurant_id
    group by coalesce(p.family_id, p.id)
  )
  select coalesce(array_agg(group_id order by requested_order), '{}'::uuid[])
  into v_group_ids
  from requested_groups;

  v_groups := private.public_catalog_groups(v_restaurant_id, v_group_ids);

  with requested as (
    select product_id, min(ordinality)::bigint as requested_order
    from unnest(coalesce(p_product_ids, '{}'::uuid[])) with ordinality requested_rows(product_id, ordinality)
    where product_id is not null
    group by product_id
  )
  select coalesce(jsonb_agg(variant.value order by requested.requested_order), '[]'::jsonb)
  into v_products
  from jsonb_array_elements(v_groups) catalog_group(value)
  cross join lateral jsonb_array_elements(catalog_group.value -> 'variants') variant(value)
  join requested on requested.product_id = (variant.value ->> 'id')::uuid;

  return jsonb_build_object(
    'revision', v_revision,
    'products', v_products
  );
end;
$$;

-- Legacy PublicMenu metadata without product arrays, plus the revision.
create function public.get_public_catalog_meta(
  p_restaurant_slug text,
  p_channel text default 'menu'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', cr.revision,
    'restaurant', jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'tradeName', r.trade_name,
      'slug', r.slug,
      'description', r.description,
      'status', r.status,
      'whatsappPhone', r.whatsapp_phone_e164,
      'address', r.address,
      'city', r.city,
      'timezone', r.timezone,
      'currencyCode', r.currency_code,
      'locale', r.locale,
      'logoPath', r.logo_path,
      'coverPath', r.cover_path,
      'primaryColor', r.primary_color,
      'secondaryColor', r.secondary_color,
      'deliveryEnabled', r.delivery_enabled,
      'pickupEnabled', r.pickup_enabled,
      'minimumOrderCents', r.minimum_order_cents::text,
      'defaultPreparationMinutes', r.default_preparation_minutes,
      'isOpen', private.restaurant_is_open(r.id, now()),
      'nextOpeningAt', private.next_restaurant_opening(r.id, now()),
      'channel', p_channel,
      'acceptsOrders', private.commerce_accepts_orders(r.id, p_channel),
      'storeCheckoutWhatsappEnabled', r.store_checkout_whatsapp_enabled,
      'storeCheckoutOnlineEnabled', r.store_checkout_online_enabled,
      'storeOrderingPolicy', r.store_ordering_policy
    ),
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'slug', c.slug,
          'description', c.description,
          'imagePath', c.image_path,
          'sortOrder', c.sort_order
        ) order by c.sort_order, c.name, c.id
      )
      from public.categories c
      where c.restaurant_id = r.id
        and c.deleted_at is null
        and c.active
    ), '[]'::jsonb),
    'businessHours', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', bh.id,
          'dayOfWeek', bh.day_of_week,
          'slotIndex', bh.slot_index,
          'opensAt', bh.opens_at,
          'closesAt', bh.closes_at,
          'spansNextDay', bh.spans_next_day
        ) order by bh.day_of_week, bh.slot_index
      )
      from public.business_hours bh
      where bh.restaurant_id = r.id and bh.active
    ), '[]'::jsonb),
    'specialHours', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', sh.id,
          'date', sh.date,
          'isClosed', sh.is_closed,
          'slotIndex', sh.slot_index,
          'opensAt', sh.opens_at,
          'closesAt', sh.closes_at,
          'spansNextDay', sh.spans_next_day,
          'reason', sh.reason
        ) order by sh.date, sh.slot_index
      )
      from public.special_hours sh
      where sh.restaurant_id = r.id
        and sh.date between ((now() at time zone r.timezone)::date - 1)
                        and ((now() at time zone r.timezone)::date + 60)
    ), '[]'::jsonb),
    'paymentMethods', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pm.id,
          'code', pm.code,
          'provider', pm.provider,
          'name', pm.name,
          'description', pm.description,
          'adjustmentType', pm.adjustment_type,
          'adjustmentScope', pm.adjustment_scope,
          'adjustmentBps', pm.adjustment_bps,
          'adjustmentFixedCents', pm.adjustment_fixed_cents::text,
          'transferAlias', pm.transfer_alias,
          'accountHolder', pm.account_holder,
          'bankName', pm.bank_name,
          'instructions', pm.instructions,
          'sortOrder', pm.sort_order
        ) order by pm.sort_order, pm.name, pm.id
      )
      from public.payment_methods pm
      where pm.restaurant_id = r.id and pm.active
    ), '[]'::jsonb),
    'deliveryZones', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', dz.id,
          'name', dz.name,
          'description', dz.description,
          'deliveryFeeCents', dz.delivery_fee_cents::text,
          'minimumOrderCents', dz.minimum_order_cents::text,
          'freeShippingFromCents', dz.free_shipping_from_cents::text,
          'sortOrder', dz.sort_order
        ) order by dz.sort_order, dz.name, dz.id
      )
      from public.delivery_zones dz
      where dz.restaurant_id = r.id and dz.active
    ), '[]'::jsonb)
  )
  from public.restaurants r
  join private.catalog_revisions cr on cr.restaurant_id = r.id
  where r.slug = lower(btrim(p_restaurant_slug))
    and p_channel in ('menu', 'store')
    and private.commerce_channel_published(r.id, p_channel)
$$;

-- Inventory metadata/history is fetched once; item pages no longer repeat the
-- latest 100 operations on every page.
create function public.get_inventory_overview(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.restaurants%rowtype;
begin
  if auth.uid() is null or not private.can_view_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'INVENTORY_FORBIDDEN';
  end if;
  select * into strict r from public.restaurants where id = p_restaurant_id;

  return jsonb_build_object(
    'policy', jsonb_build_object(
      'mode', r.inventory_mode,
      'version', r.inventory_version::text,
      'activatedAt', r.inventory_activated_at,
      'pausedAt', r.inventory_paused_at,
      'cutoverId', r.inventory_cutover_id,
      'countStartedAt', (
        select started_at from public.inventory_counts where id = r.inventory_cutover_id
      ),
      'businessConfirmed', r.inventory_business_policy is not null,
      'businessPolicy', r.inventory_business_policy
    ),
    'operations', coalesce((
      select jsonb_agg(operation_row.document order by operation_row.created_at desc, operation_row.id desc)
      from (
        select
          operation.id,
          operation.created_at,
          jsonb_build_object(
            'id', operation.id,
            'kind', operation.kind,
            'orderId', operation.order_id,
            'sourceOperationId', operation.source_operation_id,
            'reason', operation.reason,
            'actorType', operation.actor_type,
            'actorUserId', operation.actor_user_id,
            'actorName', actor.full_name,
            'createdAt', operation.created_at,
            'result', operation.result,
            'movements', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'productId', movement.product_id,
                  'deltaOnHand', movement.delta_on_hand::text,
                  'deltaReserved', movement.delta_reserved::text,
                  'returnedQuantity', movement.returned_quantity::text,
                  'onHandAfter', movement.on_hand_after::text,
                  'reservedAfter', movement.reserved_after::text
                ) order by movement.product_id
              )
              from public.inventory_movements movement
              where movement.operation_id = operation.id
            ), '[]'::jsonb)
          ) as document
        from public.inventory_operations operation
        left join public.profiles actor on actor.id = operation.actor_user_id
        where operation.restaurant_id = p_restaurant_id
        order by operation.created_at desc, operation.id desc
        limit 100
      ) operation_row
    ), '[]'::jsonb)
  );
end;
$$;

create function public.get_inventory_items(
  p_restaurant_id uuid,
  p_after uuid default null,
  p_limit integer default 100,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}'::uuid[];
  v_page_ids uuid[] := '{}'::uuid[];
  v_items jsonb;
  v_has_more boolean := false;
  v_next_cursor uuid;
begin
  if auth.uid() is null or not private.can_view_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'INVENTORY_FORBIDDEN';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'LIMIT_INVALID';
  end if;
  if p_search is not null and char_length(btrim(p_search)) > 120 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;

  select coalesce(array_agg(selected.id order by selected.id), '{}'::uuid[])
  into v_ids
  from (
    select p.id
    from public.products p
    where p.restaurant_id = p_restaurant_id
      and private.inventory_product_in_scope(p_restaurant_id, p.id)
      and (p_after is null or p.id > p_after)
      and (nullif(btrim(p_search), '') is null
        or lower(p.name) like '%' || lower(btrim(p_search)) || '%'
        or lower(p.code) like '%' || lower(btrim(p_search)) || '%')
    order by p.id
    limit p_limit + 1
  ) selected;

  v_has_more := cardinality(v_ids) > p_limit;
  v_page_ids := coalesce(v_ids[1:p_limit], '{}'::uuid[]);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'productId', p.id,
      'code', p.code,
      'name', p.name,
      'archived', p.deleted_at is not null,
      'initialized', balance.product_id is not null,
      'onHand', balance.on_hand::text,
      'reserved', balance.reserved::text,
      'available', (balance.on_hand - balance.reserved)::text,
      'version', balance.version::text
    ) order by requested.ordinality
  ), '[]'::jsonb)
  into v_items
  from unnest(v_page_ids) with ordinality requested(id, ordinality)
  join public.products p on p.id = requested.id and p.restaurant_id = p_restaurant_id
  left join public.inventory_balances balance
    on balance.restaurant_id = p.restaurant_id and balance.product_id = p.id;

  if v_has_more then
    v_next_cursor := v_page_ids[cardinality(v_page_ids)];
  end if;

  return jsonb_build_object('items', v_items, 'nextCursor', v_next_cursor);
end;
$$;

-- Trigram indexes support debounced substring search without a sequential scan.
create index products_name_trgm_idx
  on public.products using gin (lower(name) extensions.gin_trgm_ops);
create index products_code_trgm_idx
  on public.products using gin (lower(code) extensions.gin_trgm_ops);
create index products_description_trgm_idx
  on public.products using gin (lower(description) extensions.gin_trgm_ops);
create index products_variant_attributes_trgm_idx
  on public.products using gin ((lower(variant_attributes::text)) extensions.gin_trgm_ops);
create index product_families_name_trgm_idx
  on public.product_families using gin (lower(name) extensions.gin_trgm_ops);
create index product_families_code_trgm_idx
  on public.product_families using gin (lower(code) extensions.gin_trgm_ops);
create index product_families_description_trgm_idx
  on public.product_families using gin (lower(description) extensions.gin_trgm_ops);
create index categories_name_trgm_idx
  on public.categories using gin (lower(name) extensions.gin_trgm_ops);
create index orders_customer_name_trgm_idx
  on public.orders using gin (lower(customer_name) extensions.gin_trgm_ops);
create index orders_customer_phone_trgm_idx
  on public.orders using gin (lower(customer_phone) extensions.gin_trgm_ops);
create index orders_display_number_trgm_idx
  on public.orders using gin (lower(display_number) extensions.gin_trgm_ops);
create index products_admin_page_idx
  on public.products(restaurant_id, sort_order, id);

revoke all on function
  private.bump_catalog_revision_from_new_rows(),
  private.bump_catalog_revision_from_old_rows(),
  private.bump_restaurant_catalog_revision_from_new_rows(),
  private.public_catalog_groups(uuid, uuid[]),
  private.get_public_catalog_set_based(text, text)
from public, anon, authenticated, service_role;

revoke all on function
  public.get_public_catalog_revision(text, text),
  public.get_public_catalog_meta(text, text),
  public.get_public_catalog_page(text, text, uuid, text, uuid, integer),
  public.get_public_catalog_group(text, text, uuid),
  public.get_public_products_by_ids(text, text, uuid[]),
  public.get_public_catalog(text, text),
  public.get_public_menu(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.get_public_catalog_revision(text, text),
  public.get_public_catalog_meta(text, text),
  public.get_public_catalog_page(text, text, uuid, text, uuid, integer),
  public.get_public_catalog_group(text, text, uuid),
  public.get_public_products_by_ids(text, text, uuid[]),
  public.get_public_catalog(text, text),
  public.get_public_menu(text)
to anon, authenticated, service_role;

revoke all on function
  public.list_catalog_products(uuid, text, uuid, boolean, integer, uuid, integer),
  public.get_inventory_overview(uuid),
  public.get_inventory_items(uuid, uuid, integer, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.list_catalog_products(uuid, text, uuid, boolean, integer, uuid, integer),
  public.get_inventory_overview(uuid),
  public.get_inventory_items(uuid, uuid, integer, text)
to authenticated;

comment on function public.get_public_catalog_revision(text, text) is
  'Anonymous-safe monotonic catalogue revision used for lightweight polling.';
comment on function public.get_public_catalog_page(text, text, uuid, text, uuid, integer) is
  'Anonymous-safe catalogue groups. Limit defaults to 24 and is capped at 48.';
comment on function public.list_catalog_products(uuid, text, uuid, boolean, integer, uuid, integer) is
  'Tenant-authorized product page; supports family variants and unassigned candidate filters.';
