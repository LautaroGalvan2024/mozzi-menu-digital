-- Keep statement-level revision bumps set-based when a single catalog write
-- contains several rows for the same restaurant. clock_timestamp() changes
-- per row and therefore made DISTINCT produce duplicate conflict targets.

create or replace function private.bump_catalog_revision_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct changed.restaurant_id, 1, statement_timestamp()
  from new_rows changed
  join public.restaurants restaurant on restaurant.id = changed.restaurant_id
  where changed.restaurant_id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

create or replace function private.bump_catalog_revision_from_old_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct changed.restaurant_id, 1, statement_timestamp()
  from old_rows changed
  join public.restaurants restaurant on restaurant.id = changed.restaurant_id
  where changed.restaurant_id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

create or replace function private.bump_restaurant_catalog_revision_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_revisions as current_revision(restaurant_id, revision, updated_at)
  select distinct id, 1, statement_timestamp()
  from new_rows
  where id is not null
  on conflict (restaurant_id) do update
    set revision = current_revision.revision + 1,
        updated_at = excluded.updated_at;
  return null;
end;
$$;

-- Preserve the reviewed legacy ACL: menu reads are anonymous/authenticated,
-- while service-only callers use get_public_catalog or the new paged RPCs.
revoke execute on function public.get_public_menu(text) from service_role;

