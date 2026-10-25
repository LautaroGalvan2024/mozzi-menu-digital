-- RF-SKU: stable tenant codes and durable, atomic import results. No stock changes.
-- Historical duplicate codes are retained but blocked for new assignments.
create table private.catalog_sku_counters (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  next_value bigint not null default 1 check (next_value > 0)
);
create table private.catalog_code_claims (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  normalized_code text not null,
  product_id uuid,
  primary key (restaurant_id, normalized_code)
);
insert into private.catalog_code_claims (restaurant_id, normalized_code, product_id)
select restaurant_id, lower(btrim(code)), case when count(*) = 1 then min(id::text)::uuid end
from public.products group by restaurant_id, lower(btrim(code));

create table private.catalog_import_batches (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  batch_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (restaurant_id, batch_id)
);
revoke all on private.catalog_sku_counters, private.catalog_code_claims,
  private.catalog_import_batches from public, anon, authenticated, service_role;

create function private.lock_catalog_codes(p_restaurant_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- Policy first, then the tenant allocator. All catalogue entry points use this order.
  perform 1 from public.restaurants where id = p_restaurant_id for share;
  insert into private.catalog_sku_counters(restaurant_id) values (p_restaurant_id)
  on conflict (restaurant_id) do nothing;
  perform 1 from private.catalog_sku_counters where restaurant_id = p_restaurant_id for update;
end;
$$;

create function private.claim_catalog_code(p_restaurant_id uuid, p_product_id uuid, p_code text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_code text := btrim(coalesce(p_code, '')); v_owner uuid; v_number bigint; v_attempt integer := 0;
begin
  perform private.lock_catalog_codes(p_restaurant_id);
  if v_code = '' then
    loop
      v_attempt := v_attempt + 1;
      if v_attempt > 10000 then
        raise exception using errcode = '22023', message = 'PRODUCT_CODE_ALLOCATION_EXHAUSTED';
      end if;
      update private.catalog_sku_counters set next_value = next_value + 1
      where restaurant_id = p_restaurant_id returning next_value - 1 into v_number;
      v_code := 'P-' || lpad(v_number::text, greatest(6, length(v_number::text)), '0');
      exit when not exists (select 1 from private.catalog_code_claims
        where restaurant_id = p_restaurant_id and normalized_code = lower(v_code));
    end loop;
  end if;
  if char_length(v_code) not between 1 and 80 or v_code ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'PRODUCT_CODE_INVALID';
  end if;
  select product_id into v_owner from private.catalog_code_claims
  where restaurant_id = p_restaurant_id and normalized_code = lower(v_code);
  if found then
    if v_owner is distinct from p_product_id then
      raise exception using errcode = '23505', message = 'PRODUCT_CODE_ALREADY_USED';
    end if;
  else
    insert into private.catalog_code_claims(restaurant_id, normalized_code, product_id)
    values(p_restaurant_id, lower(v_code), p_product_id);
  end if;
  return v_code;
end;
$$;

create function private.guard_catalog_product_code()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_existing public.products%rowtype;
begin
  -- BEFORE triggers run before the table WITH CHECK policy: do not reveal code claims
  -- to a caller trying a direct cross-tenant INSERT. Owner/service maintenance stays available.
  if current_setting('role', true) in ('anon','authenticated')
    and (auth.uid() is null or not private.can_manage_catalog(new.restaurant_id)) then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if tg_op = 'UPDATE' and new.restaurant_id is distinct from old.restaurant_id then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and nullif(btrim(new.code), '') is null then new.code := old.code; end if;
  -- Do not renumber legacy rows, even if old historical reuse makes their claim ambiguous.
  if tg_op = 'UPDATE' and new.code = old.code then return new; end if;
  perform private.lock_catalog_codes(new.restaurant_id);
  if tg_op = 'INSERT' then
    select * into v_existing from public.products where id = new.id;
    if found then
      if v_existing.restaurant_id <> new.restaurant_id then
        raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
      end if;
      if nullif(btrim(new.code), '') is null then new.code := v_existing.code; end if;
      if new.code = v_existing.code then return new; end if;
    end if;
  end if;
  new.code := private.claim_catalog_code(new.restaurant_id, new.id, new.code);
  return new;
end;
$$;
create trigger products_code_claim before insert or update of code, restaurant_id on public.products
for each row execute function private.guard_catalog_product_code();

create function private.validate_catalog_option_groups(p_restaurant_id uuid, p_product_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.product_option_groups g
    where g.restaurant_id = p_restaurant_id and g.product_id = p_product_id and g.active
      and (g.max_select not between 1 and 20 or g.min_select >
        (select count(*) from public.product_options o where o.option_group_id = g.id and o.active))) then
    raise exception using errcode = '22023', message = 'OPTION_GROUP_SELECTION_INVALID';
  end if;
end;
$$;

-- Keep the complete quantity-pricing wrapper, including its validation and synchronization.
alter function public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[])
  rename to save_product_catalog_with_quantity_prices;
alter function public.save_product_catalog_with_quantity_prices(uuid,jsonb,jsonb,uuid[],uuid[])
  set schema private;
revoke all on function private.save_product_catalog_with_quantity_prices(uuid,jsonb,jsonb,uuid[],uuid[])
  from public, anon, authenticated, service_role;

create function public.save_product_catalog(
  p_restaurant_id uuid, p_product jsonb, p_groups jsonb,
  p_removed_group_ids uuid[] default '{}'::uuid[], p_removed_option_ids uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_code text; v_result jsonb;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_product) is distinct from 'object'
    or (p_product ? 'code' and jsonb_typeof(p_product->'code') not in ('string','null')) then
    raise exception using errcode = '22023', message = 'PRODUCT_PAYLOAD_INVALID';
  end if;
  v_id := (p_product->>'id')::uuid;
  if v_id is null then raise exception using errcode = '22023', message = 'PRODUCT_ID_REQUIRED'; end if;
  perform private.lock_catalog_codes(p_restaurant_id);
  if not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGEMENT_FORBIDDEN';
  end if;
  v_code := nullif(btrim(p_product->>'code'), '');
  if v_code is null then
    select code into v_code from public.products where id = v_id and restaurant_id = p_restaurant_id;
    if not found then v_code := private.claim_catalog_code(p_restaurant_id, v_id, null); end if;
  end if;
  v_result := private.save_product_catalog_with_quantity_prices(p_restaurant_id,
    p_product || jsonb_build_object('code', v_code), p_groups, p_removed_group_ids, p_removed_option_ids);
  perform private.validate_catalog_option_groups(p_restaurant_id, v_id);
  return v_result || jsonb_build_object('id',v_id,'code',v_code);
end;
$$;

create function public.get_catalog_import_result(p_restaurant_id uuid, p_batch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_IMPORT_FORBIDDEN';
  end if;
  return (select result from private.catalog_import_batches
    where restaurant_id = p_restaurant_id and batch_id = p_batch_id);
end;
$$;

revoke all on function private.lock_catalog_codes(uuid), private.claim_catalog_code(uuid,uuid,text),
  private.guard_catalog_product_code(), private.validate_catalog_option_groups(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[]),
  public.get_catalog_import_result(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[]),
  public.get_catalog_import_result(uuid,uuid) to authenticated;

create or replace function public.import_products_batch(
  p_restaurant_id uuid, p_rows jsonb, p_mode text default 'upsert'
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_batch_id uuid; v_hash text; v_previous private.catalog_import_batches%rowtype;
  v_products jsonb; v_groups jsonb; v_options jsonb; v_planned jsonb := '[]'::jsonb;
  v_row jsonb; v_plan jsonb; v_related jsonb; v_index integer := 0; v_ref text;
  v_product public.products%rowtype; v_product_id uuid; v_category_id uuid; v_group_id uuid;
  v_code text; v_slug text; v_group_code text; v_option_code text; v_identity text;
  v_seen_refs text[] := '{}'; v_seen_ids uuid[] := '{}'; v_seen_children text[] := '{}';
  v_exists boolean; v_outcome text; v_result jsonb; v_results jsonb := '[]'::jsonb;
  v_public_results jsonb := '[]'::jsonb;
  v_relation_results jsonb; v_touched_children uuid[] := '{}';
  v_created integer := 0; v_updated integer := 0; v_skipped integer := 0;
  v_groups_count integer := 0; v_options_count integer := 0;
begin
  if v_uid is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_IMPORT_FORBIDDEN';
  end if;
  if p_mode is null or p_mode not in ('create','update','skip','upsert') then
    raise exception using errcode = '22023', message = 'IMPORT_MODE_INVALID';
  end if;
  if p_rows is null or pg_column_size(p_rows) > 2097152 then
    raise exception using errcode = '22023', message = 'IMPORT_PAYLOAD_TOO_LARGE';
  end if;
  if jsonb_typeof(p_rows) = 'array' then
    v_products := p_rows; v_groups := '[]'; v_options := '[]';
  elsif jsonb_typeof(p_rows) = 'object' then
    v_products := coalesce(p_rows->'products','[]'::jsonb);
    v_groups := coalesce(p_rows->'optionGroups','[]'::jsonb);
    v_options := coalesce(p_rows->'options','[]'::jsonb);
    v_batch_id := nullif(p_rows->>'batchId','')::uuid;
  else
    raise exception using errcode = '22023', message = 'IMPORT_ROWS_INVALID';
  end if;
  if jsonb_typeof(v_products) is distinct from 'array'
    or jsonb_typeof(v_groups) is distinct from 'array'
    or jsonb_typeof(v_options) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'IMPORT_ROWS_INVALID';
  end if;
  if jsonb_array_length(v_products) > 500
    or (v_batch_id is not null and jsonb_array_length(v_products)=0)
    or jsonb_array_length(v_groups) > 2500 or jsonb_array_length(v_options) > 10000 then
    raise exception using errcode = '22023', message = 'IMPORT_LIMIT_EXCEEDED';
  end if;
  perform private.lock_catalog_codes(p_restaurant_id);
  if not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'CATALOG_IMPORT_FORBIDDEN';
  end if;
  if v_batch_id is not null then
    v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
      'rows', p_rows - 'batchId', 'mode', p_mode)::text,'UTF8'),'sha256'),'hex');
    select * into v_previous from private.catalog_import_batches
    where restaurant_id = p_restaurant_id and batch_id = v_batch_id;
    if found then
      if v_previous.request_hash <> v_hash then
        raise exception using errcode = '22023', message = 'IMPORT_IDEMPOTENCY_CONFLICT';
      end if;
      return v_previous.result;
    end if;
  end if;

  -- Resolve every identity and reserve ALL explicit codes before allocating any automatic code.
  -- This prevents a blank row from consuming the explicit code of a later row in this batch.
  for v_row in select value from jsonb_array_elements(v_products) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_row) is distinct from 'object'
      or (v_row ? 'code' and jsonb_typeof(v_row->'code') not in ('string','null'))
      or (v_row ? 'rowRef' and jsonb_typeof(v_row->'rowRef') <> 'string') then
      raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_INVALID';
    end if;
    v_ref := coalesce(v_row->>'rowRef',v_index::text);
    if char_length(v_ref) not between 1 and 80 or v_ref ~ '[[:cntrl:]]' or v_ref = any(v_seen_refs) then
      raise exception using errcode = '22023', message = 'IMPORT_ROW_REFERENCE_INVALID';
    end if;
    v_seen_refs := array_append(v_seen_refs,v_ref);
    v_code := nullif(btrim(v_row->>'code'),'');
    if v_code is not null and (char_length(v_code) > 80 or v_code ~ '[[:cntrl:]]') then
      raise exception using errcode = '22023', message = 'PRODUCT_CODE_INVALID';
    end if;
    v_product_id := nullif(v_row->>'id','')::uuid;
    v_product := null;
    if v_product_id is not null then
      select * into v_product from public.products
      where id = v_product_id and restaurant_id = p_restaurant_id and deleted_at is null;
      if not found then raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_NOT_FOUND'; end if;
      if v_code is not null and lower(v_code) <> lower(v_product.code) then
        raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_IDENTITY_CONFLICT';
      end if;
    elsif v_code is not null then
      select * into v_product from public.products where restaurant_id = p_restaurant_id
        and lower(code) = lower(v_code) and deleted_at is null;
    end if;
    v_exists := v_product.id is not null;
    if v_exists then
      v_product_id := v_product.id; v_code := v_product.code;
    else
      v_product_id := extensions.gen_random_uuid();
      if v_code is null and v_batch_id is null then
        raise exception using errcode = '22023', message = 'IMPORT_BATCH_ID_REQUIRED';
      end if;
    end if;
    if v_product_id = any(v_seen_ids) then
      raise exception using errcode = '22023', message = 'IMPORT_DUPLICATE_PRODUCT';
    end if;
    v_seen_ids := array_append(v_seen_ids,v_product_id);
    if v_exists and p_mode = 'create' then
      raise exception using errcode = '23505', message = 'IMPORT_PRODUCT_CODE_EXISTS';
    elsif not v_exists and p_mode = 'update' then
      raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_NOT_FOUND';
    end if;
    v_outcome := case when not v_exists then 'created' when p_mode = 'skip' then 'skipped' else 'updated' end;
    if not v_exists and v_code is not null then
      -- A previously reserved code in this same batch is also a duplicate, never an upsert.
      if exists (select 1 from jsonb_array_elements(v_planned) r where lower(r->>'_code') = lower(v_code)) then
        raise exception using errcode = '22023', message = 'IMPORT_DUPLICATE_PRODUCT';
      end if;
      v_code := private.claim_catalog_code(p_restaurant_id,v_product_id,v_code);
    end if;
    v_planned := v_planned || jsonb_build_array(v_row || jsonb_build_object(
      '_id',v_product_id,'_code',v_code,'_rowRef',v_ref,'_outcome',v_outcome));
  end loop;

  for v_plan in select value from jsonb_array_elements(v_planned) loop
    v_product_id := (v_plan->>'_id')::uuid; v_code := v_plan->>'_code';
    v_outcome := v_plan->>'_outcome';
    if v_outcome = 'skipped' then
      v_skipped := v_skipped + 1;
    else
      if v_code is null then v_code := private.claim_catalog_code(p_restaurant_id,v_product_id,null); end if;
      if v_outcome = 'created' or v_plan ? 'category' or v_plan ? 'categorySlug' then
        v_slug := private.slugify(coalesce(v_plan->>'categorySlug',v_plan->>'category'));
        if v_slug is null or v_slug = '' or char_length(v_slug)>100 then
          raise exception using errcode = '22023', message = 'IMPORT_CATEGORY_INVALID';
        end if;
        select id into v_category_id from public.categories where restaurant_id=p_restaurant_id
          and slug=v_slug and deleted_at is null;
        if not found then
          insert into public.categories(restaurant_id,name,slug,created_by,updated_by)
          values(p_restaurant_id,btrim(coalesce(v_plan->>'category',v_plan->>'categorySlug')),v_slug,v_uid,v_uid)
          returning id into v_category_id;
        end if;
      else
        select category_id into v_category_id from public.products where id=v_product_id;
      end if;
      if v_outcome = 'created' then
        insert into public.products(id,restaurant_id,category_id,code,name,description,base_price_cents,
          promotional_price_cents,promotion_starts_at,promotion_ends_at,active,available,featured,sort_order,created_by,updated_by)
        values(v_product_id,p_restaurant_id,v_category_id,v_code,btrim(v_plan->>'name'),
          btrim(coalesce(v_plan->>'description','')),(v_plan->>'basePriceCents')::bigint,
          nullif(v_plan->>'promotionalPriceCents','')::bigint,nullif(v_plan->>'promotionStartsAt','')::timestamptz,
          nullif(v_plan->>'promotionEndsAt','')::timestamptz,coalesce((v_plan->>'active')::boolean,true),
          coalesce((v_plan->>'available')::boolean,true),coalesce((v_plan->>'featured')::boolean,false),
          coalesce((v_plan->>'sortOrder')::integer,0),v_uid,v_uid);
        v_created := v_created + 1;
      else
        -- Patch semantics: omitted columns preserve flags, promotions, description and ordering.
        -- Quantity-price rules and image paths are intentionally untouched by metadata imports.
        update public.products set category_id=v_category_id,
          name=case when v_plan ? 'name' then btrim(v_plan->>'name') else name end,
          description=case when v_plan ? 'description' then btrim(coalesce(v_plan->>'description','')) else description end,
          base_price_cents=case when v_plan ? 'basePriceCents' then (v_plan->>'basePriceCents')::bigint else base_price_cents end,
          promotional_price_cents=case when v_plan ? 'promotionalPriceCents' then nullif(v_plan->>'promotionalPriceCents','')::bigint else promotional_price_cents end,
          promotion_starts_at=case when v_plan ? 'promotionStartsAt' then nullif(v_plan->>'promotionStartsAt','')::timestamptz else promotion_starts_at end,
          promotion_ends_at=case when v_plan ? 'promotionEndsAt' then nullif(v_plan->>'promotionEndsAt','')::timestamptz else promotion_ends_at end,
          active=case when v_plan ? 'active' then (v_plan->>'active')::boolean else active end,
          available=case when v_plan ? 'available' then (v_plan->>'available')::boolean else available end,
          featured=case when v_plan ? 'featured' then (v_plan->>'featured')::boolean else featured end,
          sort_order=case when v_plan ? 'sortOrder' then (v_plan->>'sortOrder')::integer else sort_order end,
          updated_by=v_uid
        where id=v_product_id and restaurant_id=p_restaurant_id;
        v_updated := v_updated + 1;
      end if;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'rowRef',v_plan->>'_rowRef','id',v_product_id,'code',v_code,'outcome',v_outcome));
  end loop;

  v_relation_results := v_results;
  -- Legacy SQL callers may update only groups/options by an existing product code.
  -- Modern batches require their relationships to resolve against explicit source rows.
  if v_batch_id is null then
    for v_code in select distinct btrim(value->>'productCode')
      from jsonb_array_elements(v_groups || v_options)
      where nullif(btrim(value->>'productCode'),'') is not null
    loop
      if not exists (select 1 from jsonb_array_elements(v_relation_results) r
        where lower(r->>'code')=lower(v_code)) then
        select * into v_product from public.products where restaurant_id=p_restaurant_id
          and lower(code)=lower(v_code) and deleted_at is null;
        if found then
          v_relation_results := v_relation_results || jsonb_build_array(jsonb_build_object(
            'id',v_product.id,'code',v_product.code,'outcome','updated'));
        end if;
      end if;
    end loop;
  end if;
  for v_row in select value from jsonb_array_elements(v_groups) loop
    v_related := private.resolve_catalog_import_row(v_relation_results,v_row);
    if v_related->>'outcome' = 'skipped' then continue; end if;
    v_product_id := (v_related->>'id')::uuid;
    v_touched_children := array_append(v_touched_children,v_product_id);
    v_group_code := btrim(coalesce(v_row->>'groupCode',''));
    if char_length(v_group_code) not between 1 and 80 then
      raise exception using errcode = '22023', message = 'IMPORT_OPTION_GROUP_INVALID';
    end if;
    v_identity := v_product_id::text || ':' || lower(v_group_code);
    if v_identity = any(v_seen_children) then
      raise exception using errcode = '22023', message = 'IMPORT_DUPLICATE_GROUP';
    end if;
    v_seen_children := array_append(v_seen_children,v_identity);
    insert into public.product_option_groups(restaurant_id,product_id,code,name,required,min_select,max_select,sort_order,active)
    values(p_restaurant_id,v_product_id,v_group_code,btrim(v_row->>'name'),
      coalesce((v_row->>'required')::boolean,false),coalesce((v_row->>'minSelect')::integer,0),
      coalesce((v_row->>'maxSelect')::integer,1),coalesce((v_row->>'sortOrder')::integer,0),
      coalesce((v_row->>'active')::boolean,true))
    on conflict(product_id,lower(code)) where code is not null do update set
      name=excluded.name,required=excluded.required,min_select=excluded.min_select,max_select=excluded.max_select,
      sort_order=excluded.sort_order,active=excluded.active,updated_at=now();
    v_groups_count := v_groups_count + 1;
  end loop;
  v_seen_children := '{}';
  for v_row in select value from jsonb_array_elements(v_options) loop
    v_related := private.resolve_catalog_import_row(v_relation_results,v_row);
    if v_related->>'outcome' = 'skipped' then continue; end if;
    v_product_id := (v_related->>'id')::uuid;
    v_touched_children := array_append(v_touched_children,v_product_id);
    v_group_code := btrim(coalesce(v_row->>'groupCode',''));
    v_option_code := btrim(coalesce(v_row->>'optionCode',''));
    select id into v_group_id from public.product_option_groups where restaurant_id=p_restaurant_id
      and product_id=v_product_id and lower(code)=lower(v_group_code);
    if not found or char_length(v_option_code) not between 1 and 80 then
      raise exception using errcode = '22023', message = 'IMPORT_OPTION_INVALID';
    end if;
    v_identity := v_group_id::text || ':' || lower(v_option_code);
    if v_identity = any(v_seen_children) then
      raise exception using errcode = '22023', message = 'IMPORT_DUPLICATE_OPTION';
    end if;
    v_seen_children := array_append(v_seen_children,v_identity);
    insert into public.product_options(restaurant_id,option_group_id,code,name,price_delta_cents,sort_order,active)
    values(p_restaurant_id,v_group_id,v_option_code,btrim(v_row->>'name'),
      coalesce((v_row->>'priceDeltaCents')::bigint,0),coalesce((v_row->>'sortOrder')::integer,0),
      coalesce((v_row->>'active')::boolean,true))
    on conflict(option_group_id,lower(code)) where code is not null do update set
      name=excluded.name,price_delta_cents=excluded.price_delta_cents,sort_order=excluded.sort_order,
      active=excluded.active,updated_at=now();
    v_options_count := v_options_count + 1;
  end loop;
  for v_plan in select value from jsonb_array_elements(v_results) loop
    if v_plan->>'outcome' <> 'skipped' then
      perform private.validate_catalog_option_groups(p_restaurant_id,(v_plan->>'id')::uuid);
    end if;
    -- Old Edge clients validate result objects strictly. Echo rowRef only when supplied.
    if exists (select 1 from jsonb_array_elements(v_planned) p
      where p->>'_id'=v_plan->>'id' and p ? 'rowRef') then
      v_public_results := v_public_results || jsonb_build_array(v_plan);
    else
      v_public_results := v_public_results || jsonb_build_array(v_plan - 'rowRef');
    end if;
  end loop;
  for v_product_id in select distinct unnest(v_touched_children) loop
    perform private.validate_catalog_option_groups(p_restaurant_id,v_product_id);
  end loop;
  v_result := jsonb_build_object('summary',jsonb_build_object('created',v_created,'updated',v_updated,
    'skipped',v_skipped,'optionGroups',v_groups_count,'options',v_options_count),
    'products',v_public_results,'errors','[]'::jsonb);
  if v_batch_id is not null then
    v_result := v_result || jsonb_build_object('batchId',v_batch_id);
    insert into private.catalog_import_batches(restaurant_id,batch_id,request_hash,result,created_by)
    values(p_restaurant_id,v_batch_id,v_hash,v_result,v_uid);
  end if;
  insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,metadata)
  values(p_restaurant_id,v_uid,'import','product_batch',jsonb_build_object('created',v_created,
    'updated',v_updated,'skipped',v_skipped,'groups',v_groups_count,'options',v_options_count,
    'mode',p_mode,'batchId',v_batch_id));
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range or check_violation
  or not_null_violation or foreign_key_violation then
  raise exception using errcode = '22023', message = 'IMPORT_VALUE_INVALID';
end;
$$;

create function private.resolve_catalog_import_row(p_results jsonb,p_row jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_by_ref jsonb; v_by_code jsonb; v_ref text; v_code text;
begin
  if jsonb_typeof(p_row) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_REFERENCE_INVALID';
  end if;
  v_ref := nullif(p_row->>'productRowRef',''); v_code := nullif(btrim(p_row->>'productCode'),'');
  if v_ref is not null then
    select value into v_by_ref from jsonb_array_elements(p_results) where value->>'rowRef'=v_ref;
    if not found then raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_REFERENCE_INVALID'; end if;
  end if;
  if v_code is not null then
    select value into v_by_code from jsonb_array_elements(p_results) where lower(value->>'code')=lower(v_code);
    if not found then raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_REFERENCE_INVALID'; end if;
  end if;
  if (v_by_ref is null and v_by_code is null) or
    (v_by_ref is not null and v_by_code is not null and v_by_ref->>'id' <> v_by_code->>'id') then
    raise exception using errcode = '22023', message = 'IMPORT_PRODUCT_REFERENCE_INVALID';
  end if;
  return coalesce(v_by_ref,v_by_code);
end;
$$;
revoke all on function private.resolve_catalog_import_row(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.import_products_batch(uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.import_products_batch(uuid,jsonb,text) to authenticated;
