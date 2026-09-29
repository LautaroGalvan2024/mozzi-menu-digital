-- Protect platform-controlled restaurant identity/lifecycle fields independently
-- from row-level tenant authorization. RLS answers which row may be updated;
-- this trigger and the column grants answer which fields may be updated.

create or replace function private.guard_restaurant_protected_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service_role boolean := coalesce(auth.role(), '') = 'service_role';
begin
  -- These provenance/identity fields are never client-editable, including for
  -- super admins and service-role maintenance paths.
  if new.id is distinct from old.id then
    raise exception using errcode = '42501', message = 'RESTAURANT_ID_IMMUTABLE';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception using errcode = '42501', message = 'RESTAURANT_CREATED_BY_IMMUTABLE';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'RESTAURANT_CREATED_AT_IMMUTABLE';
  end if;
  if new.updated_at is distinct from old.updated_at then
    raise exception using errcode = '42501', message = 'RESTAURANT_UPDATED_AT_MANAGED';
  end if;

  -- Tenant admins may edit brand and operational configuration, but changing a
  -- public tenant identity, order-number namespace, or platform lifecycle state
  -- requires the platform role with MFA. Trusted Edge maintenance keeps its
  -- existing service-role path.
  if (
       new.status is distinct from old.status
       or new.slug is distinct from old.slug
       or new.order_prefix is distinct from old.order_prefix
     )
     and not v_service_role
     and not private.is_super_admin_aal2() then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_AAL2_REQUIRED';
  end if;

  return new;
end;
$$;

comment on function private.guard_restaurant_protected_fields() is
  'Separates tenant-operational restaurant updates from immutable and AAL2 platform-controlled fields.';

revoke all on function private.guard_restaurant_protected_fields() from public, anon, authenticated;

-- Remove the broad table-level UPDATE grant. PostgREST still supports legitimate
-- PATCH requests through these explicit columns; immutable fields are omitted.
revoke update on table public.restaurants from authenticated;
grant update (
  name,
  trade_name,
  slug,
  description,
  status,
  whatsapp_phone_e164,
  address,
  city,
  timezone,
  currency_code,
  locale,
  logo_path,
  cover_path,
  primary_color,
  secondary_color,
  delivery_enabled,
  pickup_enabled,
  minimum_order_cents,
  default_preparation_minutes,
  order_prefix,
  public_menu_enabled
) on public.restaurants to authenticated;

-- Preserve the protected values in the immutable audit record as well as the
-- operational publication flags already recorded by the earlier trigger.
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
      'status', old.status,
      'slug', old.slug,
      'orderPrefix', old.order_prefix,
      'publicMenuEnabled', old.public_menu_enabled,
      'deliveryEnabled', old.delivery_enabled,
      'pickupEnabled', old.pickup_enabled
    ),
    jsonb_build_object(
      'status', new.status,
      'slug', new.slug,
      'orderPrefix', new.order_prefix,
      'publicMenuEnabled', new.public_menu_enabled,
      'deliveryEnabled', new.delivery_enabled,
      'pickupEnabled', new.pickup_enabled
    )
  );
  return new;
end;
$$;

revoke all on function private.audit_restaurant_change() from public, anon, authenticated;
