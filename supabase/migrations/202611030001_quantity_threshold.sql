-- A product chooses either its saved bundles or one all-units threshold.
-- Nullable columns preserve legacy saves/imports and existing catalogue rules.
alter table public.products
  add column quantity_threshold_minimum smallint,
  add column quantity_threshold_unit_price_cents bigint,
  add constraint products_quantity_threshold_check check (
    (quantity_threshold_minimum is null and quantity_threshold_unit_price_cents is null)
    or (quantity_threshold_minimum is not null and quantity_threshold_unit_price_cents is not null
      and quantity_threshold_minimum between 2 and 100
      and quantity_threshold_unit_price_cents between 0 and 1000000000000)
  );

-- Only the atomic catalogue RPC may write the new fields. Existing column ACLs
-- deliberately do not grant direct authenticated UPDATE on them.
alter function private.save_product_catalog_with_quantity_prices(uuid,jsonb,jsonb,uuid[],uuid[])
  rename to save_product_catalog_with_bundles;

create function private.save_product_catalog_with_quantity_prices(
  p_restaurant_id uuid, p_product jsonb, p_groups jsonb,
  p_removed_group_ids uuid[] default '{}'::uuid[], p_removed_option_ids uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_threshold jsonb; v_minimum integer; v_unit bigint; v_result jsonb;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501', message='CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if p_product ? 'quantityThreshold' then
    v_threshold := p_product->'quantityThreshold';
    if v_threshold <> 'null'::jsonb then
      if jsonb_typeof(v_threshold) is distinct from 'object'
        or jsonb_typeof(v_threshold->'minimumQuantity') is distinct from 'number'
        or coalesce(v_threshold->>'minimumQuantity','') !~ '^[0-9]{1,3}$'
        or coalesce(jsonb_typeof(v_threshold->'unitPriceCents'),'') not in ('number','string')
        or coalesce(v_threshold->>'unitPriceCents','') !~ '^[0-9]{1,13}$' then
        raise exception using errcode='22023', message='PRODUCT_QUANTITY_THRESHOLD_INVALID';
      end if;
      v_minimum := (v_threshold->>'minimumQuantity')::integer;
      v_unit := (v_threshold->>'unitPriceCents')::bigint;
      if v_minimum not between 2 and 100 or v_unit not between 0 and 1000000000000 then
        raise exception using errcode='22023', message='PRODUCT_QUANTITY_THRESHOLD_INVALID';
      end if;
    end if;
  end if;
  v_result := private.save_product_catalog_with_bundles(p_restaurant_id,p_product,p_groups,p_removed_group_ids,p_removed_option_ids);
  if p_product ? 'quantityThreshold' then
    update public.products set quantity_threshold_minimum=v_minimum,
      quantity_threshold_unit_price_cents=v_unit
      where id=(p_product->>'id')::uuid and restaurant_id=p_restaurant_id;
  end if;
  return v_result;
end $$;

alter function private.calculate_product_base_pricing(uuid,uuid,integer,bigint)
  rename to calculate_product_bundle_pricing;

create function private.calculate_product_base_pricing(
  p_restaurant_id uuid, p_product_id uuid, p_quantity integer, p_unit_price_cents bigint
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_minimum integer; v_threshold_unit bigint; v_unit bigint; v_applied boolean; v_result jsonb;
begin
  if p_quantity is null or p_quantity not between 1 and 100 or p_unit_price_cents is null or p_unit_price_cents < 0 then
    raise exception using errcode='22023', message='PRICING_ARGUMENT_INVALID';
  end if;
  select quantity_threshold_minimum,quantity_threshold_unit_price_cents
    into v_minimum,v_threshold_unit from public.products
    where id=p_product_id and restaurant_id=p_restaurant_id;
  if v_minimum is null then
    return private.calculate_product_bundle_pricing(p_restaurant_id,p_product_id,p_quantity,p_unit_price_cents);
  end if;
  v_applied := p_quantity >= v_minimum and v_threshold_unit < p_unit_price_cents;
  v_unit := case when v_applied then v_threshold_unit else p_unit_price_cents end;
  v_result := jsonb_build_object('mode',case when v_applied then 'quantity' else 'unit' end,
    'unitPriceCents',p_unit_price_cents::text,'baseSubtotalCents',(v_unit*p_quantity)::text,
    'components',jsonb_build_array(jsonb_build_object('quantity',1,'count',p_quantity,
      'totalPriceCents',v_unit::text,'subtotalCents',(v_unit*p_quantity)::text)));
  if v_applied then
    v_result := v_result || jsonb_build_object('quantityPricingType','threshold',
      'minimumQuantity',v_minimum,'appliedUnitPriceCents',v_unit::text);
  end if;
  return v_result;
end $$;

revoke all on function private.save_product_catalog_with_bundles(uuid,jsonb,jsonb,uuid[],uuid[]),
  private.save_product_catalog_with_quantity_prices(uuid,jsonb,jsonb,uuid[],uuid[]),
  private.calculate_product_bundle_pricing(uuid,uuid,integer,bigint),
  private.calculate_product_base_pricing(uuid,uuid,integer,bigint)
  from public,anon,authenticated,service_role;

-- Replace the shared set-based projection used by menu/store, paged reads,
-- product details and checkout hydration. Dormant bundles stay admin-readable.

create or replace function private.public_catalog_groups(
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
        'quantityPrices', case when p.quantity_threshold_minimum is null then coalesce(quantity_prices.rows, '[]'::jsonb) else '[]'::jsonb end,
        'quantityThreshold', case when p.quantity_threshold_minimum is null then null else jsonb_build_object(
          'minimumQuantity',p.quantity_threshold_minimum,'unitPriceCents',p.quantity_threshold_unit_price_cents::text) end,
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
