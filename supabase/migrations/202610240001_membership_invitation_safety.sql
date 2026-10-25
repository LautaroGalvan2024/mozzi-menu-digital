-- S01: invitations must respect the previous role and the final active admin.
-- Both membership RPCs use the same lock order: profiles (UUID), actor platform
-- role, restaurant, memberships (UUID). The restaurant lock also serializes
-- inserts, for which a lock on existing memberships alone would leave a gap.
-- Upsert is a service-only entry point; the Edge handler authenticates the actor
-- and requires AAL2 for a super admin before supplying p_actor_id.
create or replace function public.upsert_restaurant_membership(
  p_restaurant_id uuid,
  p_user_id uuid,
  p_role public.restaurant_role,
  p_status public.membership_status,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_super boolean;
  v_member public.restaurant_members%rowtype;
  v_before jsonb;
  v_active_admins integer;
begin
  if p_role is null or p_status is null then
    raise exception using errcode = '22023', message = 'MEMBERSHIP_INPUT_INVALID';
  end if;

  -- Reject unauthorized actors before taking tenant locks. Authorization is
  -- repeated after the locks; this first check is not the mutation boundary.
  select exists (
    select 1 from public.platform_user_roles pur
    join public.profiles p on p.id = pur.user_id and p.active
    where pur.user_id = p_actor_id and pur.role = 'super_admin'
  ) into v_actor_super;
  if not v_actor_super and not exists (
    select 1 from public.restaurant_members rm
    join public.profiles p on p.id = rm.user_id and p.active
    where rm.restaurant_id = p_restaurant_id and rm.user_id = p_actor_id
      and rm.role = 'restaurant_admin' and rm.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_MANAGEMENT_FORBIDDEN';
  end if;

  -- Auth profile updates take the profile before updating invited memberships.
  -- Acquire these shared locks first, and keep actor deactivation / super-role
  -- revocation from invalidating a successful authorization before commit.
  perform p.id from public.profiles p
  where p.id in (p_actor_id, p_user_id)
  order by p.id for share;
  perform pur.user_id from public.platform_user_roles pur
  where pur.user_id = p_actor_id and pur.role = 'super_admin'
  for share;
  perform r.id from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'RESTAURANT_NOT_FOUND';
  end if;
  perform rm.id from public.restaurant_members rm
  where rm.restaurant_id = p_restaurant_id
  order by rm.id for update;

  select exists (
    select 1 from public.platform_user_roles pur
    join public.profiles p on p.id = pur.user_id and p.active
    where pur.user_id = p_actor_id and pur.role = 'super_admin'
  ) into v_actor_super;
  if not v_actor_super and not exists (
    select 1 from public.restaurant_members rm
    join public.profiles p on p.id = rm.user_id and p.active
    where rm.restaurant_id = p_restaurant_id and rm.user_id = p_actor_id
      and rm.role = 'restaurant_admin' and rm.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_MANAGEMENT_FORBIDDEN';
  end if;
  if not v_actor_super and p_role <> 'order_manager' then
    raise exception using errcode = '42501', message = 'ROLE_ASSIGNMENT_FORBIDDEN';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.active) then
    raise exception using errcode = '22023', message = 'TARGET_USER_INVALID';
  end if;

  select rm.* into v_member from public.restaurant_members rm
  where rm.restaurant_id = p_restaurant_id and rm.user_id = p_user_id;

  if found then
    -- A tenant admin cannot use an invitation to demote themselves or another
    -- administrator, regardless of the requested new role or current status.
    if not v_actor_super and v_member.role <> 'order_manager' then
      raise exception using errcode = '42501', message = 'ROLE_ASSIGNMENT_FORBIDDEN';
    end if;
    if v_member.role = p_role and v_member.status = p_status then
      return jsonb_build_object(
        'id', v_member.id, 'restaurantId', v_member.restaurant_id,
        'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status,
        'changed', false
      );
    end if;
    if v_member.role = 'restaurant_admin' and v_member.status = 'active'
       and (p_role <> 'restaurant_admin' or p_status <> 'active') then
      select count(*)::integer into v_active_admins
      from public.restaurant_members rm
      where rm.restaurant_id = p_restaurant_id
        and rm.role = 'restaurant_admin' and rm.status = 'active';
      if v_active_admins <= 1 then
        raise exception using errcode = '22023', message = 'LAST_RESTAURANT_ADMIN_REQUIRED';
      end if;
    end if;
    v_before := jsonb_build_object(
      'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status
    );
    update public.restaurant_members rm
    set role = p_role, status = p_status, invited_by = p_actor_id, updated_at = now()
    where rm.id = v_member.id
    returning rm.* into v_member;
  else
    -- No pre-existing admin is required: privileged initial provisioning remains
    -- possible, as does a tenant admin inviting a new order manager.
    insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by)
    values (p_restaurant_id, p_user_id, p_role, p_status, p_actor_id)
    returning * into v_member;
  end if;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    p_restaurant_id, p_actor_id,
    case when p_status = 'suspended' then 'suspend'::public.audit_action else 'invite'::public.audit_action end,
    'restaurant_member', v_member.id, v_before,
    jsonb_build_object('userId', p_user_id, 'role', p_role, 'status', p_status),
    jsonb_build_object('source', 'upsert_restaurant_membership')
  );
  return jsonb_build_object(
    'id', v_member.id, 'restaurantId', v_member.restaurant_id,
    'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status,
    'changed', true
  );
end;
$$;

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
  if p_status is null or p_status not in ('active'::public.membership_status, 'suspended'::public.membership_status) then
    raise exception using errcode = '22023', message = 'MEMBERSHIP_STATUS_INVALID';
  end if;
  select rm.* into v_member from public.restaurant_members rm where rm.id = p_membership_id;
  if not found then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;
  v_is_super := private.is_super_admin();
  if v_is_super then
    if private.current_aal() <> 'aal2' then
      raise exception using errcode = '42501', message = 'SUPER_ADMIN_AAL2_REQUIRED';
    end if;
  elsif v_member.role <> 'order_manager'::public.restaurant_role
        or not private.has_restaurant_role(v_member.restaurant_id, array['restaurant_admin']::public.restaurant_role[]) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  perform p.id from public.profiles p
  where p.id in (v_uid, v_member.user_id)
  order by p.id for share;
  perform pur.user_id from public.platform_user_roles pur
  where pur.user_id = v_uid and pur.role = 'super_admin'
  for share;
  perform r.id from public.restaurants r where r.id = v_member.restaurant_id for update;
  perform rm.id from public.restaurant_members rm
  where rm.restaurant_id = v_member.restaurant_id
  order by rm.id for update;
  select rm.* into v_member from public.restaurant_members rm where rm.id = p_membership_id;
  if not found then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  -- Revalidate every actor, including super admins whose profile / role may
  -- have changed while waiting. Membership locks protect tenant authorization.
  v_is_super := private.is_super_admin();
  if v_is_super then
    if private.current_aal() <> 'aal2' then
      raise exception using errcode = '42501', message = 'SUPER_ADMIN_AAL2_REQUIRED';
    end if;
  elsif v_member.role <> 'order_manager'::public.restaurant_role
        or not private.has_restaurant_role(v_member.restaurant_id, array['restaurant_admin']::public.restaurant_role[]) then
    raise exception using errcode = '42501', message = 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN';
  end if;

  if v_member.status = p_status then
    return jsonb_build_object(
      'id', v_member.id, 'restaurantId', v_member.restaurant_id,
      'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status,
      'changed', false
    );
  end if;
  if p_status = 'suspended' and v_member.role = 'restaurant_admin' and v_member.status = 'active' then
    select count(*)::integer into v_active_admins
    from public.restaurant_members rm
    where rm.restaurant_id = v_member.restaurant_id
      and rm.role = 'restaurant_admin' and rm.status = 'active';
    if v_active_admins <= 1 then
      raise exception using errcode = '22023', message = 'LAST_RESTAURANT_ADMIN_REQUIRED';
    end if;
  end if;
  v_before_status := v_member.status;
  update public.restaurant_members rm
  set status = p_status, updated_at = now()
  where rm.id = v_member.id returning rm.* into v_member;
  insert into public.audit_logs (
    restaurant_id, actor_user_id, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    v_member.restaurant_id, v_uid,
    case p_status when 'active'::public.membership_status then 'activate'::public.audit_action else 'suspend'::public.audit_action end,
    'restaurant_member', v_member.id,
    jsonb_build_object('userId', v_member.user_id, 'role', v_member.role, 'status', v_before_status),
    jsonb_build_object('userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status),
    jsonb_build_object('source', 'set_restaurant_member_status')
  );
  return jsonb_build_object(
    'id', v_member.id, 'restaurantId', v_member.restaurant_id,
    'userId', v_member.user_id, 'role', v_member.role, 'status', v_member.status,
    'changed', true
  );
end;
$$;

comment on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) is
  'Service-only invitation/provisioning. Checks prior role and final active admin under locks; identical membership is a no-op. Edge enforces actor Auth and super-admin AAL2.';
comment on function public.set_restaurant_member_status(uuid, public.membership_status) is
  'Changes active/suspended memberships under the shared invitation lock order. Tenant admins manage only own order managers; super admins require AAL2; preserves final active admin.';

revoke all on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) from public, anon, authenticated, service_role;
grant execute on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) to service_role;
revoke all on function public.set_restaurant_member_status(uuid, public.membership_status) from public, anon, authenticated, service_role;
grant execute on function public.set_restaurant_member_status(uuid, public.membership_status) to authenticated;
