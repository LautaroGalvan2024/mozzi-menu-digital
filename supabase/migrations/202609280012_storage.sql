-- This bucket contains intentionally public, browser-processed restaurant imagery only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-assets',
  'restaurant-assets',
  true,
  1048576,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy restaurant_assets_public_read
on storage.objects for select
to public
using (bucket_id = 'restaurant-assets');

create policy restaurant_assets_admin_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'restaurant-assets'
  and (storage.foldername(name))[1] = 'restaurants'
  and (storage.foldername(name))[3] in ('logo', 'cover', 'categories', 'products', 'promotions')
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
  and coalesce(metadata ->> 'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp')
  and private.storage_restaurant_id(name) is not null
  and private.can_manage_catalog(private.storage_restaurant_id(name))
);

create policy restaurant_assets_admin_update
on storage.objects for update
to authenticated
using (
  bucket_id = 'restaurant-assets'
  and private.storage_restaurant_id(name) is not null
  and private.can_manage_catalog(private.storage_restaurant_id(name))
)
with check (
  bucket_id = 'restaurant-assets'
  and (storage.foldername(name))[1] = 'restaurants'
  and (storage.foldername(name))[3] in ('logo', 'cover', 'categories', 'products', 'promotions')
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
  and coalesce(metadata ->> 'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp')
  and private.storage_restaurant_id(name) is not null
  and private.can_manage_catalog(private.storage_restaurant_id(name))
);

create policy restaurant_assets_admin_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'restaurant-assets'
  and private.storage_restaurant_id(name) is not null
  and private.can_manage_catalog(private.storage_restaurant_id(name))
);

comment on policy restaurant_assets_admin_insert on storage.objects is
  'Only restaurant admins/super admins can write under restaurants/{authorized_uuid}; SVG is denied by MIME and extension allowlists.';
