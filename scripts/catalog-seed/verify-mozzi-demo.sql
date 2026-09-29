do $$
declare
  v_restaurant_id constant uuid := 'a5501eb8-4e60-4a01-8afe-a795ed135009';
begin
  if not exists (
    select 1 from public.restaurants
    where id = v_restaurant_id and status = 'active' and public_menu_enabled
  ) then
    raise exception 'DEMO_RESTAURANT_NOT_PUBLIC';
  end if;
  if (select count(*) from public.categories where restaurant_id = v_restaurant_id and deleted_at is null and active) <> 4 then
    raise exception 'DEMO_CATEGORY_COUNT_INVALID';
  end if;
  if (select count(*) from public.products where restaurant_id = v_restaurant_id and deleted_at is null and active and available) <> 10 then
    raise exception 'DEMO_PRODUCT_COUNT_INVALID';
  end if;
  if (select count(*) from public.business_hours where restaurant_id = v_restaurant_id and active) <> 7 then
    raise exception 'DEMO_HOURS_INVALID';
  end if;
  if (select count(*) from public.payment_methods where restaurant_id = v_restaurant_id and active) < 1 then
    raise exception 'DEMO_PAYMENT_METHODS_MISSING';
  end if;
  if (select count(*) from public.delivery_zones where restaurant_id = v_restaurant_id and active) < 1 then
    raise exception 'DEMO_DELIVERY_ZONE_MISSING';
  end if;
  if (select count(*) from public.restaurant_order_counters where restaurant_id = v_restaurant_id) <> 1 then
    raise exception 'DEMO_ORDER_COUNTER_MISSING';
  end if;
  if (
    select count(*)
    from public.products p
    join public.image_assets ia on ia.restaurant_id = p.restaurant_id and ia.entity_id = p.id and ia.path = p.image_path and ia.deleted_at is null
    join storage.objects so on so.bucket_id = ia.bucket and so.name = ia.path
    where p.restaurant_id = v_restaurant_id and p.deleted_at is null
  ) <> 10 then
    raise exception 'DEMO_PRODUCT_IMAGES_INVALID';
  end if;
end;
$$;

select jsonb_build_object(
  'slug', r.slug,
  'status', r.status,
  'publicMenuEnabled', r.public_menu_enabled,
  'categories', (select count(*) from public.categories c where c.restaurant_id = r.id and c.deleted_at is null and c.active),
  'products', (select count(*) from public.products p where p.restaurant_id = r.id and p.deleted_at is null and p.active and p.available),
  'productImages', (select count(*) from public.image_assets ia where ia.restaurant_id = r.id and ia.entity_type = 'product' and ia.deleted_at is null),
  'hours', (select count(*) from public.business_hours bh where bh.restaurant_id = r.id and bh.active),
  'paymentMethods', (select count(*) from public.payment_methods pm where pm.restaurant_id = r.id and pm.active),
  'deliveryZones', (select count(*) from public.delivery_zones dz where dz.restaurant_id = r.id and dz.active)
) as verification
from public.restaurants r
where r.id = 'a5501eb8-4e60-4a01-8afe-a795ed135009';
