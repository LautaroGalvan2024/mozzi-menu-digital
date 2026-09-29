-- The sole anonymous catalogue surface. It deliberately returns a curated JSON document.
create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
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
      'nextOpeningAt', private.next_restaurant_opening(r.id, now())
    ),
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'slug', c.slug,
          'description', c.description,
          'imagePath', c.image_path,
          'sortOrder', c.sort_order,
          'products', coalesce((
            select jsonb_agg(
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
                'available', p.available,
                'featured', p.featured,
                'sortOrder', p.sort_order,
                'optionGroups', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', pog.id,
                      'name', pog.name,
                      'required', pog.required,
                      'minSelect', pog.min_select,
                      'maxSelect', pog.max_select,
                      'sortOrder', pog.sort_order,
                      'options', coalesce((
                        select jsonb_agg(
                          jsonb_build_object(
                            'id', po.id,
                            'name', po.name,
                            'priceDeltaCents', po.price_delta_cents::text,
                            'sortOrder', po.sort_order
                          ) order by po.sort_order, po.name, po.id
                        )
                        from public.product_options po
                        where po.option_group_id = pog.id and po.active
                      ), '[]'::jsonb)
                    ) order by pog.sort_order, pog.name, pog.id
                  )
                  from public.product_option_groups pog
                  where pog.product_id = p.id and pog.active
                ), '[]'::jsonb)
              ) order by p.featured desc, p.sort_order, p.name, p.id
            )
            from public.products p
            where p.category_id = c.id
              and p.restaurant_id = r.id
              and p.deleted_at is null
              and p.active
          ), '[]'::jsonb)
        ) order by c.sort_order, c.name, c.id
      )
      from public.categories c
      where c.restaurant_id = r.id and c.deleted_at is null and c.active
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
  ) into v_result
  from public.restaurants r
  where r.slug = lower(btrim(p_restaurant_slug))
    and r.status = 'active'::public.restaurant_status
    and r.public_menu_enabled;

  return v_result;
end;
$$;

create or replace function public.get_actor_authorization()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;

  return jsonb_build_object(
    'userId', v_uid,
    'isSuperAdmin', private.is_super_admin(),
    'aal', private.current_aal(),
    'memberships', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'restaurantId', rm.restaurant_id,
          'role', rm.role,
          'status', rm.status
        ) order by rm.created_at, rm.id
      )
      from public.restaurant_members rm
      where rm.user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_public_menu(text) from public;
grant execute on function public.get_public_menu(text) to anon, authenticated;

revoke all on function public.get_actor_authorization() from public;
grant execute on function public.get_actor_authorization() to authenticated;

comment on function public.get_public_menu(text) is
  'Anonymous-safe menu projection. No profile, membership, order or audit fields are returned.';
