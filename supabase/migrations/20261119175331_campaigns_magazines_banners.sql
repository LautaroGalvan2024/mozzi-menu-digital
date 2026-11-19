-- Explicit tenant opt-in. A tenant without a row has every feature disabled.
create table private.stage_one_features (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  campaigns boolean not null default false,
  sellers boolean not null default false,
  delivery_schedule boolean not null default false,
  assisted_import boolean not null default false,
  stock_design boolean not null default false
);
alter table private.stage_one_features enable row level security;
revoke all on private.stage_one_features from public,anon,authenticated,service_role;

create function private.stage_one_feature_enabled(p_restaurant_id uuid,p_feature text)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce((
    select case p_feature
      when 'campaigns' then f.campaigns
      when 'sellers' then f.sellers
      when 'delivery_schedule' then f.delivery_schedule
      when 'assisted_import' then f.assisted_import
      when 'stock_design' then f.stock_design
    end
    from private.stage_one_features f where f.restaurant_id=p_restaurant_id
  ),false)
$$;
revoke all on function private.stage_one_feature_enabled(uuid,text) from public,anon,authenticated,service_role;

create function public.get_stage_one_features(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare features private.stage_one_features;
begin
  if not private.can_manage_orders(p_restaurant_id) then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  select * into features from private.stage_one_features where restaurant_id=p_restaurant_id;
  return jsonb_build_object(
    'campaigns',coalesce(features.campaigns,false),
    'sellers',coalesce(features.sellers,false),
    'delivery_schedule',coalesce(features.delivery_schedule,false),
    'assisted_import',coalesce(features.assisted_import,false),
    'stock_design',coalesce(features.stock_design,false)
  );
end $$;
revoke all on function public.get_stage_one_features(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_stage_one_features(uuid) to authenticated;

-- Optional, tenant-scoped editorial content. Prices always belong to the catalogue.
create table public.campaigns (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  slug text not null,
  kind text not null check(kind in ('magazine','banner')),
  title text not null check(char_length(title) between 1 and 120),
  description text not null default '' check(char_length(description)<=1000),
  image_path text,
  channels text[] not null check(cardinality(channels) between 1 and 2 and channels <@ array['menu','store']::text[]),
  status text not null default 'draft' check(status in ('draft','published','paused')),
  starts_at timestamptz,
  ends_at timestamptz,
  product_ids uuid[] not null default '{}' check(cardinality(product_ids)<=100),
  target_kind text not null default 'catalog' check(target_kind in ('catalog','product','category')),
  target_id uuid,
  sort_order integer not null default 0 check(sort_order between 0 and 9999),
  version bigint not null default 1,
  last_request_id uuid not null,
  last_request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique(restaurant_id,slug),
  check(ends_at is null or starts_at is null or ends_at>starts_at),
  check(image_path is null or image_path like 'restaurants/'||restaurant_id::text||'/%'),
  check((target_kind='catalog' and target_id is null) or (target_kind<>'catalog' and target_id is not null))
);
create index campaigns_public_idx on public.campaigns(restaurant_id,status,sort_order,id);
create index campaigns_image_ref_idx on public.campaigns(private.image_asset_primary_path(image_path));
alter table public.campaigns enable row level security;
revoke all on public.campaigns from public,anon,authenticated;
grant select on public.campaigns to authenticated;
create policy campaigns_read_admin on public.campaigns for select to authenticated
  using(private.can_manage_catalog(restaurant_id));
create trigger campaigns_image_reference_guard before insert or update of image_path on public.campaigns
  for each row execute function private.guard_image_asset_reference();

-- Include draft/public campaign images in the existing concurrent cleanup guard.
alter function private.image_asset_is_referenced(uuid,text) rename to image_asset_is_referenced_before_campaigns;
create function private.image_asset_is_referenced(p_restaurant_id uuid,p_path text) returns boolean
language sql stable security definer set search_path='' as $$
 select private.image_asset_is_referenced_before_campaigns(p_restaurant_id,p_path)
 or (p_path like 'restaurants/'||p_restaurant_id::text||'/%' and exists(select 1 from public.campaigns c where private.image_asset_primary_path(c.image_path)=private.image_asset_primary_path(p_path)))
$$;
revoke all on function private.image_asset_is_referenced(uuid,text) from public,anon,authenticated,service_role;

create function private.campaign_document(c public.campaigns) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',c.id,'slug',c.slug,'kind',c.kind,'title',c.title,'description',c.description,
 'imagePath',c.image_path,'channels',c.channels,'status',c.status,'startsAt',c.starts_at,'endsAt',c.ends_at,
 'productIds',c.product_ids,'targetKind',c.target_kind,'targetId',c.target_id,'sortOrder',c.sort_order,
 'version',c.version,'updatedAt',c.updated_at)
$$;
revoke all on function private.campaign_document(public.campaigns) from public,anon,authenticated,service_role;

create function public.get_admin_campaigns(p_restaurant_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.can_manage_catalog(p_restaurant_id) then raise exception using errcode='42501',message='CAMPAIGN_FORBIDDEN'; end if;
 if not private.stage_one_feature_enabled(p_restaurant_id,'campaigns') then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(private.campaign_document(c) order by c.updated_at desc,c.id) from public.campaigns c where restaurant_id=p_restaurant_id),'[]'::jsonb);
end $$;

create function public.save_campaign(p_restaurant_id uuid,p_id uuid,p_request_id uuid,p_expected_version bigint,p_document jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare old public.campaigns; saved public.campaigns; ids uuid[]; ch text[]; image text; target uuid; target_type text;
  first_at timestamptz; last_at timestamptz; content_hash text:=md5(p_document::text);
begin
 if not private.can_manage_catalog(p_restaurant_id) or not private.stage_one_feature_enabled(p_restaurant_id,'campaigns') or auth.uid() is null then raise exception using errcode='42501',message='CAMPAIGN_FORBIDDEN'; end if;
 if p_id is null or p_request_id is null or jsonb_typeof(p_document)<>'object' or octet_length(p_document::text)>65536 then raise exception using errcode='22023',message='CAMPAIGN_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('campaign:'||p_id::text,0));
 if not private.can_manage_catalog(p_restaurant_id) or not private.stage_one_feature_enabled(p_restaurant_id,'campaigns') then raise exception using errcode='42501',message='CAMPAIGN_FORBIDDEN'; end if;
 select * into old from public.campaigns where id=p_id for update;
 if found then
   if old.restaurant_id<>p_restaurant_id then raise exception using errcode='42501',message='CAMPAIGN_FORBIDDEN'; end if;
   if old.last_request_id=p_request_id then
     if old.last_request_hash<>content_hash then raise exception using errcode='22023',message='CAMPAIGN_REQUEST_CONFLICT'; end if;
     return private.campaign_document(old);
   end if;
   if p_expected_version is distinct from old.version then raise exception using errcode='PT409',message='CAMPAIGN_CHANGED'; end if;
 elsif p_expected_version is not null then raise exception using errcode='PT409',message='CAMPAIGN_CHANGED';
 end if;
 if jsonb_typeof(p_document->'productIds')<>'array' or jsonb_array_length(p_document->'productIds')>100
   or jsonb_typeof(p_document->'channels')<>'array' or jsonb_array_length(p_document->'channels') not between 1 and 2 then
   raise exception using errcode='22023',message='CAMPAIGN_INVALID'; end if;
 select coalesce(array_agg(value::uuid order by ordinality),'{}'::uuid[]) into ids from jsonb_array_elements_text(p_document->'productIds') with ordinality;
 select array_agg(value) into ch from jsonb_array_elements_text(p_document->'channels');
 if cardinality(ids)<>(select count(distinct x) from unnest(ids)x) or cardinality(ch)<>(select count(distinct x) from unnest(ch)x)
 or not ch <@ array['menu','store']::text[] then raise exception using errcode='22023',message='CAMPAIGN_INVALID'; end if;
 if exists(select 1 from unnest(ids)x where not exists(select 1 from public.products p where p.id=x and p.restaurant_id=p_restaurant_id and p.deleted_at is null)) then
   raise exception using errcode='22023',message='CAMPAIGN_PRODUCT_INVALID'; end if;
 image:=nullif(p_document->>'imagePath','');
 if image is not null and (image not like 'restaurants/'||p_restaurant_id::text||'/%' or not exists(select 1 from public.image_assets a where a.restaurant_id=p_restaurant_id and a.path=image and a.deleted_at is null)) then
   raise exception using errcode='22023',message='CAMPAIGN_IMAGE_INVALID'; end if;
 first_at:=nullif(p_document->>'startsAt','')::timestamptz; last_at:=nullif(p_document->>'endsAt','')::timestamptz;
 target_type:=coalesce(p_document->>'targetKind','catalog'); target:=nullif(p_document->>'targetId','')::uuid;
 if (target_type='product' and not exists(select 1 from public.products p where p.id=target and p.restaurant_id=p_restaurant_id and p.deleted_at is null))
 or (target_type='category' and not exists(select 1 from public.categories c where c.id=target and c.restaurant_id=p_restaurant_id and c.deleted_at is null)) then
 raise exception using errcode='22023',message='CAMPAIGN_TARGET_INVALID'; end if;
 if p_document->>'status'='published' then
   if last_at is not null and last_at<=statement_timestamp() then raise exception using errcode='22023',message='CAMPAIGN_EXPIRED'; end if;
   if p_document->>'kind'='magazine' and cardinality(ids)=0 then raise exception using errcode='22023',message='CAMPAIGN_EMPTY'; end if;
   if exists(select 1 from unnest(ch)channel where not private.commerce_channel_published(p_restaurant_id,channel)) then raise exception using errcode='22023',message='CAMPAIGN_CHANNEL_UNPUBLISHED'; end if;
 end if;
 insert into public.campaigns(id,restaurant_id,slug,kind,title,description,image_path,channels,status,starts_at,ends_at,product_ids,target_kind,target_id,sort_order,version,last_request_id,last_request_hash,created_by)
 values(p_id,p_restaurant_id,p_id::text,p_document->>'kind',btrim(p_document->>'title'),coalesce(p_document->>'description',''),image,ch,p_document->>'status',first_at,last_at,ids,target_type,target,coalesce((p_document->>'sortOrder')::integer,0),1,p_request_id,content_hash,auth.uid())
 on conflict(id) do update set kind=excluded.kind,title=excluded.title,description=excluded.description,image_path=excluded.image_path,channels=excluded.channels,status=excluded.status,
 starts_at=excluded.starts_at,ends_at=excluded.ends_at,product_ids=excluded.product_ids,target_kind=excluded.target_kind,target_id=excluded.target_id,sort_order=excluded.sort_order,
 version=campaigns.version+1,last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash,updated_at=clock_timestamp()
 returning * into saved;
 return private.campaign_document(saved);
end $$;

create function public.get_public_campaigns(p_restaurant_slug text,p_channel text default 'store') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; at_time timestamptz:=statement_timestamp(); boundary timestamptz; entries jsonb;
begin
 if p_channel not in ('menu','store') then return null; end if;
 select id into tenant from public.restaurants r where r.slug=lower(btrim(p_restaurant_slug)) and private.commerce_channel_published(r.id,p_channel);
 if tenant is null or not private.stage_one_feature_enabled(tenant,'campaigns') then return null; end if;
 select min(t) into boundary from public.campaigns c cross join lateral (values(c.starts_at),(c.ends_at)) b(t)
 where c.restaurant_id=tenant and c.status='published' and p_channel=any(c.channels) and t>at_time;
 select coalesce(jsonb_agg(private.campaign_document(c) order by c.sort_order,c.id),'[]'::jsonb) into entries
 from (select * from public.campaigns where restaurant_id=tenant and status='published' and p_channel=any(channels)
 and (starts_at is null or starts_at<=at_time) and (ends_at is null or ends_at>at_time) order by sort_order,id limit 20)c;
 return jsonb_build_object('items',entries,'serverNow',at_time,'validUntil',boundary);
end $$;

create function public.get_public_campaign(p_restaurant_slug text,p_campaign_slug text,p_channel text default 'store') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; c public.campaigns; at_time timestamptz:=statement_timestamp(); catalogue jsonb; product_data jsonb; boundary timestamptz;
begin
 if p_channel not in ('menu','store') then return null; end if;
 select id into tenant from public.restaurants r where r.slug=lower(btrim(p_restaurant_slug)) and private.commerce_channel_published(r.id,p_channel);
 if tenant is null or not private.stage_one_feature_enabled(tenant,'campaigns') then return null; end if;
 select * into c from public.campaigns where restaurant_id=tenant and slug=p_campaign_slug and status='published' and kind='magazine' and p_channel=any(channels)
 and (starts_at is null or starts_at<=at_time);
 if not found then return null; end if;
 catalogue:=public.get_public_catalog_meta(p_restaurant_slug,p_channel);
 if c.ends_at is not null and c.ends_at<=at_time then
   return jsonb_build_object('campaign',private.campaign_document(c),'restaurant',catalogue->'restaurant','products','[]'::jsonb,'expired',true,'serverNow',at_time,'validUntil',null);
 end if;
 product_data:=public.get_public_products_by_ids(p_restaurant_slug,p_channel,c.product_ids);
 select min(t) into boundary from (select c.ends_at t union all select p.promotion_starts_at from public.products p where p.id=any(c.product_ids)
 union all select p.promotion_ends_at from public.products p where p.id=any(c.product_ids))b where t>at_time;
 return jsonb_build_object('campaign',private.campaign_document(c),'restaurant',catalogue->'restaurant','products',product_data->'products','expired',false,'serverNow',at_time,'validUntil',boundary);
end $$;

revoke all on function public.get_admin_campaigns(uuid),public.save_campaign(uuid,uuid,uuid,bigint,jsonb),public.get_public_campaigns(text,text),public.get_public_campaign(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_campaigns(uuid),public.save_campaign(uuid,uuid,uuid,bigint,jsonb) to authenticated;
grant execute on function public.get_public_campaigns(text,text),public.get_public_campaign(text,text,text) to anon,authenticated;
