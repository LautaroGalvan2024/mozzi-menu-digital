-- Preserve API contracts while enforcing asset lifecycle and schedule integrity.
create extension if not exists btree_gist with schema extensions;

-- A responsive upload is one logical asset even when business data stores only
-- its largest image. Unknown filenames remain independent, preserving legacy URLs.
create function private.image_asset_primary_path(p_path text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare m text[]; maximum integer; width integer;
begin
  if p_path is null then return null; end if;
  m:=regexp_match(p_path,'^(.*)-w([0-9]{1,4})-([0-9]{1,4})[.]webp$','i');
  if m is not null then
    maximum:=m[2]::integer; width:=m[3]::integer;
    if maximum between 1 and 1200 and width in (least(320,maximum),least(640,maximum),maximum) then
      return m[1]||'-w'||m[2]||'-'||m[2]||'.webp';
    end if;
    return p_path;
  end if;
  m:=regexp_match(p_path,'^(.*)-(320|640|1200)[.]webp$','i');
  if m is not null then return m[1]||'-1200.webp'; end if;
  return p_path;
end $$;

-- Exact normalized-path lookups also protect older cross-tenant public-image
-- references without rescanning the complete catalogue for every asset.
create index restaurants_logo_asset_ref_idx on public.restaurants(private.image_asset_primary_path(logo_path));
create index restaurants_cover_asset_ref_idx on public.restaurants(private.image_asset_primary_path(cover_path));
create index categories_image_asset_ref_idx on public.categories(private.image_asset_primary_path(image_path));
create index products_image_asset_ref_idx on public.products(private.image_asset_primary_path(image_path));
create index product_families_image_asset_ref_idx on public.product_families(private.image_asset_primary_path(image_path));

create table private.image_asset_cleanup_requests (
  restaurant_id uuid not null references public.restaurants(id),
  primary_path text not null,
  requested_at timestamptz not null default clock_timestamp(),
  requested_by uuid references auth.users(id) on delete set null,
  primary key(restaurant_id,primary_path),
  check(primary_path like 'restaurants/'||restaurant_id::text||'/%')
);
alter table private.image_asset_cleanup_requests enable row level security;
revoke all on private.image_asset_cleanup_requests from public,anon,authenticated,service_role;

create function private.image_asset_is_referenced(p_restaurant_id uuid,p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select p_path like 'restaurants/'||p_restaurant_id::text||'/%' and (exists(select 1 from public.restaurants r where
    (private.image_asset_primary_path(r.logo_path)=private.image_asset_primary_path(p_path)
      or private.image_asset_primary_path(r.cover_path)=private.image_asset_primary_path(p_path)))
    or exists(select 1 from public.categories c where private.image_asset_primary_path(c.image_path)=private.image_asset_primary_path(p_path))
    or exists(select 1 from public.products p where private.image_asset_primary_path(p.image_path)=private.image_asset_primary_path(p_path))
    or exists(select 1 from public.product_families f where private.image_asset_primary_path(f.image_path)=private.image_asset_primary_path(p_path)))
$$;

-- Assignment and cleanup serialize on the same asset key. The durable marker
-- outlives the SQL transaction because Storage removes bytes after its DB commit.
-- Existing references, including historical paths, are never rewritten.
create function private.guard_image_asset_reference() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare v_new jsonb:=to_jsonb(new); v_old jsonb:=case when tg_op='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_tenant uuid; v_path text; v_primary text; v_column text; v_paths text[]:='{}';
begin
  v_tenant:=case when tg_table_name='restaurants' then new.id else (v_new->>'restaurant_id')::uuid end;
  foreach v_column in array case when tg_table_name='restaurants' then array['logo_path','cover_path'] else array['image_path'] end loop
    v_path:=v_new->>v_column;
    if v_path is not null and v_path is distinct from v_old->>v_column then
      v_paths:=array_append(v_paths,private.image_asset_primary_path(v_path));
    end if;
  end loop;
  for v_primary in select distinct x from unnest(v_paths) x order by x loop
    -- Use the asset owner encoded in the path, including pre-existing cross-tenant
    -- public-image references. Do not let a legacy reference evade retirement.
    v_tenant:=coalesce(private.storage_restaurant_id(v_primary),v_tenant);
    perform pg_advisory_xact_lock(hashtextextended('image-asset:'||v_tenant::text||':'||v_primary,0));
    if exists(select 1 from private.image_asset_cleanup_requests
      where restaurant_id=v_tenant and primary_path=v_primary) then
      raise exception using errcode='22023',message='IMAGE_ASSET_RETIRED';
    end if;
  end loop;
  return new;
end $$;
create trigger restaurants_image_reference_guard before insert or update of logo_path,cover_path on public.restaurants
  for each row execute function private.guard_image_asset_reference();
create trigger categories_image_reference_guard before insert or update of image_path on public.categories
  for each row execute function private.guard_image_asset_reference();
create trigger products_image_reference_guard before insert or update of image_path on public.products
  for each row execute function private.guard_image_asset_reference();
create trigger product_families_image_reference_guard before insert or update of image_path on public.product_families
  for each row execute function private.guard_image_asset_reference();

create function public.prepare_image_asset_cleanup(p_restaurant_id uuid,p_path text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_primary text; v_paths jsonb;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='ASSET_CLEANUP_FORBIDDEN';
  end if;
  if p_path is null or char_length(p_path)>500 or private.storage_restaurant_id(p_path) is distinct from p_restaurant_id then
    raise exception using errcode='22023',message='ASSET_PATH_INVALID';
  end if;
  v_primary:=private.image_asset_primary_path(p_path);
  perform pg_advisory_xact_lock(hashtextextended('image-asset:'||p_restaurant_id::text||':'||v_primary,0));
  -- This VOLATILE statement gets a fresh snapshot after waiting for assignments.
  if not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='ASSET_CLEANUP_FORBIDDEN';
  end if;
  if private.image_asset_is_referenced(p_restaurant_id,v_primary) then
    return jsonb_build_object('paths','[]'::jsonb,'retained',true);
  end if;
  insert into private.image_asset_cleanup_requests(restaurant_id,primary_path,requested_by)
  values(p_restaurant_id,v_primary,auth.uid()) on conflict do nothing;
  -- Include incomplete uploads that have not acquired an image_assets row.
  select coalesce(jsonb_agg(s.name order by s.name),'[]'::jsonb) into v_paths
  from storage.objects s where s.bucket_id='restaurant-assets'
    and s.name like 'restaurants/'||p_restaurant_id::text||'/%'
    and private.image_asset_primary_path(s.name)=v_primary;
  update public.image_assets set deleted_at=coalesce(deleted_at,clock_timestamp())
  where restaurant_id=p_restaurant_id and private.image_asset_primary_path(path)=v_primary;
  return jsonb_build_object('paths',v_paths,'retained',false);
end $$;

create function private.image_asset_cleanup_permitted(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.storage_restaurant_id(p_path) is not null
    and private.can_manage_catalog(private.storage_restaurant_id(p_path))
    and exists(select 1 from private.image_asset_cleanup_requests q
      where q.restaurant_id=private.storage_restaurant_id(p_path)
        and q.primary_path=private.image_asset_primary_path(p_path))
    and not private.image_asset_is_referenced(private.storage_restaurant_id(p_path),p_path)
$$;

-- Storage probes DELETE policies in rolled-back subtransactions in some server
-- versions. Therefore the policy reads a durable preparation; it never creates it.
-- Older clients can still save business data, but their best-effort raw cleanup
-- retains files until a new client/maintenance caller prepares the asset.
alter policy restaurant_assets_admin_delete on storage.objects
  using(bucket_id='restaurant-assets' and private.image_asset_cleanup_permitted(name));
-- A move/overwrite must not provide an alternate way to destroy a live path.
-- Normal uploads use fresh names with upsert=false and retain their INSERT policy.
alter policy restaurant_assets_admin_update on storage.objects
  using(bucket_id='restaurant-assets' and private.image_asset_cleanup_permitted(name));
alter policy image_assets_update_admin on public.image_assets
  using(private.can_manage_catalog(restaurant_id) and private.image_asset_cleanup_permitted(path))
  with check(private.can_manage_catalog(restaurant_id) and private.image_asset_cleanup_permitted(path));

create or replace function public.list_orphan_image_assets(p_restaurant_id uuid)
returns table(restaurant_id uuid,path text,asset_id uuid,issue text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='ASSET_INVENTORY_FORBIDDEN';
  end if;
  return query with registered as (
    select ia.restaurant_id,ia.path,ia.id as asset_id,ia.deleted_at,
      exists(select 1 from storage.objects so where so.bucket_id='restaurant-assets' and so.name=ia.path) as storage_present,
      private.image_asset_is_referenced(ia.restaurant_id,ia.path) as business_reference
    from public.image_assets ia where ia.restaurant_id=p_restaurant_id
  ), inventory as (
    select r.restaurant_id,r.path,r.asset_id,case
      when r.business_reference and r.storage_present then null
      when r.deleted_at is not null and r.storage_present then 'pending_storage_delete'
      when not r.storage_present and (r.deleted_at is null or r.business_reference) then 'missing_storage_object'
      when r.deleted_at is null and r.storage_present and not r.business_reference then 'unreferenced_asset'
      else null end as issue from registered r
    union all select p_restaurant_id,so.name,null::uuid,'unregistered_storage_object'::text
    from storage.objects so where so.bucket_id='restaurant-assets'
      and private.storage_restaurant_id(so.name)=p_restaurant_id
      and not private.image_asset_is_referenced(p_restaurant_id,so.name)
      and not exists(select 1 from public.image_assets ia where ia.path=so.name)
  ) select i.restaurant_id,i.path,i.asset_id,i.issue from inventory i where i.issue is not null order by i.path;
end $$;

revoke all on function private.image_asset_primary_path(text),private.image_asset_is_referenced(uuid,text),
  private.guard_image_asset_reference(),private.image_asset_cleanup_permitted(text)
  from public,anon,authenticated,service_role;
grant execute on function private.image_asset_cleanup_permitted(text) to authenticated;
-- Indexed expressions run for legitimate direct table writes too. This pure
-- normalizer exposes no data; the private schema remains outside the Data API.
grant execute on function private.image_asset_primary_path(text) to authenticated,service_role;
revoke all on function public.prepare_image_asset_cleanup(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_image_asset_cleanup(uuid,text) to authenticated;

-- A whole-day closure occupies every slot; open rows occupy only their slot.
-- The index-level exclusion covers direct legacy table writes and concurrent
-- transactions. Deferred checking preserves atomic delete/reinsert replacements.
do $$ begin
  if exists(select 1 from public.special_hours group by restaurant_id,date having bool_or(is_closed) and count(*)>1) then
    raise exception using errcode='22023',message='HOURS_EXISTING_CLOSED_DATE_MIXED_REVIEW_REQUIRED';
  end if;
end $$;
alter table public.special_hours add constraint special_hours_closed_date_exclusive
  exclude using gist(restaurant_id with =,date with =,
    (case when is_closed then int4range(null,null,'()') else int4range(slot_index::integer,slot_index::integer+1,'[)') end) with &&)
  deferrable initially deferred;

create or replace function public.save_restaurant_hours(
  p_restaurant_id uuid,
  p_regular jsonb,
  p_special jsonb,
  p_delete_regular_ids uuid[] default '{}'::uuid[],
  p_delete_special_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row jsonb;
  v_regular_count integer := 0;
  v_special_count integer := 0;
begin
  if v_uid is null or not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'HOURS_MANAGEMENT_FORBIDDEN';
  end if;
  -- Serialize RPC replacements before inspecting/deleting schedule rows.
  perform 1 from public.restaurants where id=p_restaurant_id for update;
  if not found or not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode='42501',message='HOURS_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_regular) <> 'array' or jsonb_array_length(p_regular) > 147
     or jsonb_typeof(p_special) <> 'array' or jsonb_array_length(p_special) > 1000
     or pg_column_size(p_regular) + pg_column_size(p_special) > 1048576 then
    raise exception using errcode = '22023', message = 'HOURS_PAYLOAD_INVALID';
  end if;

  -- Validate every caller-controlled identifier before deleting any row. This
  -- keeps replacement atomic and prevents a foreign-tenant UUID from being
  -- hidden by the delete/reinsert sequence below.
  if exists (
    select 1 from public.business_hours bh
    where bh.id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]))
      and bh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1 from public.special_hours sh
    where sh.id = any(coalesce(p_delete_special_ids, '{}'::uuid[]))
      and sh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1
    from jsonb_array_elements(p_regular) item(value)
    join public.business_hours bh on bh.id = (item.value ->> 'id')::uuid
    where bh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    join public.special_hours sh on sh.id = (item.value ->> 'id')::uuid
    where sh.restaurant_id <> p_restaurant_id
  ) then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;

  -- A date-level closure is a single override, never one slot among others.
  if exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    group by (item.value ->> 'date')::date
    having bool_or(coalesce((item.value ->> 'isClosed')::boolean, false))
       and count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'HOURS_CLOSED_DATE_MIXED';
  end if;

  -- Explicit removals and every existing payload row are deleted before any
  -- insert. All statements remain in the caller's RPC transaction, so a later
  -- validation or constraint failure restores the original schedule.
  delete from public.business_hours
  where restaurant_id = p_restaurant_id
    and (
      id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]))
      or id in (
        select (item.value ->> 'id')::uuid
        from jsonb_array_elements(p_regular) item(value)
      )
    );
  delete from public.special_hours
  where restaurant_id = p_restaurant_id
    and (
      id = any(coalesce(p_delete_special_ids, '{}'::uuid[]))
      or id in (
        select (item.value ->> 'id')::uuid
        from jsonb_array_elements(p_special) item(value)
      )
    );

  -- Include special rows not replaced by this payload when checking the
  -- resulting dates. This rejects both adding a closure beside an existing
  -- open slot and adding an open slot beside an existing closure.
  if exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    join public.special_hours sh
      on sh.restaurant_id = p_restaurant_id
     and sh.date = (item.value ->> 'date')::date
    where coalesce((item.value ->> 'isClosed')::boolean, false)
       or sh.is_closed
  ) then
    raise exception using errcode = '22023', message = 'HOURS_CLOSED_DATE_MIXED';
  end if;

  for v_row in select value from jsonb_array_elements(p_regular) loop
    insert into public.business_hours (
      id, restaurant_id, day_of_week, slot_index, opens_at, closes_at, spans_next_day, active
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'dayOfWeek')::smallint,
      (v_row ->> 'slotIndex')::smallint, (v_row ->> 'opensAt')::time,
      (v_row ->> 'closesAt')::time, coalesce((v_row ->> 'spansNextDay')::boolean, false),
      coalesce((v_row ->> 'active')::boolean, true)
    ) on conflict (id) do update set
      day_of_week = excluded.day_of_week,
      slot_index = excluded.slot_index,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      active = excluded.active,
      updated_at = now()
    where public.business_hours.restaurant_id = p_restaurant_id;
    v_regular_count := v_regular_count + 1;
  end loop;

  for v_row in select value from jsonb_array_elements(p_special) loop
    insert into public.special_hours (
      id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at, spans_next_day, reason
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'date')::date,
      (v_row ->> 'slotIndex')::smallint, coalesce((v_row ->> 'isClosed')::boolean, false),
      nullif(v_row ->> 'opensAt', '')::time, nullif(v_row ->> 'closesAt', '')::time,
      coalesce((v_row ->> 'spansNextDay')::boolean, false), nullif(btrim(v_row ->> 'reason'), '')
    ) on conflict (id) do update set
      date = excluded.date,
      slot_index = excluded.slot_index,
      is_closed = excluded.is_closed,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      reason = excluded.reason,
      updated_at = now()
    where public.special_hours.restaurant_id = p_restaurant_id;
    v_special_count := v_special_count + 1;
  end loop;

  insert into public.audit_logs (restaurant_id, actor_user_id, action, entity_type, metadata)
  values (
    p_restaurant_id, v_uid, 'update', 'restaurant_hours',
    jsonb_build_object('regular', v_regular_count, 'special', v_special_count,
      'deletedRegular', cardinality(coalesce(p_delete_regular_ids, '{}'::uuid[])),
      'deletedSpecial', cardinality(coalesce(p_delete_special_ids, '{}'::uuid[])))
  );
  return jsonb_build_object('regular', v_regular_count, 'special', v_special_count);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or unique_violation then
  raise exception using errcode = '22023', message = 'HOURS_VALUE_INVALID';
end;
$$;

create or replace function public.save_product_family(p_restaurant_id uuid,p_family jsonb,p_variants jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare f_id uuid; f_category uuid; v_axes text[]; v_row jsonb; v_id uuid; v_ids uuid[]:='{}';
  v_existing public.products%rowtype; v_product jsonb; v_name text; v_code text;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_family) is distinct from 'object' or jsonb_typeof(p_variants) is distinct from 'array'
    or jsonb_array_length(p_variants) not between 1 and 500 or pg_column_size(p_variants)>2097152
    or jsonb_typeof(p_family->'axes') is distinct from 'array' then
    raise exception using errcode='22023',message='FAMILY_PAYLOAD_INVALID';
  end if;
  f_id:=(p_family->>'id')::uuid; f_category:=(p_family->>'categoryId')::uuid;
  v_axes:=array(select jsonb_array_elements_text(p_family->'axes'));
  if f_id is null or f_category is null or not private.valid_variant_axes(v_axes)
    or char_length(btrim(coalesce(p_family->>'name',''))) not between 1 and 120 then
    raise exception using errcode='22023',message='FAMILY_PAYLOAD_INVALID';
  end if;
  -- Match the stock-aware wrapper: restaurant before allocator/family/product.
  -- Checkout holds SHARE, so it cannot invert product and family locks.
  perform 1 from public.restaurants where id=p_restaurant_id for update;
  if not found or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  perform private.lock_catalog_codes(p_restaurant_id);
  if not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if exists(select 1 from public.product_families where id=f_id and restaurant_id<>p_restaurant_id)
    or not exists(select 1 from public.categories where id=f_category and restaurant_id=p_restaurant_id and deleted_at is null) then
    raise exception using errcode='42501',message='FAMILY_TENANT_MISMATCH';
  end if;
  v_code:=coalesce(nullif(btrim(p_family->>'code'),''),f_id::text);
  insert into public.product_families(id,restaurant_id,category_id,code,name,description,image_path,axes,active)
  values(f_id,p_restaurant_id,f_category,v_code,btrim(p_family->>'name'),coalesce(p_family->>'description',''),
    nullif(p_family->>'imagePath',''),v_axes,coalesce((p_family->>'active')::boolean,true))
  on conflict(id) do update set category_id=excluded.category_id,code=excluded.code,name=excluded.name,
    description=excluded.description,image_path=excluded.image_path,axes=excluded.axes,active=excluded.active,updated_at=now();
  for v_row in select value from jsonb_array_elements(p_variants) loop
    v_id:=(v_row->>'productId')::uuid;
    if v_id is null or v_id=any(v_ids) or jsonb_typeof(v_row->'attributes') is distinct from 'object' then
      raise exception using errcode='22023',message='FAMILY_VARIANT_INVALID';
    end if;
    v_ids:=array_append(v_ids,v_id);
    select * into v_existing from public.products where id=v_id for update;
    if found then
      if v_existing.restaurant_id<>p_restaurant_id or v_existing.deleted_at is not null
        or (v_existing.family_id is not null and v_existing.family_id<>f_id) then
        raise exception using errcode='42501',message='FAMILY_PRODUCT_UNAVAILABLE';
      end if;
    else
      if jsonb_typeof(v_row->'product') is distinct from 'object' then
        raise exception using errcode='22023',message='FAMILY_PRODUCT_REQUIRED';
      end if;
      v_name:=left(btrim(p_family->>'name')||' · '||(select string_agg(v_row->'attributes'->>a,' / ' order by n)
        from unnest(v_axes) with ordinality x(a,n)),160);
      v_product:=(v_row->'product')||jsonb_build_object('id',v_id,'categoryId',f_category,'name',v_name);
      perform public.save_product_catalog(p_restaurant_id,v_product,'[]'::jsonb);
    end if;
    update public.products set family_id=f_id,variant_attributes=v_row->'attributes',category_id=f_category,
      updated_at=now() where id=v_id and restaurant_id=p_restaurant_id;
  end loop;
  -- Removing a member only detaches its presentation; its SKU and stock survive.
  update public.products set family_id=null,variant_attributes='{}'::jsonb,updated_at=now()
    where family_id=f_id and not(id=any(v_ids));
  perform private.validate_family_products(f_id);
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,metadata)
  values(p_restaurant_id,auth.uid(),'update','product_family',f_id,jsonb_build_object('variants',cardinality(v_ids)));
  return jsonb_build_object('id',f_id,'variants',cardinality(v_ids));
end $$;
