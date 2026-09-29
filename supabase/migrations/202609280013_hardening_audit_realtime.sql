create or replace function private.validate_restaurant_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone) then
    raise exception using errcode = '22023', message = 'TIMEZONE_INVALID';
  end if;
  return new;
end;
$$;

create trigger restaurants_validate_timezone
before insert or update of timezone on public.restaurants
for each row execute function private.validate_restaurant_timezone();

create or replace function private.guard_identity_and_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if v_old ->> 'id' is distinct from v_new ->> 'id' then
    raise exception using errcode = '42501', message = 'PRIMARY_ID_IMMUTABLE';
  end if;
  if v_old ? 'restaurant_id'
     and v_old ->> 'restaurant_id' is distinct from v_new ->> 'restaurant_id' then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;
  if v_old ? 'created_at'
     and v_old ->> 'created_at' is distinct from v_new ->> 'created_at' then
    raise exception using errcode = '42501', message = 'CREATED_AT_IMMUTABLE';
  end if;
  if v_old ? 'created_by'
     and v_old ->> 'created_by' is distinct from v_new ->> 'created_by' then
    raise exception using errcode = '42501', message = 'CREATED_BY_IMMUTABLE';
  end if;
  return new;
end;
$$;

do $do$
declare v_table text;
begin
  foreach v_table in array array[
    'restaurant_members', 'categories', 'products', 'product_option_groups',
    'product_options', 'business_hours', 'special_hours', 'payment_methods',
    'delivery_zones', 'image_assets'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.guard_identity_and_tenant()',
      v_table || '_immutable_identity', v_table
    );
  end loop;
end;
$do$;

create or replace function private.audit_restaurant_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_action public.audit_action := 'update';
begin
  if new.status is distinct from old.status then
    v_action := case new.status
      when 'active' then 'activate'::public.audit_action
      when 'suspended' then 'suspend'::public.audit_action
      else 'update'::public.audit_action end;
  end if;
  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data
  ) values (
    new.id, auth.uid(), v_action, 'restaurant', new.id,
    jsonb_build_object(
      'status', old.status, 'slug', old.slug, 'publicMenuEnabled', old.public_menu_enabled,
      'deliveryEnabled', old.delivery_enabled, 'pickupEnabled', old.pickup_enabled
    ),
    jsonb_build_object(
      'status', new.status, 'slug', new.slug, 'publicMenuEnabled', new.public_menu_enabled,
      'deliveryEnabled', new.delivery_enabled, 'pickupEnabled', new.pickup_enabled
    )
  );
  return new;
end;
$$;

create trigger restaurants_audit_change
after update on public.restaurants
for each row execute function private.audit_restaurant_change();

create or replace function private.audit_payment_method_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data
  ) values (
    new.restaurant_id, auth.uid(), case when tg_op = 'INSERT' then 'create'::public.audit_action else 'update'::public.audit_action end,
    'payment_method', new.id,
    case when tg_op = 'UPDATE' then jsonb_build_object(
      'code', old.code, 'name', old.name, 'active', old.active,
      'adjustmentType', old.adjustment_type, 'adjustmentScope', old.adjustment_scope,
      'adjustmentBps', old.adjustment_bps, 'adjustmentFixedCents', old.adjustment_fixed_cents::text
    ) else null end,
    jsonb_build_object(
      'code', new.code, 'name', new.name, 'active', new.active,
      'adjustmentType', new.adjustment_type, 'adjustmentScope', new.adjustment_scope,
      'adjustmentBps', new.adjustment_bps, 'adjustmentFixedCents', new.adjustment_fixed_cents::text
    )
  );
  return new;
end;
$$;

create trigger payment_methods_audit_change
after insert or update on public.payment_methods
for each row execute function private.audit_payment_method_change();

alter table public.orders replica identity full;
alter table public.order_events replica identity full;

do $do$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_events'
  ) then
    execute 'alter publication supabase_realtime add table public.order_events';
  end if;
end;
$do$;

revoke all on function private.validate_restaurant_timezone() from public, anon, authenticated;
revoke all on function private.guard_identity_and_tenant() from public, anon, authenticated;
revoke all on function private.audit_restaurant_change() from public, anon, authenticated;
revoke all on function private.audit_payment_method_change() from public, anon, authenticated;
