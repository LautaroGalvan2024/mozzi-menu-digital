-- Optional delivery estimates. Existing channels and orders keep their behavior.
create table public.delivery_schedules (
  delivery_zone_id uuid primary key,
  restaurant_id uuid not null,
  menu_enabled boolean not null default false,
  store_enabled boolean not null default false,
  weekdays smallint[] not null default '{}',
  cutoff_time time not null default '18:00',
  cutoff_day_offset smallint not null default 1 check (cutoff_day_offset in (0, 1)),
  closed_dates date[] not null default '{}',
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  foreign key (delivery_zone_id, restaurant_id) references public.delivery_zones(id, restaurant_id) on delete cascade,
  check (cardinality(weekdays) <= 7 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[] and array_position(weekdays, null) is null),
  check (not (menu_enabled or store_enabled) or cardinality(weekdays) > 0),
  check (cardinality(closed_dates) <= 60 and array_position(closed_dates, null) is null),
  check (extract(second from cutoff_time) = 0)
);
create index delivery_schedules_restaurant_idx on public.delivery_schedules(restaurant_id);
alter table public.delivery_schedules enable row level security;
create policy delivery_schedules_read_member on public.delivery_schedules
  for select to authenticated using (private.can_view_restaurant(restaurant_id));
revoke all on public.delivery_schedules from public, anon, authenticated;
grant select on public.delivery_schedules to authenticated;
grant all on public.delivery_schedules to service_role;

create function private.delivery_schedule_json(p_schedule public.delivery_schedules)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('zoneId',p_schedule.delivery_zone_id,
    'menuEnabled',p_schedule.menu_enabled,'storeEnabled',p_schedule.store_enabled,
    'weekdays',to_jsonb(p_schedule.weekdays),'cutoffTime',to_char(p_schedule.cutoff_time,'HH24:MI'),
    'cutoffDayOffset',p_schedule.cutoff_day_offset,'closedDates',to_jsonb(p_schedule.closed_dates),
    'revision',p_schedule.revision,'updatedAt',p_schedule.updated_at)
$$;

create function public.get_delivery_schedule_policies(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  if not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(private.delivery_schedule_json(s) order by s.delivery_zone_id)
    from public.delivery_schedules s where s.restaurant_id=p_restaurant_id),'[]'::jsonb);
end $$;

create function public.save_delivery_schedule_policy(
  p_restaurant_id uuid,p_zone_id uuid,p_policy jsonb,
  p_copy_zone_ids uuid[] default '{}',p_expected_revision bigint default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  targets uuid[]; target uuid; found_count integer; old_revision bigint;
  days smallint[]; closures date[]; enabled_menu boolean; enabled_store boolean;
  cutoff time; offset_days smallint; saved public.delivery_schedules; previous jsonb;
begin
  if not private.can_manage_restaurant(p_restaurant_id)
    or not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-schedules:'||p_restaurant_id::text,0));
  if not private.can_manage_restaurant(p_restaurant_id)
    or not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  if p_zone_id is null or p_copy_zone_ids is null or cardinality(p_copy_zone_ids)>100
    or array_position(p_copy_zone_ids,null) is not null then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end if;
  if p_policy is null or jsonb_typeof(p_policy)<>'object' or pg_column_size(p_policy)>16384 then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end if;
  if p_policy-array['menuEnabled','storeEnabled','weekdays','cutoffTime','cutoffDayOffset','closedDates']<>'{}'::jsonb
    or jsonb_typeof(p_policy->'menuEnabled') is distinct from 'boolean'
    or jsonb_typeof(p_policy->'storeEnabled') is distinct from 'boolean'
    or jsonb_typeof(p_policy->'weekdays') is distinct from 'array'
    or jsonb_typeof(p_policy->'closedDates') is distinct from 'array'
    or coalesce(p_policy->>'cutoffTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_policy->>'cutoffDayOffset','') !~ '^[01]$' then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end if;
  if jsonb_array_length(p_policy->'weekdays')>7 or jsonb_array_length(p_policy->'closedDates')>60
    or exists(select 1 from jsonb_array_elements(p_policy->'weekdays') d where jsonb_typeof(d)<>'number' or d::text !~ '^[0-6]$')
    or exists(select 1 from jsonb_array_elements(p_policy->'closedDates') d where jsonb_typeof(d)<>'string' or d#>>'{}' !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end if;
  select coalesce(array_agg(distinct d::smallint order by d::smallint),'{}') into days
    from jsonb_array_elements_text(p_policy->'weekdays') d;
  begin
    select coalesce(array_agg(distinct d::date order by d::date),'{}') into closures
      from jsonb_array_elements_text(p_policy->'closedDates') d;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end;
  enabled_menu:=(p_policy->>'menuEnabled')::boolean;
  enabled_store:=(p_policy->>'storeEnabled')::boolean;
  cutoff:=(p_policy->>'cutoffTime')::time;
  offset_days:=(p_policy->>'cutoffDayOffset')::smallint;
  if (enabled_menu or enabled_store) and cardinality(days)=0 then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_DAYS_REQUIRED';
  end if;
  select array_agg(distinct id order by id) into targets from unnest(p_copy_zone_ids||p_zone_id) id;
  -- Lock every destination in stable order; a foreign destination rejects the whole copy.
  perform id from public.delivery_zones where restaurant_id=p_restaurant_id and id=any(targets) order by id for update;
  get diagnostics found_count=row_count;
  if found_count<>cardinality(targets) then
    raise exception using errcode='22023',message='DELIVERY_ZONE_INVALID';
  end if;
  if not private.can_manage_restaurant(p_restaurant_id)
    or not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  select revision into old_revision from public.delivery_schedules where delivery_zone_id=p_zone_id;
  if p_expected_revision is not null and p_expected_revision<>coalesce(old_revision,0) then
    -- A stale form is an HTTP conflict, not a retryable database serialization failure.
    raise exception using errcode='PT409',message='DELIVERY_SCHEDULE_CHANGED';
  end if;
  foreach target in array targets loop
    select private.delivery_schedule_json(s) into previous from public.delivery_schedules s where delivery_zone_id=target;
    insert into public.delivery_schedules(delivery_zone_id,restaurant_id,menu_enabled,store_enabled,weekdays,cutoff_time,cutoff_day_offset,closed_dates)
      values(target,p_restaurant_id,enabled_menu,enabled_store,days,cutoff,offset_days,closures)
    on conflict(delivery_zone_id) do update set menu_enabled=excluded.menu_enabled,store_enabled=excluded.store_enabled,
      weekdays=excluded.weekdays,cutoff_time=excluded.cutoff_time,cutoff_day_offset=excluded.cutoff_day_offset,
      closed_dates=excluded.closed_dates,revision=delivery_schedules.revision+1,updated_at=now()
    returning * into saved;
    insert into public.audit_logs(restaurant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
      values(p_restaurant_id,auth.uid(),case when previous is null then 'create'::public.audit_action else 'update'::public.audit_action end,
        'delivery_schedule',target,previous,private.delivery_schedule_json(saved));
  end loop;
  return jsonb_build_object('saved',cardinality(targets),'zoneId',p_zone_id);
end $$;

-- One save in the form is one database transaction, including an optional schedule copy.
create function public.save_delivery_zone_settings(
  p_restaurant_id uuid,p_zone_id uuid,p_zone jsonb,p_policy jsonb default null,
  p_copy_zone_ids uuid[] default '{}',p_expected_revision bigint default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  if p_policy is not null and not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  if p_policy is null and p_copy_zone_ids is distinct from '{}'::uuid[] then
    raise exception using errcode='22023',message='DELIVERY_SCHEDULE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-schedules:'||p_restaurant_id::text,0));
  if not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode='42501',message='DELIVERY_SCHEDULE_FORBIDDEN';
  end if;
  if p_zone_id is null or p_zone is null or jsonb_typeof(p_zone)<>'object' or pg_column_size(p_zone)>8192 then
    raise exception using errcode='22023',message='DELIVERY_ZONE_INVALID';
  end if;
  if p_zone-array['name','description','deliveryFeeCents','minimumOrderCents','freeShippingFromCents','active','sortOrder']<>'{}'::jsonb
    or jsonb_typeof(p_zone->'name') is distinct from 'string'
    or char_length(btrim(p_zone->>'name')) not between 1 and 120
    or jsonb_typeof(p_zone->'description') is distinct from 'string'
    or char_length(p_zone->>'description')>1000
    or jsonb_typeof(p_zone->'active') is distinct from 'boolean'
    or coalesce(p_zone->>'deliveryFeeCents','') !~ '^\d{1,13}$'
    or coalesce(p_zone->>'minimumOrderCents','') !~ '^\d{1,13}$'
    or (p_zone->>'freeShippingFromCents' is not null and p_zone->>'freeShippingFromCents' !~ '^\d{1,13}$')
    or coalesce(p_zone->>'sortOrder','') !~ '^-?\d{1,6}$' then
    raise exception using errcode='22023',message='DELIVERY_ZONE_INVALID';
  end if;
  -- A caller cannot overwrite a zone owned by another commerce.
  if exists(select 1 from public.delivery_zones where id=p_zone_id and restaurant_id<>p_restaurant_id) then
    raise exception using errcode='22023',message='DELIVERY_ZONE_INVALID';
  end if;
  insert into public.delivery_zones(id,restaurant_id,name,description,delivery_fee_cents,minimum_order_cents,free_shipping_from_cents,active,sort_order)
    values(p_zone_id,p_restaurant_id,btrim(p_zone->>'name'),btrim(p_zone->>'description'),
      (p_zone->>'deliveryFeeCents')::bigint,(p_zone->>'minimumOrderCents')::bigint,
      (p_zone->>'freeShippingFromCents')::bigint,(p_zone->>'active')::boolean,(p_zone->>'sortOrder')::integer)
  on conflict(id) do update set name=excluded.name,description=excluded.description,
    delivery_fee_cents=excluded.delivery_fee_cents,minimum_order_cents=excluded.minimum_order_cents,
    free_shipping_from_cents=excluded.free_shipping_from_cents,active=excluded.active,sort_order=excluded.sort_order
    where delivery_zones.restaurant_id=p_restaurant_id;
  if p_policy is null then return jsonb_build_object('saved',1,'zoneId',p_zone_id); end if;
  return public.save_delivery_schedule_policy(p_restaurant_id,p_zone_id,p_policy,p_copy_zone_ids,p_expected_revision);
end $$;

create function private.next_estimated_delivery_date(
  p_restaurant_id uuid,p_zone_id uuid,p_channel text,p_now timestamptz default now()
) returns date language plpgsql stable security definer set search_path='' as $$
declare policy public.delivery_schedules; local_now timestamp; candidate date; day_offset integer;
begin
  if p_channel is null or p_channel not in ('menu','store') or p_now is null then return null; end if;
  if not private.stage_one_feature_enabled(p_restaurant_id,'delivery_schedule') then return null; end if;
  select s.* into policy from public.delivery_schedules s
    join public.delivery_zones z on z.id=s.delivery_zone_id and z.restaurant_id=s.restaurant_id
    where s.restaurant_id=p_restaurant_id and s.delivery_zone_id=p_zone_id and z.active
      and case p_channel when 'menu' then s.menu_enabled else s.store_enabled end;
  if not found then return null; end if;
  select p_now at time zone r.timezone into local_now from public.restaurants r where r.id=p_restaurant_id;
  if local_now is null then return null; end if;
  for day_offset in 0..366 loop
    candidate:=local_now::date+day_offset;
    if extract(dow from candidate)::smallint=any(policy.weekdays)
      and not candidate=any(policy.closed_dates)
      and local_now < (candidate-policy.cutoff_day_offset)+policy.cutoff_time then
      return candidate;
    end if;
  end loop;
  return null;
end $$;

create function public.get_delivery_estimate(
  p_restaurant_slug text,p_delivery_zone_id uuid,p_channel text default 'menu'
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants; policy public.delivery_schedules; enabled boolean; server_now timestamptz:=now();
begin
  if p_channel is null or p_channel not in ('menu','store') then return null; end if;
  select * into r from public.restaurants where slug=lower(btrim(p_restaurant_slug))
    and delivery_enabled and private.commerce_channel_published(id,p_channel);
  if not found or not exists(select 1 from public.delivery_zones where id=p_delivery_zone_id and restaurant_id=r.id and active) then return null; end if;
  select * into policy from public.delivery_schedules where delivery_zone_id=p_delivery_zone_id and restaurant_id=r.id;
  enabled:=private.stage_one_feature_enabled(r.id,'delivery_schedule')
    and coalesce(case p_channel when 'menu' then policy.menu_enabled else policy.store_enabled end,false);
  return jsonb_build_object('enabled',enabled,'estimatedDate',case when enabled then private.next_estimated_delivery_date(r.id,p_delivery_zone_id,p_channel,server_now) else null end,
    'timezone',r.timezone,'serverNow',server_now,'label','Entrega estimada, a confirmar por el comercio');
end $$;

alter table public.orders add column estimated_delivery_date date;
comment on column public.orders.estimated_delivery_date is 'Automatic delivery estimate captured once at creation; merchant confirmation is still required.';
create or replace function private.order_public_context(p_order public.orders)
returns jsonb language sql stable set search_path='' as $$
  select private.order_seller_context(p_order) || case when p_order.estimated_delivery_date is null then '{}'::jsonb
    else jsonb_build_object('estimatedDeliveryDate',p_order.estimated_delivery_date) end
$$;
create function private.capture_order_delivery_estimate()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.estimated_delivery_date is distinct from old.estimated_delivery_date then
      raise exception using errcode='22023',message='DELIVERY_ESTIMATE_IMMUTABLE';
    end if;
    return new;
  end if;
  new.estimated_delivery_date:=case when new.fulfillment_type='delivery'
    then private.next_estimated_delivery_date(new.restaurant_id,new.delivery_zone_id,new.channel,now()) else null end;
  return new;
end $$;
create trigger orders_capture_delivery_estimate before insert on public.orders
  for each row execute function private.capture_order_delivery_estimate();
create trigger orders_preserve_delivery_estimate before update of estimated_delivery_date on public.orders
  for each row execute function private.capture_order_delivery_estimate();
create index orders_estimated_delivery_idx on public.orders(restaurant_id,estimated_delivery_date)
  where estimated_delivery_date is not null;

revoke all on function private.delivery_schedule_json(public.delivery_schedules),
  private.next_estimated_delivery_date(uuid,uuid,text,timestamptz),private.capture_order_delivery_estimate()
  from public,anon,authenticated,service_role;
revoke all on function public.get_delivery_schedule_policies(uuid),
  public.save_delivery_schedule_policy(uuid,uuid,jsonb,uuid[],bigint),
  public.save_delivery_zone_settings(uuid,uuid,jsonb,jsonb,uuid[],bigint),
  public.get_delivery_estimate(text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_delivery_schedule_policies(uuid),
  public.save_delivery_schedule_policy(uuid,uuid,jsonb,uuid[],bigint),
  public.save_delivery_zone_settings(uuid,uuid,jsonb,jsonb,uuid[],bigint) to authenticated;
grant execute on function public.get_delivery_estimate(text,uuid,text) to anon,authenticated,service_role;
