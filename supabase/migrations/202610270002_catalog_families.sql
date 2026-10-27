-- A product remains the physical SKU. Families only group its presentation.
create table public.product_families (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid not null,
  code text not null check (char_length(btrim(code)) between 1 and 80 and code !~ '[[:cntrl:]]'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  image_path text check (image_path is null or (char_length(image_path) <= 500 and image_path like 'restaurants/'||restaurant_id::text||'/%')),
  axes text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,restaurant_id),
  unique (id,restaurant_id,category_id),
  foreign key (category_id,restaurant_id) references public.categories(id,restaurant_id)
);
create unique index product_families_code_idx on public.product_families(restaurant_id,lower(code));
alter table public.products add column family_id uuid,
  add column variant_attributes jsonb not null default '{}'::jsonb,
  add constraint products_family_category_fk foreign key (family_id,restaurant_id,category_id)
    references public.product_families(id,restaurant_id,category_id) deferrable initially deferred,
  add constraint products_family_combination_unique unique(family_id,variant_attributes) deferrable initially deferred,
  add constraint products_variant_object check (jsonb_typeof(variant_attributes)='object'),
  add constraint products_simple_attributes check (family_id is not null or variant_attributes='{}'::jsonb);
create index products_family_idx on public.products(family_id);

alter table public.product_families enable row level security;
revoke all on public.product_families from public,anon,authenticated;
grant select on public.product_families to authenticated;
grant all on public.product_families to service_role;
create policy product_families_read on public.product_families for select to authenticated
  using (private.can_view_restaurant(restaurant_id));

create function private.valid_variant_axes(p_axes text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(cardinality(p_axes) between 1 and 3
    and cardinality(p_axes)=(select count(distinct lower(btrim(x))) from unnest(p_axes) x)
    and not exists(select 1 from unnest(p_axes) x where x is null or x<>btrim(x)
      or char_length(x) not between 1 and 40 or x ~ '[[:cntrl:]]'),false)
$$;
alter table public.product_families add constraint product_families_axes_valid check(private.valid_variant_axes(axes));

create function private.validate_family_products(p_family_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare f public.product_families%rowtype;
begin
  select * into f from public.product_families where id=p_family_id;
  if not found then return; end if;
  if exists(select 1 from public.products p where p.family_id=f.id and (
      p.restaurant_id<>f.restaurant_id or p.category_id<>f.category_id
      or (select count(*) from jsonb_object_keys(p.variant_attributes))<>cardinality(f.axes)
      or not (p.variant_attributes ?& f.axes)
      or exists(select 1 from jsonb_each(p.variant_attributes) a where jsonb_typeof(a.value)<>'string'
        or char_length(btrim(a.value#>>'{}')) not between 1 and 80
        or (a.value#>>'{}')<>btrim(a.value#>>'{}') or (a.value#>>'{}') ~ '[[:cntrl:]]')
    )) then raise exception using errcode='22023',message='FAMILY_VARIANT_INVALID'; end if;
  if exists(select 1 from public.products p where p.family_id=f.id
    group by p.variant_attributes having count(*)>1) then
    raise exception using errcode='23505',message='FAMILY_VARIANT_DUPLICATE';
  end if;
end $$;

create function private.check_family_graph() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='product_families' then
    perform private.validate_family_products(new.id);
  else
    if new.family_id is not null then perform private.validate_family_products(new.family_id); end if;
  end if;
  return null;
end $$;
create constraint trigger product_families_graph_check after insert or update on public.product_families
  deferrable initially deferred for each row execute function private.check_family_graph();
create constraint trigger products_family_graph_check after insert or update on public.products
  deferrable initially deferred for each row execute function private.check_family_graph();

create function public.save_product_family(p_restaurant_id uuid,p_family jsonb,p_variants jsonb) returns jsonb
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

-- Old files and idempotency hashes remain intact. Family metadata is part of the
-- same transaction and hash as the SKU import; a replay never reapplies grouping.
alter function public.import_products_batch(uuid,jsonb,text) rename to import_products_without_families;
alter function public.import_products_without_families(uuid,jsonb,text) set schema private;
create function public.import_products_batch(p_restaurant_id uuid,p_rows jsonb,p_mode text default 'upsert')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_products jsonb; v_row jsonb; v_outcome jsonb; v_index integer:=0;
  v_replay boolean; v_family public.product_families%rowtype; v_product public.products%rowtype;
  v_key text; v_axes text[]; v_touched uuid[]:='{}'; v_family_id uuid;
begin
  if auth.uid() is null or not private.can_manage_catalog(p_restaurant_id) then
    raise exception using errcode='42501',message='CATALOG_IMPORT_FORBIDDEN';
  end if;
  perform private.lock_catalog_codes(p_restaurant_id);
  v_replay:=exists(select 1 from private.catalog_import_batches
    where restaurant_id=p_restaurant_id and batch_id=nullif(p_rows->>'batchId','')::uuid);
  v_result:=private.import_products_without_families(p_restaurant_id,p_rows,p_mode);
  if v_replay then return v_result; end if;
  v_products:=case when jsonb_typeof(p_rows)='array' then p_rows else p_rows->'products' end;
  for v_row in select value from jsonb_array_elements(v_products) loop
    v_outcome:=v_result->'products'->v_index; v_index:=v_index+1;
    if v_outcome->>'outcome'='skipped' or not(v_row ?| array['familyCode','familyName','variantAttributes']) then continue; end if;
    v_key:=btrim(v_row->>'familyCode');
    if v_key is null or char_length(v_key) not between 1 and 80 or v_key ~ '[[:cntrl:]]'
      or char_length(btrim(coalesce(v_row->>'familyName',''))) not between 1 and 120
      or jsonb_typeof(v_row->'variantAttributes') is distinct from 'object' then
      raise exception using errcode='22023',message='FAMILY_IMPORT_INVALID';
    end if;
    v_axes:=array(select jsonb_object_keys(v_row->'variantAttributes') order by 1);
    if not private.valid_variant_axes(v_axes) then raise exception using errcode='22023',message='FAMILY_IMPORT_INVALID'; end if;
    select * into strict v_product from public.products where id=(v_outcome->>'id')::uuid and restaurant_id=p_restaurant_id;
    select * into v_family from public.product_families where restaurant_id=p_restaurant_id and lower(code)=lower(v_key) for update;
    if not found then
      insert into public.product_families(restaurant_id,category_id,code,name,axes)
      values(p_restaurant_id,v_product.category_id,v_key,btrim(v_row->>'familyName'),v_axes) returning * into v_family;
    elsif v_family.name<>btrim(v_row->>'familyName') or v_family.category_id<>v_product.category_id
      or not (v_family.axes @> v_axes and v_axes @> v_family.axes) then
      raise exception using errcode='22023',message='FAMILY_IMPORT_CONFLICT';
    end if;
    if v_product.family_id is not null and v_product.family_id<>v_family.id then
      raise exception using errcode='22023',message='FAMILY_IMPORT_CONFLICT';
    end if;
    update public.products set family_id=v_family.id,variant_attributes=v_row->'variantAttributes' where id=v_product.id;
    v_touched:=array_append(v_touched,v_family.id);
  end loop;
  for v_family_id in select distinct unnest(v_touched) loop
    perform private.validate_family_products(v_family_id);
  end loop;
  return v_result;
end $$;

create function private.catalog_with_families(p_catalog jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_set(p_catalog,'{categories}',coalesce((select jsonb_agg(
    jsonb_set(c.value,'{products}',coalesce((select jsonb_agg(p.value || jsonb_build_object(
      'family',case when f.id is null then null else jsonb_build_object('id',f.id,'name',f.name,
        'description',f.description,'imagePath',f.image_path,'axes',to_jsonb(f.axes)) end,
      'variantAttributes',s.variant_attributes) order by p.ordinality)
      from jsonb_array_elements(c.value->'products') with ordinality p(value,ordinality)
      join public.products s on s.id=(p.value->>'id')::uuid
      left join public.product_families f on f.id=s.family_id
      where f.id is null or f.active),'[]'::jsonb)) order by c.ordinality)
    from jsonb_array_elements(p_catalog->'categories') with ordinality c(value,ordinality)),'[]'::jsonb))
$$;
alter function public.get_public_catalog(text,text) rename to get_public_catalog_without_families;
alter function public.get_public_catalog_without_families(text,text) set schema private;
create function public.get_public_catalog(p_restaurant_slug text,p_channel text default 'menu') returns jsonb
language sql stable security definer set search_path='' as $$
  select private.catalog_with_families(private.get_public_catalog_without_families(p_restaurant_slug,p_channel))
$$;

alter table public.order_items add column family_name_snapshot text,
  add column variant_attributes_snapshot jsonb not null default '{}'::jsonb;
create function private.snapshot_order_variant() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_product public.products%rowtype; f public.product_families%rowtype; v_label text;
begin
  select * into v_product from public.products where id=new.product_id and restaurant_id=new.restaurant_id for share;
  if v_product.family_id is not null then
    select * into f from public.product_families where id=v_product.family_id for share;
    if not found or not f.active then raise exception using errcode='22023',message='PRODUCT_UNAVAILABLE'; end if;
    new.family_name_snapshot:=f.name;
    new.variant_attributes_snapshot:=v_product.variant_attributes;
    select string_agg(v_product.variant_attributes->>a,' / ' order by n) into v_label
      from unnest(f.axes) with ordinality x(a,n);
    new.product_name_snapshot:=left(f.name||' · '||v_label,160);
  end if;
  return new;
end $$;
create trigger order_items_variant_snapshot before insert on public.order_items
  for each row execute function private.snapshot_order_variant();

revoke all on function private.valid_variant_axes(text[]),private.validate_family_products(uuid),
  private.check_family_graph(),private.import_products_without_families(uuid,jsonb,text),
  private.catalog_with_families(jsonb),private.get_public_catalog_without_families(text,text),
  private.snapshot_order_variant() from public,anon,authenticated,service_role;
-- Constraint checks execute under the mutating RPC owner, not the browser.
revoke all on function public.save_product_family(uuid,jsonb,jsonb),public.import_products_batch(uuid,jsonb,text),
  public.get_public_catalog(text,text) from public,anon,authenticated,service_role;
grant execute on function public.save_product_family(uuid,jsonb,jsonb),public.import_products_batch(uuid,jsonb,text) to authenticated;
grant execute on function public.get_public_catalog(text,text) to anon,authenticated,service_role;
