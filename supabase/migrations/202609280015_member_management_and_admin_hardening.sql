-- Authenticated member status management and final admin-surface hardening.

-- Keep option-group selection limits aligned across direct edits and batch imports.
alter table public.product_option_groups
  drop constraint if exists product_option_groups_max_select_check;
alter table public.product_option_groups
  add constraint product_option_groups_max_select_check
  check (max_select between 0 and 20);

create or replace function private.enforce_option_group_selection_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.max_select > 20 then
    raise exception using
      errcode = '22023',
      message = 'OPTION_GROUP_MAX_SELECT_EXCEEDED';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_option_group_selection_limit() from public, anon, authenticated;

create trigger product_option_groups_selection_limit
before insert or update of max_select on public.product_option_groups
for each row execute function private.enforce_option_group_selection_limit();

create or replace function public.set_restaurant_member_status(
  p_membership_id uuid,
  p_status public.membership_status
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_is_super boolean;
  v_member public.restaurant_members%rowtype;
  v_before_status public.membership_status;
  v_active_admins integer;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_status not in ('active'::public.membership_status, 'suspended'::public.membership_status) then
    raise exception using errcode = '22023', message = 'MEMBERSHIP_STATUS_INVALID';
  end if;

  select rm.* into v_member
  from public.restaurant_members rm
  where rm.id = p_membership_id;

  if not found then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  v_is_super := private.is_super_admin();
  if v_is_super then
    if private.current_aal() <> 'aal2' then
      raise exception using errcode = '42501', message = 'SUPER_ADMIN_AAL2_REQUIRED';
    end if;
  elsif v_member.role <> 'order_manager'::public.restaurant_role
        or not private.has_restaurant_role(
          v_member.restaurant_id,
          array['restaurant_admin']::public.restaurant_role[]
        ) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  -- Serialize membership changes for this tenant so two concurrent requests cannot
  -- suspend its final active administrator independently.
  perform rm.id
  from public.restaurant_members rm
  where rm.restaurant_id = v_member.restaurant_id
  order by rm.id
  for update;

  select rm.* into v_member
  from public.restaurant_members rm
  where rm.id = p_membership_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  -- Re-check the non-super-admin boundary after acquiring locks in case the target
  -- role changed while this request was waiting.
  if not v_is_super
     and (
       v_member.role <> 'order_manager'::public.restaurant_role
       or not private.has_restaurant_role(
         v_member.restaurant_id,
         array['restaurant_admin']::public.restaurant_role[]
       )
     ) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  if v_member.status = p_status then
    return jsonb_build_object(
      'id', v_member.id,
      'restaurantId', v_member.restaurant_id,
      'userId', v_member.user_id,
      'role', v_member.role,
      'status', v_member.status,
      'changed', false
    );
  end if;

  if p_status = 'suspended'::public.membership_status
     and v_member.role = 'restaurant_admin'::public.restaurant_role
     and v_member.status = 'active'::public.membership_status then
    select count(*)::integer into v_active_admins
    from public.restaurant_members rm
    where rm.restaurant_id = v_member.restaurant_id
      and rm.role = 'restaurant_admin'::public.restaurant_role
      and rm.status = 'active'::public.membership_status;

    if v_active_admins <= 1 then
      raise exception using errcode = '22023', message = 'LAST_RESTAURANT_ADMIN_REQUIRED';
    end if;
  end if;

  v_before_status := v_member.status;
  update public.restaurant_members rm
  set status = p_status,
      updated_at = now()
  where rm.id = v_member.id
  returning rm.* into v_member;

  insert into public.audit_logs (
    restaurant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    metadata
  ) values (
    v_member.restaurant_id,
    v_uid,
    case p_status
      when 'active'::public.membership_status then 'activate'::public.audit_action
      else 'suspend'::public.audit_action
    end,
    'restaurant_member',
    v_member.id,
    jsonb_build_object(
      'userId', v_member.user_id,
      'role', v_member.role,
      'status', v_before_status
    ),
    jsonb_build_object(
      'userId', v_member.user_id,
      'role', v_member.role,
      'status', v_member.status
    ),
    jsonb_build_object('source', 'set_restaurant_member_status')
  );

  return jsonb_build_object(
    'id', v_member.id,
    'restaurantId', v_member.restaurant_id,
    'userId', v_member.user_id,
    'role', v_member.role,
    'status', v_member.status,
    'changed', true
  );
end;
$$;

comment on function public.set_restaurant_member_status(uuid, public.membership_status) is
  'Changes an existing membership between active and suspended. Tenant admins may manage only their own order managers; super admins require AAL2.';

revoke all on function public.set_restaurant_member_status(uuid, public.membership_status) from public, anon;
grant execute on function public.set_restaurant_member_status(uuid, public.membership_status) to authenticated;

-- Hours are replaceable tenant configuration. Deletion remains tenant-scoped and
-- is intentionally not extended to catalogue or historical order resources.
create policy business_hours_delete_admin on public.business_hours
for delete to authenticated
using (private.can_manage_restaurant(restaurant_id));

create policy special_hours_delete_admin on public.special_hours
for delete to authenticated
using (private.can_manage_restaurant(restaurant_id));

grant delete on public.business_hours, public.special_hours to authenticated;
