-- A disabled tenant administrator may still inspect their own identity record,
-- but must not retain visibility over other users in a shared restaurant.
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
      join public.profiles actor
        on actor.id = mine.user_id
       and actor.active
      join public.restaurant_members theirs
        on theirs.restaurant_id = mine.restaurant_id
       and theirs.user_id = p_profile_id
      where mine.user_id = (select auth.uid())
        and mine.status = 'active'::public.membership_status
        and mine.role = 'restaurant_admin'::public.restaurant_role
    )
$$;

-- Edge Functions use this projection before acquiring any administrative
-- capability. Fail closed here so a disabled profile cannot retain an active
-- membership in the authorization snapshot or trigger pre-RPC side effects.
create or replace function public.get_actor_authorization()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.active
  ) then
    raise exception using errcode = '42501', message = 'ACCOUNT_DISABLED';
  end if;

  return jsonb_build_object(
    'userId', v_uid,
    'isSuperAdmin', private.is_super_admin(),
    'aal', private.current_aal(),
    'memberships', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'restaurantId', rm.restaurant_id,
          'role', rm.role,
          'status', rm.status
        ) order by rm.created_at, rm.id
      )
      from public.restaurant_members rm
      where rm.user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$$;

