begin;

with actor as (
  select pur.user_id
  from public.platform_user_roles pur
  join public.profiles p on p.id = pur.user_id and p.active
  where pur.role = 'super_admin'
), assets(product_id, path, size_bytes) as (
  values
    ('c88e56e5-5b43-4db1-b612-f3e6f8da1341'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/c88e56e5-5b43-4db1-b612-f3e6f8da1341/seed.webp', 95944::bigint),
    ('cfed47f4-dd32-46a0-92cb-c8a1fe9bb539'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/cfed47f4-dd32-46a0-92cb-c8a1fe9bb539/seed.webp', 132488::bigint),
    ('425ff879-6573-4b25-93cc-25e889572e66'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/425ff879-6573-4b25-93cc-25e889572e66/seed.webp', 103250::bigint),
    ('75b7dae9-d11f-484e-97d3-5875cd7b1042'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/75b7dae9-d11f-484e-97d3-5875cd7b1042/seed.webp', 103670::bigint),
    ('4e3668b2-d7fd-4c76-a773-f21864b9b90e'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/4e3668b2-d7fd-4c76-a773-f21864b9b90e/seed.webp', 138116::bigint),
    ('b408fd9c-3118-46d3-8a59-53b845ebfb16'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/b408fd9c-3118-46d3-8a59-53b845ebfb16/seed.webp', 163344::bigint),
    ('29afe8a7-238e-4b84-99a2-f683b10d9917'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/29afe8a7-238e-4b84-99a2-f683b10d9917/seed.webp', 166736::bigint),
    ('8a258ed2-1877-467b-8c46-1d7bef376aaa'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/8a258ed2-1877-467b-8c46-1d7bef376aaa/seed.webp', 134882::bigint),
    ('76a1d7fd-8404-44df-ab9c-dd4e5c7e4112'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/76a1d7fd-8404-44df-ab9c-dd4e5c7e4112/seed.webp', 133818::bigint),
    ('f994e4bb-8a93-4464-a61d-3bf3dd135d49'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/f994e4bb-8a93-4464-a61d-3bf3dd135d49/seed.webp', 129366::bigint)
)
insert into public.image_assets (
  restaurant_id, entity_type, entity_id, bucket, path, mime_type,
  size_bytes, width, height, created_by
)
select
  'a5501eb8-4e60-4a01-8afe-a795ed135009', 'product', assets.product_id,
  'restaurant-assets', assets.path, 'image/webp', assets.size_bytes,
  1200, 1200, actor.user_id
from assets cross join actor
on conflict (bucket, path) do update set
  entity_type = excluded.entity_type,
  entity_id = excluded.entity_id,
  mime_type = excluded.mime_type,
  size_bytes = excluded.size_bytes,
  width = excluded.width,
  height = excluded.height,
  deleted_at = null;

with actor as (
  select pur.user_id
  from public.platform_user_roles pur
  join public.profiles p on p.id = pur.user_id and p.active
  where pur.role = 'super_admin'
), assets(product_id, path) as (
  values
    ('c88e56e5-5b43-4db1-b612-f3e6f8da1341'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/c88e56e5-5b43-4db1-b612-f3e6f8da1341/seed.webp'),
    ('cfed47f4-dd32-46a0-92cb-c8a1fe9bb539'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/cfed47f4-dd32-46a0-92cb-c8a1fe9bb539/seed.webp'),
    ('425ff879-6573-4b25-93cc-25e889572e66'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/425ff879-6573-4b25-93cc-25e889572e66/seed.webp'),
    ('75b7dae9-d11f-484e-97d3-5875cd7b1042'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/75b7dae9-d11f-484e-97d3-5875cd7b1042/seed.webp'),
    ('4e3668b2-d7fd-4c76-a773-f21864b9b90e'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/4e3668b2-d7fd-4c76-a773-f21864b9b90e/seed.webp'),
    ('b408fd9c-3118-46d3-8a59-53b845ebfb16'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/b408fd9c-3118-46d3-8a59-53b845ebfb16/seed.webp'),
    ('29afe8a7-238e-4b84-99a2-f683b10d9917'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/29afe8a7-238e-4b84-99a2-f683b10d9917/seed.webp'),
    ('8a258ed2-1877-467b-8c46-1d7bef376aaa'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/8a258ed2-1877-467b-8c46-1d7bef376aaa/seed.webp'),
    ('76a1d7fd-8404-44df-ab9c-dd4e5c7e4112'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/76a1d7fd-8404-44df-ab9c-dd4e5c7e4112/seed.webp'),
    ('f994e4bb-8a93-4464-a61d-3bf3dd135d49'::uuid, 'restaurants/a5501eb8-4e60-4a01-8afe-a795ed135009/products/f994e4bb-8a93-4464-a61d-3bf3dd135d49/seed.webp')
)
update public.products p
set image_path = assets.path, updated_by = actor.user_id, updated_at = now()
from assets cross join actor
where p.id = assets.product_id
  and p.restaurant_id = 'a5501eb8-4e60-4a01-8afe-a795ed135009';

commit;

select jsonb_build_object(
  'productsWithImages', count(*) filter (where p.image_path is not null),
  'registeredAssets', (select count(*) from public.image_assets ia where ia.restaurant_id = p.restaurant_id and ia.entity_type = 'product' and ia.deleted_at is null)
) as images
from public.products p
where p.restaurant_id = 'a5501eb8-4e60-4a01-8afe-a795ed135009' and p.deleted_at is null
group by p.restaurant_id;
