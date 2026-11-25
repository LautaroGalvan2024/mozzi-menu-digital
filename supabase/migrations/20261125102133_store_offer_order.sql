-- Only the unfiltered store offers shelf and its “Ver todas” continuation use these
-- positions. Existing stores keep the entire legacy ordering tuple as their fallback.
create table private.store_offer_positions (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_id uuid,
  family_id uuid,
  group_id uuid generated always as (coalesce(family_id, product_id)) stored,
  position integer not null check (position > 0),
  primary key (restaurant_id, group_id),
  unique (restaurant_id, position),
  check (num_nonnulls(product_id, family_id) = 1),
  foreign key (product_id, restaurant_id) references public.products(id, restaurant_id) on delete cascade,
  foreign key (family_id, restaurant_id) references public.product_families(id, restaurant_id) on delete cascade
);
create index store_offer_positions_product_idx on private.store_offer_positions(product_id) where product_id is not null;
create index store_offer_positions_family_idx on private.store_offer_positions(family_id) where family_id is not null;
alter table private.store_offer_positions enable row level security;
revoke all on private.store_offer_positions from public, anon, authenticated, service_role;

-- Share eligibility and the legacy sort keys between the merchant and public queries.
-- The editor uses the same cheapest eligible variant, tie-breaks and photo fallback
-- as a public offer card. Public pagination does not need those extra projections.
create function private.store_catalog_candidates(
  p_restaurant_id uuid, p_section text, p_category_id uuid, p_search text,
  p_now timestamptz, p_details boolean
)
returns table (
  group_id uuid, offer_position integer, category_sort_order integer, category_name text,
  category_id uuid, featured_rank integer, group_sort_order integer, group_name text,
  display_name text, image_path text, price bigint
)
language sql stable security invoker set search_path = ''
as $$
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
      coalesce(f.image_path, p.image_path) as image_path,
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
          and (p.promotion_starts_at is null or p.promotion_starts_at <= p_now)
          and (p.promotion_ends_at is null or p.promotion_ends_at > p_now)
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
    where p.restaurant_id = p_restaurant_id
      and p.deleted_at is null
      and p.active
      and (f.id is null or f.active)
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_search is null
        or lower(p.name) like '%' || p_search || '%'
        or lower(p.code) like '%' || p_search || '%'
        or lower(p.description) like '%' || p_search || '%'
        or lower(p.variant_attributes::text) like '%' || p_search || '%'
        or lower(coalesce(f.name, '')) like '%' || p_search || '%'
        or lower(coalesce(f.code, '')) like '%' || p_search || '%'
        or lower(coalesce(f.description, '')) like '%' || p_search || '%')
  ),
  flagged_products as (
    select
      p.*,
      (
        (p.promotional_price_cents is not null
          and p.promotional_price_cents < p.base_price_cents
          and (p.promotion_starts_at is null or p.promotion_starts_at <= p_now)
          and (p.promotion_ends_at is null or p.promotion_ends_at > p_now))
        or (p.quantity_threshold_minimum is not null
          and p.quantity_threshold_unit_price_cents < p.current_price_cents)
        or (p.quantity_threshold_minimum is null and exists (
          select 1
          from public.product_quantity_prices q
          where q.restaurant_id = p_restaurant_id
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
      coalesce(max(p.family_name), min(p.name)) as display_name,
      (array_agg(p.image_path order by p.current_price_cents, p.featured desc, p.sort_order, p.name, p.id)
        filter (where p_details and p.purchasable and p.has_offer))[1] as image_path,
      min(p.current_price_cents) filter (where p_details and p.purchasable and p.has_offer) as price
    from flagged_products p
    group by coalesce(p.family_id, p.id), p.category_sort_order,
      p.category_name, p.category_id
    having p_section = 'all'
      or (p_section = 'featured'
        and bool_or(p.featured)
        and bool_or(p.purchasable))
      or (p_section = 'offers'
        and bool_or(p.purchasable and p.has_offer))
  )

  select g.group_id, coalesce(pos.position, 2147483647), g.category_sort_order,
    g.category_name, g.category_id, g.featured_rank, g.group_sort_order,
    lower(g.display_name), g.display_name, g.image_path, g.price
  from candidates g
  left join private.store_offer_positions pos
    on p_section = 'offers' and p_category_id is null and p_search is null
   and pos.restaurant_id = p_restaurant_id and pos.group_id = g.group_id
$$;

create function private.store_offer_items(p_restaurant_id uuid, p_now timestamptz, p_details boolean)
returns table(id uuid, name text, image_path text, price bigint)
language sql stable security invoker set search_path = ''
as $$
  select g.group_id, g.display_name, g.image_path, g.price
  from private.store_catalog_candidates(p_restaurant_id, 'offers', null, null, p_now, p_details) g
  order by g.offer_position, g.category_sort_order, g.category_name, g.category_id,
    g.featured_rank, g.group_sort_order, g.group_name, g.group_id
$$;

create function private.require_store_offer_manager(p_restaurant_id uuid)
returns void language plpgsql stable security invoker set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id)
    or not exists (select 1 from public.restaurants where id = p_restaurant_id and store_enabled) then
    raise exception using errcode = '42501', message = 'STORE_OFFER_ORDER_FORBIDDEN';
  end if;
end;
$$;

create function public.get_store_offer_order(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_store_offer_manager(p_restaurant_id);
  return (
    select jsonb_build_object(
      'revision', md5(coalesce(array_agg(i.id order by i.ordinality), '{}'::uuid[])::text),
      'items', coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'image_path', i.image_path, 'price', i.price
      ) order by i.ordinality), '[]'::jsonb)
    )
    from private.store_offer_items(p_restaurant_id, statement_timestamp(), true) with ordinality i
  );
end;
$$;

create function public.save_store_offer_order(p_restaurant_id uuid, p_expected_revision text, p_group_ids uuid[])
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_current uuid[];
begin
  perform private.require_store_offer_manager(p_restaurant_id);
  -- Other saves and normal catalogue/inventory writes already serialize on this
  -- revision row. Re-read the effective order after taking the lock; the opaque
  -- token also changes when an offer expires, with no catalogue write at all.
  perform 1 from private.catalog_revisions where restaurant_id = p_restaurant_id for no key update;

  select coalesce(array_agg(i.id order by i.ordinality), '{}'::uuid[]) into v_current
  from private.store_offer_items(p_restaurant_id, clock_timestamp(), false) with ordinality i;

  -- A retry after a lost successful reply is safe.
  if p_group_ids = v_current then return; end if;
  if p_expected_revision is distinct from md5(v_current::text) then
    raise exception using errcode = '40001', message = 'STORE_OFFER_ORDER_STALE';
  end if;
  if p_group_ids is null or array_ndims(p_group_ids) > 1
    or cardinality(p_group_ids) <> cardinality(v_current)
    or array(select g from unnest(p_group_ids) g order by g)
      <> array(select g from unnest(v_current) g order by g) then
    raise exception using errcode = '22023', message = 'STORE_OFFER_ORDER_INVALID';
  end if;

  -- Ranks survive a temporary absence until the next save replaces this list.
  -- Physical deletes cascade and soft-deleted/ineligible entries never qualify.
  delete from private.store_offer_positions where restaurant_id = p_restaurant_id;
  insert into private.store_offer_positions(restaurant_id, product_id, family_id, position)
  select p_restaurant_id, case when f.id is null then i.id end, f.id, i.ordinality
  from unnest(p_group_ids) with ordinality i(id, ordinality)
  left join public.product_families f on f.restaurant_id = p_restaurant_id and f.id = i.id;
  update private.catalog_revisions
    set revision = revision + 1, updated_at = clock_timestamp()
    where restaurant_id = p_restaurant_id;
end;
$$;

revoke all on function private.store_catalog_candidates(uuid,text,uuid,text,timestamptz,boolean),
  private.store_offer_items(uuid,timestamptz,boolean), private.require_store_offer_manager(uuid),
  public.get_store_offer_order(uuid), public.save_store_offer_order(uuid,text,uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_store_offer_order(uuid), public.save_store_offer_order(uuid,text,uuid[])
  to authenticated;

create or replace function public.get_public_store_catalog_page(
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

  with candidates as (
    select * from private.store_catalog_candidates(
      v_restaurant_id, v_section, p_category_id, v_search, v_now, false
    )
  ),
  anchor as (
    select * from candidates where group_id = v_after_group_id
  ),
  selected as (
    select candidates.*
    from candidates
    where v_after_group_id is null
      or (
        candidates.offer_position,
        candidates.category_sort_order,
        candidates.category_name,
        candidates.category_id,
        candidates.featured_rank,
        candidates.group_sort_order,
        candidates.group_name,
        candidates.group_id
      ) > (
        select
          anchor.offer_position,
          anchor.category_sort_order,
          anchor.category_name,
          anchor.category_id,
          anchor.featured_rank,
          anchor.group_sort_order,
          anchor.group_name,
          anchor.group_id
        from anchor
      )
    order by offer_position, category_sort_order, category_name, category_id, featured_rank,
      group_sort_order, group_name, group_id
    limit p_limit + 1
  )
  select
    coalesce((
      select array_agg(group_id order by offer_position, category_sort_order, category_name,
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
