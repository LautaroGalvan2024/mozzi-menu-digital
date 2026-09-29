-- Inventory inconsistencies between public business references, the asset registry,
-- and Storage. This is deliberately read-only: operators review the report before
-- deleting anything, so a transient or recently replaced image is never removed
-- automatically.
create or replace function public.list_orphan_image_assets(p_restaurant_id uuid)
returns table (
  restaurant_id uuid,
  path text,
  asset_id uuid,
  issue text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'ASSET_INVENTORY_FORBIDDEN';
  end if;

  return query
  with registered as (
    select
      ia.restaurant_id,
      ia.path,
      ia.id as asset_id,
      ia.deleted_at,
      exists (
        select 1
        from storage.objects so
        where so.bucket_id = 'restaurant-assets' and so.name = ia.path
      ) as storage_present,
      (
        exists (
          select 1 from public.restaurants r
          where r.id = ia.restaurant_id
            and (r.logo_path = ia.path or r.cover_path = ia.path)
        )
        or exists (
          select 1 from public.categories c
          where c.restaurant_id = ia.restaurant_id and c.image_path = ia.path
        )
        or exists (
          select 1 from public.products p
          where p.restaurant_id = ia.restaurant_id and p.image_path = ia.path
        )
      ) as business_reference
    from public.image_assets ia
    where ia.restaurant_id = p_restaurant_id
  ), inventory as (
    select
      r.restaurant_id,
      r.path,
      r.asset_id,
      case
        when r.deleted_at is not null and r.storage_present then 'pending_storage_delete'
        when r.deleted_at is null and not r.storage_present then 'missing_storage_object'
        when r.deleted_at is null and r.storage_present and not r.business_reference then 'unreferenced_asset'
        else null
      end as issue
    from registered r
    union all
    select
      p_restaurant_id,
      so.name,
      null::uuid,
      'unregistered_storage_object'::text
    from storage.objects so
    where so.bucket_id = 'restaurant-assets'
      and private.storage_restaurant_id(so.name) = p_restaurant_id
      and not exists (
        select 1 from public.image_assets ia where ia.path = so.name
      )
  )
  select i.restaurant_id, i.path, i.asset_id, i.issue
  from inventory i
  where i.issue is not null
  order by i.path;
end;
$$;

revoke all on function public.list_orphan_image_assets(uuid) from public;
grant execute on function public.list_orphan_image_assets(uuid) to authenticated;

comment on function public.list_orphan_image_assets(uuid) is
  'Read-only, tenant-authorized inventory of missing, unregistered, unreferenced, or pending-deletion public image assets.';
