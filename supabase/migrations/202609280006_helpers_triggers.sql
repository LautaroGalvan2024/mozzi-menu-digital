-- RLS-safe authorization helpers. Each definer function fixes search_path and is non-executable publicly.
create or replace function private.current_aal()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_user_roles pur
    join public.profiles p on p.id = pur.user_id and p.active
    where pur.user_id = (select auth.uid())
      and pur.role = 'super_admin'::public.platform_role
  )
$$;

create or replace function private.is_super_admin_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_super_admin() and private.current_aal() = 'aal2'
$$;

create or replace function private.has_restaurant_role(
  p_restaurant_id uuid,
  p_roles public.restaurant_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_members rm
    join public.profiles p on p.id = rm.user_id and p.active
    where rm.user_id = (select auth.uid())
      and rm.restaurant_id = p_restaurant_id
      and rm.status = 'active'::public.membership_status
      and rm.role = any (p_roles)
  )
$$;

create or replace function private.can_view_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_super_admin()
    or private.has_restaurant_role(
      p_restaurant_id,
      array['restaurant_admin', 'order_manager']::public.restaurant_role[]
    )
$$;

create or replace function private.can_manage_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_super_admin_aal2()
    or private.has_restaurant_role(
      p_restaurant_id,
      array['restaurant_admin']::public.restaurant_role[]
    )
$$;

create or replace function private.can_manage_catalog(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_manage_restaurant(p_restaurant_id)
$$;

create or replace function private.can_manage_orders(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_super_admin_aal2()
    or private.has_restaurant_role(
      p_restaurant_id,
      array['restaurant_admin', 'order_manager']::public.restaurant_role[]
    )
$$;

create or replace function private.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_profile_id = (select auth.uid())
    or private.is_super_admin()
    or exists (
      select 1
      from public.restaurant_members mine
      join public.restaurant_members theirs
        on theirs.restaurant_id = mine.restaurant_id
       and theirs.user_id = p_profile_id
      where mine.user_id = (select auth.uid())
        and mine.status = 'active'::public.membership_status
        and mine.role = 'restaurant_admin'::public.restaurant_role
    )
$$;

create or replace function private.storage_restaurant_id(p_name text)
returns uuid
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_name !~ '^restaurants/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/'
     or p_name ~ '(^|/)\.\.(/|$)' then
    return null;
  end if;
  return split_part(p_name, '/', 2)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function private.restaurant_is_open(
  p_restaurant_id uuid,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_local timestamp;
  v_date date;
  v_time time;
  v_dow smallint;
  v_previous_date date;
  v_previous_dow smallint;
  v_current_has_special boolean;
  v_previous_has_special boolean;
begin
  select r.timezone into v_timezone
  from public.restaurants r
  where r.id = p_restaurant_id;

  if v_timezone is null then
    return false;
  end if;

  v_local := p_at at time zone v_timezone;
  v_date := v_local::date;
  v_time := v_local::time;
  v_dow := extract(dow from v_date)::smallint;
  v_previous_date := v_date - 1;
  v_previous_dow := extract(dow from v_previous_date)::smallint;

  -- A full-day closure overrides a slot that crossed midnight from yesterday.
  if exists (
    select 1 from public.special_hours sh
    where sh.restaurant_id = p_restaurant_id
      and sh.date = v_date and sh.is_closed
  ) then
    return false;
  end if;

  select exists (
    select 1 from public.special_hours sh
    where sh.restaurant_id = p_restaurant_id and sh.date = v_date
  ) into v_current_has_special;

  if v_current_has_special then
    if exists (
      select 1 from public.special_hours sh
      where sh.restaurant_id = p_restaurant_id
        and sh.date = v_date
        and not sh.is_closed
        and (
          (not sh.spans_next_day and v_time >= sh.opens_at and v_time < sh.closes_at)
          or (sh.spans_next_day and v_time >= sh.opens_at)
        )
    ) then
      return true;
    end if;
  else
    if exists (
      select 1 from public.business_hours bh
      where bh.restaurant_id = p_restaurant_id
        and bh.day_of_week = v_dow
        and bh.active
        and (
          (not bh.spans_next_day and v_time >= bh.opens_at and v_time < bh.closes_at)
          or (bh.spans_next_day and v_time >= bh.opens_at)
        )
    ) then
      return true;
    end if;
  end if;

  select exists (
    select 1 from public.special_hours sh
    where sh.restaurant_id = p_restaurant_id and sh.date = v_previous_date
  ) into v_previous_has_special;

  if v_previous_has_special then
    return exists (
      select 1 from public.special_hours sh
      where sh.restaurant_id = p_restaurant_id
        and sh.date = v_previous_date
        and not sh.is_closed
        and sh.spans_next_day
        and v_time < sh.closes_at
    );
  end if;

  return exists (
    select 1 from public.business_hours bh
    where bh.restaurant_id = p_restaurant_id
      and bh.day_of_week = v_previous_dow
      and bh.active
      and bh.spans_next_day
      and v_time < bh.closes_at
  );
end;
$$;

create or replace function private.next_restaurant_opening(
  p_restaurant_id uuid,
  p_after timestamptz default now()
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_start_date date;
  v_date date;
  v_time time;
  v_result timestamptz;
  v_offset integer;
begin
  select r.timezone into v_timezone from public.restaurants r where r.id = p_restaurant_id;
  if v_timezone is null then return null; end if;
  v_start_date := (p_after at time zone v_timezone)::date;

  for v_offset in 0..14 loop
    v_date := v_start_date + v_offset;
    v_time := null;

    if exists (
      select 1 from public.special_hours sh
      where sh.restaurant_id = p_restaurant_id and sh.date = v_date
    ) then
      select min(sh.opens_at) into v_time
      from public.special_hours sh
      where sh.restaurant_id = p_restaurant_id
        and sh.date = v_date and not sh.is_closed;
    else
      select min(bh.opens_at) into v_time
      from public.business_hours bh
      where bh.restaurant_id = p_restaurant_id
        and bh.day_of_week = extract(dow from v_date)::smallint
        and bh.active;
    end if;

    if v_time is not null then
      v_result := (v_date + v_time) at time zone v_timezone;
      if v_result > p_after then return v_result; end if;

      -- The first slot may already have started; try the next slot on the same date.
      if exists (
        select 1 from public.special_hours sh
        where sh.restaurant_id = p_restaurant_id and sh.date = v_date
      ) then
        select min((v_date + sh.opens_at) at time zone v_timezone) into v_result
        from public.special_hours sh
        where sh.restaurant_id = p_restaurant_id and sh.date = v_date
          and not sh.is_closed
          and ((v_date + sh.opens_at) at time zone v_timezone) > p_after;
      else
        select min((v_date + bh.opens_at) at time zone v_timezone) into v_result
        from public.business_hours bh
        where bh.restaurant_id = p_restaurant_id
          and bh.day_of_week = extract(dow from v_date)::smallint
          and bh.active
          and ((v_date + bh.opens_at) at time zone v_timezone) > p_after;
      end if;
      if v_result is not null then return v_result; end if;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function private.set_catalog_actor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new.created_by := v_uid;
      new.updated_by := v_uid;
    end if;
  elsif v_uid is not null then
    new.updated_by := v_uid;
  end if;
  return new;
end;
$$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email, active)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    lower(coalesce(new.email, new.id::text || '@invalid.local')),
    true
  )
  on conflict (id) do update
    set email = excluded.email, updated_at = now();
  if new.email_confirmed_at is not null then
    update public.restaurant_members
    set status = 'active'::public.membership_status, updated_at = now()
    where user_id = new.id and status = 'invited'::public.membership_status;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email, email_confirmed_at on auth.users
for each row execute function private.handle_new_auth_user();

create or replace function private.guard_restaurant_protected_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception using errcode = '42501', message = 'RESTAURANT_CREATED_BY_IMMUTABLE';
  end if;
  if new.status is distinct from old.status
     and coalesce(auth.role(), '') <> 'service_role'
     and not private.is_super_admin_aal2() then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_AAL2_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger restaurants_protected_fields
before update on public.restaurants
for each row execute function private.guard_restaurant_protected_fields();

create or replace function private.guard_order_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'ORDERS_ARE_NOT_DELETABLE';
  end if;
  if coalesce(current_setting('app.order_mutation', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'ORDER_MUTATION_REQUIRES_CONTROLLED_OPERATION';
  end if;
  return new;
end;
$$;

create trigger orders_controlled_mutations
before update or delete on public.orders
for each row execute function private.guard_order_mutation();

create or replace function private.guard_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'APPEND_ONLY_RECORD';
end;
$$;

create trigger order_items_append_only before update or delete on public.order_items
for each row execute function private.guard_append_only();
create trigger order_item_options_append_only before update or delete on public.order_item_options
for each row execute function private.guard_append_only();
create trigger order_events_append_only before update or delete on public.order_events
for each row execute function private.guard_append_only();
create trigger audit_logs_append_only before update or delete on public.audit_logs
for each row execute function private.guard_append_only();

create trigger categories_actor before insert or update on public.categories
for each row execute function private.set_catalog_actor();
create trigger products_actor before insert or update on public.products
for each row execute function private.set_catalog_actor();

do $do$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'restaurants', 'restaurant_members', 'categories', 'products',
    'product_option_groups', 'product_options', 'business_hours', 'special_hours',
    'payment_methods', 'delivery_zones', 'orders'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
      v_table || '_updated_at', v_table
    );
  end loop;
end;
$do$;

revoke all on all functions in schema private from public, anon, authenticated;
