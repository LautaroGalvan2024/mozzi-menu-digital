-- Store-only catalogue pagination for the merchandising home. The existing
-- channel-aware catalogue RPC remains unchanged for menus and older clients.
alter table public.categories
  add column icon_key text;

alter table public.categories
  add constraint categories_icon_key_check
  check (
    icon_key is null
    or icon_key in (
      'basket', 'pets', 'drinks', 'wine', 'pantry', 'spices', 'hygiene',
      'infusions', 'dairy', 'cleaning', 'paper', 'snacks', 'produce',
      'meat', 'bakery', 'frozen', 'package'
    )
  );

create function public.get_public_store_catalog_page(
  p_restaurant_slug text,
  p_section text default 'all',
  p_category_id uuid default null,
  p_search text default null,
  p_cursor jsonb default null,
  p_limit integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_restaurant_slug, '')));
  v_section text := lower(btrim(coalesce(p_section, '')));
  v_search text := lower(nullif(btrim(p_search), ''));
  v_restaurant_id uuid;
  v_revision bigint;
  v_now timestamptz := statement_timestamp();
  v_valid_until timestamptz;
  v_scope jsonb;
  v_after_group_id uuid;
  v_cursor_revision bigint;
  v_cursor_valid_until timestamptz;
  v_cursor_found boolean := false;
  v_group_ids uuid[] := '{}'::uuid[];
  v_page_ids uuid[] := '{}'::uuid[];
  v_has_more boolean := false;
  v_next_cursor jsonb;
begin
  if v_section not in ('all', 'featured', 'offers') then
    raise exception using errcode = '22023', message = 'STORE_CATALOG_SECTION_INVALID';
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
  where r.slug = v_slug
    and private.commerce_channel_published(r.id, 'store');

  if not found then return null; end if;

  if p_category_id is not null and not exists (
    select 1
    from public.categories c
    where c.id = p_category_id
      and c.restaurant_id = v_restaurant_id
      and c.deleted_at is null
      and c.active
  ) then
    raise exception using errcode = '22023', message = 'CATALOG_CATEGORY_INVALID';
  end if;

  -- The response becomes stale at the next promotion boundary even when no row
  -- is written and therefore the monotonic catalogue revision does not change.
  select min(boundary.value)
  into v_valid_until
  from public.products p
  join public.categories c
    on c.id = p.category_id
   and c.restaurant_id = p.restaurant_id
   and c.deleted_at is null
   and c.active
  left join public.product_families f
    on f.id = p.family_id
   and f.restaurant_id = p.restaurant_id
  cross join lateral (
    values (p.promotion_starts_at), (p.promotion_ends_at)
  ) boundary(value)
  where p.restaurant_id = v_restaurant_id
    and p.deleted_at is null
    and p.active
    and (f.id is null or f.active)
    and p.promotional_price_cents is not null
    and boundary.value > v_now;

  v_scope := jsonb_build_object(
    'restaurantSlug', v_slug,
    'section', v_section,
    'categoryId', p_category_id,
    'search', v_search
  );

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or not (p_cursor ? 'afterGroupId')
      or not (p_cursor ? 'revision')
      or not (p_cursor ? 'validUntil')
      or not (p_cursor ? 'scope')
      or jsonb_typeof(p_cursor -> 'afterGroupId') <> 'string'
      or jsonb_typeof(p_cursor -> 'revision') not in ('number', 'string')
      or jsonb_typeof(p_cursor -> 'validUntil') not in ('string', 'null')
      or jsonb_typeof(p_cursor -> 'scope') <> 'object'
    then
      raise exception using errcode = '22023', message = 'CATALOG_CURSOR_INVALID';
    end if;
    begin
      v_after_group_id := (p_cursor ->> 'afterGroupId')::uuid;
      v_cursor_revision := (p_cursor ->> 'revision')::bigint;
      v_cursor_valid_until := (p_cursor ->> 'validUntil')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'CATALOG_CURSOR_INVALID';
    end;
    if p_cursor -> 'scope' is distinct from v_scope
      or v_cursor_revision is distinct from v_revision
      or v_cursor_valid_until is distinct from v_valid_until
      or (v_cursor_valid_until is not null and v_cursor_valid_until <= v_now)
    then
      raise exception using errcode = '22023', message = 'CATALOG_CURSOR_STALE';
    end if;
  end if;

  with scoped_products as (
    select
      p.id,
      p.family_id,
      p.category_id,
      p.name,
      p.code,
      p.description,
      p.variant_attributes,
      p.base_price_cents,
      p.promotional_price_cents,
      p.promotion_starts_at,
      p.promotion_ends_at,
      p.quantity_threshold_minimum,
      p.quantity_threshold_unit_price_cents,
      p.featured,
      p.sort_order,
      c.sort_order as category_sort_order,
      lower(c.name) as category_name,
      f.name as family_name,
      f.code as family_code,
      f.description as family_description,
      case
        when r.inventory_mode = 'never_enabled' and r.inventory_cutover_id is null
          then p.available
        else p.available
          and r.inventory_mode = 'enforced'
          and r.inventory_cutover_id is null
          and (b.on_hand is null or b.on_hand > b.reserved)
      end as purchasable,
      case
        when p.promotional_price_cents is not null
          and (p.promotion_starts_at is null or p.promotion_starts_at <= v_now)
          and (p.promotion_ends_at is null or p.promotion_ends_at > v_now)
          then p.promotional_price_cents
        else p.base_price_cents
      end as current_price_cents
    from public.products p
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
    where p.restaurant_id = v_restaurant_id
      and p.deleted_at is null
      and p.active
      and (f.id is null or f.active)
      and (p_category_id is null or p.category_id = p_category_id)
      and (v_search is null
        or lower(p.name) like '%' || v_search || '%'
        or lower(p.code) like '%' || v_search || '%'
        or lower(p.description) like '%' || v_search || '%'
        or lower(p.variant_attributes::text) like '%' || v_search || '%'
        or lower(coalesce(f.name, '')) like '%' || v_search || '%'
        or lower(coalesce(f.code, '')) like '%' || v_search || '%'
        or lower(coalesce(f.description, '')) like '%' || v_search || '%')
  ),
  flagged_products as (
    select
      p.*,
      (
        (p.promotional_price_cents is not null
          and p.promotional_price_cents < p.base_price_cents
          and (p.promotion_starts_at is null or p.promotion_starts_at <= v_now)
          and (p.promotion_ends_at is null or p.promotion_ends_at > v_now))
        or (p.quantity_threshold_minimum is not null
          and p.quantity_threshold_unit_price_cents < p.current_price_cents)
        or (p.quantity_threshold_minimum is null and exists (
          select 1
          from public.product_quantity_prices q
          where q.restaurant_id = v_restaurant_id
            and q.product_id = p.id
            and q.active
            and q.total_price_cents < q.quantity::bigint * p.current_price_cents
        ))
      ) as has_offer
    from scoped_products p
  ),
  candidates as (
    select
      coalesce(p.family_id, p.id) as group_id,
      p.category_sort_order,
      p.category_name,
      p.category_id,
      case when bool_or(p.featured) then 0 else 1 end as featured_rank,
      min(p.sort_order) as group_sort_order,
      lower(coalesce(max(p.family_name), min(p.name))) as group_name
    from flagged_products p
    group by coalesce(p.family_id, p.id), p.category_sort_order,
      p.category_name, p.category_id
    having v_section = 'all'
      or (v_section = 'featured'
        and bool_or(p.featured)
        and bool_or(p.purchasable))
      or (v_section = 'offers'
        and bool_or(p.purchasable and p.has_offer))
  ),
  anchor as (
    select * from candidates where group_id = v_after_group_id
  ),
  selected as (
    select candidates.*
    from candidates
    where v_after_group_id is null
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
  select
    coalesce((
      select array_agg(group_id order by category_sort_order, category_name,
        category_id, featured_rank, group_sort_order, group_name, group_id)
      from selected
    ), '{}'::uuid[]),
    (v_after_group_id is null or exists(select 1 from anchor))
  into v_group_ids, v_cursor_found;

  if not v_cursor_found then
    raise exception using errcode = '22023', message = 'CATALOG_CURSOR_INVALID';
  end if;

  v_has_more := cardinality(v_group_ids) > p_limit;
  v_page_ids := coalesce(v_group_ids[1:p_limit], '{}'::uuid[]);
  if v_has_more then
    v_next_cursor := jsonb_build_object(
      'afterGroupId', v_page_ids[cardinality(v_page_ids)],
      'revision', v_revision,
      'validUntil', v_valid_until,
      'scope', v_scope
    );
  end if;

  return jsonb_build_object(
    'revision', v_revision,
    'serverNow', v_now,
    'validUntil', v_valid_until,
    'categoryIcons', coalesce((
      select jsonb_object_agg(c.id::text, c.icon_key)
      from public.categories c
      where c.restaurant_id = v_restaurant_id
        and c.deleted_at is null
        and c.active
        and c.icon_key is not null
    ), '{}'::jsonb),
    'items', private.public_catalog_groups(v_restaurant_id, v_page_ids),
    'nextCursor', v_next_cursor
  );
end;
$$;

revoke all on function public.get_public_store_catalog_page(
  text, text, uuid, text, jsonb, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_public_store_catalog_page(
  text, text, uuid, text, jsonb, integer
) to anon, authenticated, service_role;

comment on function public.get_public_store_catalog_page(
  text, text, uuid, text, jsonb, integer
) is 'Anonymous store groups with global all, featured and offers sections, revision-bound opaque cursors and time-bounded promotion validity.';
