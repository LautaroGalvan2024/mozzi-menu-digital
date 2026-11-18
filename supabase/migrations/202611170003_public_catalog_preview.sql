-- Additive, bounded metadata projection. Existing catalogue RPCs remain intact.
set lock_timeout = '5s';
set statement_timeout = '30s';

create function public.get_public_catalog_preview(
  p_restaurant_slug text,
  p_channel text default 'menu',
  p_product_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  r public.restaurants%rowtype;
  product jsonb;
begin
  if p_channel is null or p_channel not in ('menu','store')
    or (p_product_id is not null and p_channel <> 'store') then return null; end if;
  select * into r from public.restaurants
  where slug = lower(btrim(p_restaurant_slug));
  if not found or not private.commerce_channel_published(r.id,p_channel) then return null; end if;

  if p_product_id is not null then
    select jsonb_build_object(
      'name',coalesce(f.name,p.name),
      'description',coalesce(f.description,p.description),
      'imagePath',case when f.id is null then p.image_path else f.image_path end
    ) into product
    from public.products p
    join public.categories c on c.id=p.category_id and c.restaurant_id=p.restaurant_id
    left join public.product_families f on f.id=p.family_id and f.restaurant_id=p.restaurant_id
    where p.restaurant_id=r.id and p.deleted_at is null and p.active
      and c.deleted_at is null and c.active and (f.id is null or f.active)
      and (p.id=p_product_id or p.family_id=p_product_id)
    order by p.id limit 1;
    if not found then return null; end if;
  end if;

  return jsonb_build_object('restaurant',jsonb_build_object(
    'tradeName',r.trade_name,'description',r.description,'slug',r.slug,
    'logoPath',r.logo_path,'coverPath',r.cover_path
  ),'product',product);
end;
$$;
revoke all on function public.get_public_catalog_preview(text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_public_catalog_preview(text,text,uuid) to anon,authenticated,service_role;
comment on function public.get_public_catalog_preview(text,text,uuid) is
  'Published metadata for one commerce and optional product/family; no customer, price or credential fields.';
reset statement_timeout;
reset lock_timeout;
