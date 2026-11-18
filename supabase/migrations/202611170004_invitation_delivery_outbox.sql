-- Exact directory lookup and durable invitation delivery. No email is sent by SQL.
-- Membership commits first; the service handler claims and sends afterwards.
create function private.backfill_auth_profiles() returns integer
language plpgsql volatile security definer set search_path='' as $$
declare v_inserted integer;
begin
  if exists (
    select 1 from auth.users u
    group by lower(coalesce(u.email,u.id::text||'@invalid.local')) having count(*)>1
  ) or exists (
    select 1 from auth.users u join public.profiles p
      on lower(p.email)=lower(coalesce(u.email,u.id::text||'@invalid.local'))
    where p.id<>u.id
  ) then
    raise exception using errcode='22023',message='AUTH_DIRECTORY_AMBIGUOUS_REVIEW_REQUIRED';
  end if;
  insert into public.profiles(id,full_name,email,active)
  select u.id,left(coalesce(u.raw_user_meta_data->>'full_name',''),120),
    lower(coalesce(u.email,u.id::text||'@invalid.local')),
    coalesce(u.banned_until<=clock_timestamp(),true)
  from auth.users u where not exists(select 1 from public.profiles p where p.id=u.id)
  on conflict(id) do nothing;
  get diagnostics v_inserted=row_count;
  return v_inserted;
end $$;
revoke all on function private.backfill_auth_profiles() from public,anon,authenticated,service_role;
select private.backfill_auth_profiles();

create function public.find_auth_user_by_email(p_email text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_email text:=lower(btrim(p_email)); v_ids uuid[]; v_id uuid;
begin
  if v_email is null or char_length(v_email) not between 3 and 320 then
    raise exception using errcode='22023',message='AUTH_DIRECTORY_EMAIL_INVALID';
  end if;
  -- Matches profiles_email_lower_uidx. The projection trigger plus migration
  -- backfill removes the need to transfer the Auth directory on each invitation.
  select array_agg(p.id) into v_ids from public.profiles p where lower(p.email)=v_email;
  if coalesce(cardinality(v_ids),0)>1 then
    raise exception using errcode='22023',message='AUTH_DIRECTORY_AMBIGUOUS_REVIEW_REQUIRED';
  end if;
  v_id:=v_ids[1];
  if v_id is not null and not exists(select 1 from auth.users u where u.id=v_id and lower(u.email)=v_email) then
    raise exception using errcode='22023',message='AUTH_DIRECTORY_PROJECTION_MISMATCH';
  end if;
  return v_id;
end $$;

create table private.restaurant_invitation_deliveries (
  membership_id uuid primary key references public.restaurant_members(id) on delete cascade,
  pending boolean not null default true,
  lease_id uuid unique,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((lease_id is null)=(lease_expires_at is null))
);
alter table private.restaurant_invitation_deliveries enable row level security;
revoke all on private.restaurant_invitation_deliveries from public,anon,authenticated,service_role;

create function private.queue_restaurant_invitation() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare v_invited_at timestamptz;
begin
  if new.status='invited' and (tg_op='INSERT' or old.status is distinct from new.status) then
    -- A legacy Edge may have sent Auth mail before committing membership, and
    -- the same identity may already have been invited by another restaurant.
    -- Preserve that delivery; only an explicit resend should send another mail.
    select u.invited_at into v_invited_at from auth.users u where u.id=new.user_id;
    insert into private.restaurant_invitation_deliveries as delivery(membership_id,pending,last_attempt_at,sent_at)
    values(new.id,v_invited_at is null,v_invited_at,v_invited_at)
    on conflict(membership_id) do update set pending=excluded.pending,lease_id=null,lease_expires_at=null,
      last_attempt_at=greatest(delivery.last_attempt_at,excluded.last_attempt_at),
      sent_at=coalesce(delivery.sent_at,excluded.sent_at);
  elsif new.status<>'invited' then
    update private.restaurant_invitation_deliveries
    set pending=false,lease_id=null,lease_expires_at=null where membership_id=new.id;
  end if;
  return new;
end $$;
create trigger restaurant_members_invitation_delivery
after insert or update of status on public.restaurant_members
for each row execute function private.queue_restaurant_invitation();
revoke all on function private.queue_restaurant_invitation() from public,anon,authenticated,service_role;

-- Do not implicitly resend historical invitations. A known Auth invitation is
-- migrated as already attempted; an explicit resend remains available.
insert into private.restaurant_invitation_deliveries(membership_id,pending,last_attempt_at,sent_at)
select rm.id,u.invited_at is null,u.invited_at,u.invited_at
from public.restaurant_members rm join auth.users u on u.id=rm.user_id
where rm.status='invited' and u.email_confirmed_at is null;

create function public.claim_restaurant_invitation(
  p_restaurant_id uuid,p_user_id uuid,p_resend boolean default false,
  p_expected_role public.restaurant_role default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare m public.restaurant_members%rowtype; d private.restaurant_invitation_deliveries%rowtype;
  v_email text; v_confirmed timestamptz; v_now timestamptz; v_lease uuid;
begin
  -- Keep the same profile -> restaurant -> membership order as provisioning.
  -- Auth updates already take auth.users then profiles, so do not lock auth.users
  -- in the reverse order just to read its confirmation/email projection.
  perform p.id from public.profiles p where p.id=p_user_id for share;
  if not found then return null; end if;
  perform r.id from public.restaurants r where r.id=p_restaurant_id for share;
  if not found then return null; end if;
  select * into m from public.restaurant_members
  where restaurant_id=p_restaurant_id and user_id=p_user_id for update;
  if not found or m.status<>'invited'
    or (p_expected_role is not null and m.role<>p_expected_role)
    or not exists(select 1 from public.profiles p where p.id=p_user_id and p.active)
    or not exists(select 1 from public.restaurants r where r.id=p_restaurant_id and r.status<>'suspended') then
    return null;
  end if;
  select u.email,u.email_confirmed_at into v_email,v_confirmed from auth.users u where u.id=p_user_id;
  if not found or v_confirmed is not null or nullif(btrim(v_email),'') is null then return null; end if;
  select * into d from private.restaurant_invitation_deliveries where membership_id=m.id for update;
  if not found then return null; end if;
  v_now:=clock_timestamp();
  if (not d.pending and not coalesce(p_resend,false))
    or d.lease_expires_at>v_now
    or d.last_attempt_at>v_now-interval '60 seconds' then
    return null;
  end if;
  v_lease:=extensions.gen_random_uuid();
  update private.restaurant_invitation_deliveries
  set pending=true,lease_id=v_lease,lease_expires_at=v_now+interval '2 minutes',last_attempt_at=v_now
  where membership_id=m.id;
  return jsonb_build_object('leaseId',v_lease,'email',lower(btrim(v_email)),'userId',p_user_id);
end $$;

create function public.finish_restaurant_invitation(p_lease_id uuid,p_success boolean) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
  if p_lease_id is null or p_success is null then
    raise exception using errcode='22023',message='INVITATION_DELIVERY_INPUT_INVALID';
  end if;
  -- Matching the exact lease fences a delayed handler from completing a newer
  -- attempt or an invitation invalidated by suspension/confirmation.
  update private.restaurant_invitation_deliveries
  set pending=not p_success,sent_at=case when p_success then clock_timestamp() else sent_at end,
    lease_id=null,lease_expires_at=null
  where lease_id=p_lease_id;
  return found;
end $$;

revoke all on function public.find_auth_user_by_email(text),
  public.claim_restaurant_invitation(uuid,uuid,boolean,public.restaurant_role),
  public.finish_restaurant_invitation(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.find_auth_user_by_email(text),
  public.claim_restaurant_invitation(uuid,uuid,boolean,public.restaurant_role),
  public.finish_restaurant_invitation(uuid,boolean) to service_role;
