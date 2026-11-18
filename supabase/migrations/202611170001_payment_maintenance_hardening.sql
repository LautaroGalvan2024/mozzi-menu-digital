-- Additive maintenance scheduling. Financial transitions, public response shapes,
-- historical account identity and inventory invariants remain unchanged.
alter table private.online_payment_attempts
  add column next_reconcile_at timestamptz not null default now(),
  add column reconciliation_failures integer not null default 0 check (reconciliation_failures between 0 and 16),
  add column expiration_retry_at timestamptz not null default '-infinity',
  add column expiration_failures integer not null default 0 check (expiration_failures between 0 and 16),
  add column last_expiration_error text;

create index online_payment_receipts_attempt_idx
  on private.online_payment_receipts(attempt_id,provider_updated_at,provider_payment_id) include(status);
create index online_payment_attempts_reconciliation_due_idx
  on private.online_payment_attempts(next_reconcile_at,created_at,id);
create index online_payment_attempts_expiration_due_idx
  on private.online_payment_attempts(expires_at,id)
  where reservation_state in ('held','released');
create index online_payment_status_tokens_expiry_idx
  on private.online_payment_status_tokens(expires_at,order_id,token_hash);

create function private.online_reconciliation_delay(
  p_payment_status text,p_order_status public.order_status,p_expires_at timestamptz,
  p_created_at timestamptz,p_failures integer,p_now timestamptz
) returns interval language sql immutable set search_path='' as $$
  select case
    when p_failures>0 then make_interval(secs=>least(1800,60*power(2,least(p_failures-1,5)))::double precision)
    when p_payment_status in ('requires_refund','partially_refunded') then interval '15 minutes'
    when p_payment_status in ('unpaid','pending','rejected','cancelled')
      and p_expires_at>p_now and p_order_status in ('generated','whatsapp_opened') then interval '5 minutes'
    when p_payment_status in ('unpaid','pending','rejected','cancelled')
      and p_created_at>p_now-interval '1 day' then interval '15 minutes'
    when p_payment_status='approved' and p_created_at>p_now-interval '7 days' then interval '1 hour'
    else interval '1 day'
  end
$$;

-- Both verified webhooks and legacy mark_online_reconciled calls already write
-- last_reconciled_at. Schedule their next check without changing those callers.
create function private.schedule_online_reconciliation() returns trigger
language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype;
begin
  select * into strict o from public.orders where id=new.order_id;
  new.next_reconcile_at:=coalesce(new.last_reconciled_at,now())+
    private.online_reconciliation_delay(o.payment_status,o.status,new.expires_at,new.created_at,new.reconciliation_failures,now());
  return new;
end $$;
create trigger online_payment_reconciliation_schedule
before update of last_reconciled_at on private.online_payment_attempts
for each row execute function private.schedule_online_reconciliation();

-- Spread existing historical work instead of creating an immediate backfill
-- storm. Never-checked attempts remain due now. No financial data is changed.
update private.online_payment_attempts a set next_reconcile_at=
  now()+private.online_reconciliation_delay(o.payment_status,o.status,a.expires_at,a.created_at,0,now())
    *((abs(hashtextextended(a.id::text,0)%1000)+1)::double precision/1000)
from public.orders o where o.id=a.order_id and a.last_reconciled_at is not null;

create or replace function public.list_online_reconciliation(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'LIMIT_INVALID'; end if;
  -- Due time provides aging/fairness: historical work is slower, never removed.
  -- Include refunded/charged-back/cancelled attempts for later provider changes.
  return coalesce((select jsonb_agg(x.payload order by x.next_reconcile_at,x.created_at,x.id)
    from (select public.get_online_payment_attempt(a.id) payload,a.next_reconcile_at,a.created_at,a.id
      from private.online_payment_attempts a where a.next_reconcile_at<=now()
      order by a.next_reconcile_at,a.created_at,a.id limit p_limit)x),'[]'::jsonb);
end $$;

create function public.finish_online_reconciliation(p_attempt_id uuid,p_succeeded boolean)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if p_succeeded is null then raise exception 'RECONCILIATION_RESULT_REQUIRED'; end if;
  update private.online_payment_attempts set
    reconciliation_failures=case when p_succeeded then 0 else least(reconciliation_failures+1,16) end,
    last_reconciled_at=now()
  where id=p_attempt_id;
end $$;
create or replace function public.mark_online_reconciled(p_attempt_id uuid)
returns void language sql volatile security definer set search_path='' as $$
  select public.finish_online_reconciliation(p_attempt_id,true)
$$;

create function public.expire_online_reservations_report(p_before timestamptz default now(),p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare candidate record; a private.online_payment_attempts%rowtype; o public.orders%rowtype;
  cutover uuid; cutoff timestamptz:=least(coalesce(p_before,now()),now());
  expired integer:=0; blocked integer:=0; locked integer:=0; failed integer:=0; scanned integer:=0;
  purged integer:=0; failure_code text; previous_lock_timeout text:=current_setting('lock_timeout');
begin
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'LIMIT_INVALID'; end if;
  if not isfinite(cutoff) then raise exception 'CUTOFF_INVALID'; end if;
  -- Also bound waits inside inventory_apply (balance/revision locks).
  perform set_config('lock_timeout','100ms',true);
  -- A capped diagnostic; blocked tenants are excluded BEFORE the work limit so
  -- an arbitrarily large recount does not starve other merchants.
  select count(*) into blocked from (
    select attempts.id from private.online_payment_attempts attempts
      join public.orders orders on orders.id=attempts.order_id join public.restaurants r on r.id=attempts.restaurant_id
    where attempts.expires_at<=cutoff and attempts.reservation_state in ('held','released')
      and orders.status in ('generated','whatsapp_opened')
      and orders.payment_status not in ('approved','partially_refunded','requires_refund')
      and r.inventory_cutover_id is not null limit p_limit
  ) blocked_attempts;
  for candidate in
    select attempts.id,attempts.restaurant_id,attempts.order_id from private.online_payment_attempts attempts
      join public.orders orders on orders.id=attempts.order_id join public.restaurants r on r.id=attempts.restaurant_id
    where attempts.expires_at<=cutoff and attempts.reservation_state in ('held','released') and attempts.expiration_retry_at<=now()
      and orders.status in ('generated','whatsapp_opened')
      and orders.payment_status not in ('approved','partially_refunded','requires_refund')
      and r.inventory_cutover_id is null
    order by attempts.expires_at,attempts.id limit least(p_limit*10,5000)
  loop
    exit when expired>=p_limit;
    scanned:=scanned+1;
    begin
      -- Same order as checkout/reconciliation. NOWAIT keeps maintenance from
      -- holding up requests; the subtransaction releases locks on a skipped row.
      select r.inventory_cutover_id into cutover from public.restaurants r where r.id=candidate.restaurant_id for share nowait;
      if cutover is not null then raise exception using errcode='22023',message='INVENTORY_CUTOVER'; end if;
      select * into strict o from public.orders where id=candidate.order_id for update nowait;
      select * into strict a from private.online_payment_attempts where id=candidate.id for update nowait;
      if a.expires_at>cutoff or a.reservation_state not in ('held','released')
        or o.status not in ('generated','whatsapp_opened')
        or o.payment_status in ('approved','partially_refunded','requires_refund') then continue; end if;
      perform private.online_stock_operation(a.id,'payment_release');
      perform set_config('app.order_mutation','on',true);
      update public.orders set status='expired' where id=o.id;
      update private.online_payment_attempts set expiration_failures=0,expiration_retry_at='-infinity',last_expiration_error=null where id=a.id;
      insert into public.order_events(restaurant_id,order_id,event_type,from_status,to_status,actor_type)
        values(o.restaurant_id,o.id,'online_reservation_expired',o.status,'expired','system');
      expired:=expired+1;
    exception when lock_not_available then locked:=locked+1;
    when others then
      if sqlstate='22023' and sqlerrm='INVENTORY_CUTOVER' then blocked:=blocked+1;
      else
        failed:=failed+1;
        failure_code:=sqlstate;
        -- Quarantine a broken candidate briefly, preserving all financial data.
        -- Do not wait on a competing writer even while recording the failure.
        begin
          perform 1 from private.online_payment_attempts where id=candidate.id for update nowait;
          update private.online_payment_attempts set expiration_failures=least(expiration_failures+1,16),
            expiration_retry_at=now()+interval '5 minutes',last_expiration_error=failure_code where id=candidate.id;
        exception when lock_not_available then null;
        end;
      end if;
    end;
  end loop;
  -- Bound auxiliary cleanup too; money, ledger and historical attempts are retained.
  with stale as (select order_id,token_hash from private.online_payment_status_tokens
      where expires_at<=now() order by expires_at limit p_limit*10 for update skip locked)
  delete from private.online_payment_status_tokens t using stale s where t.order_id=s.order_id and t.token_hash=s.token_hash;
  get diagnostics purged=row_count;
  perform set_config('lock_timeout',previous_lock_timeout,true);
  return jsonb_build_object('expired',expired,'blocked',blocked,'blockedCountCapped',blocked>=p_limit,
    'locked',locked,'failed',failed,'scanned',scanned,'purgedTokens',purged);
end $$;

-- Preserve the original signature, integer result and service-only capability.
create or replace function public.expire_online_reservations(p_before timestamptz default now(),p_limit integer default 100)
returns integer language sql volatile security definer set search_path='' as $$
  select (public.expire_online_reservations_report(p_before,p_limit)->>'expired')::integer
$$;

revoke all on function private.online_reconciliation_delay(text,public.order_status,timestamptz,timestamptz,integer,timestamptz),
  private.schedule_online_reconciliation() from public,anon,authenticated,service_role;
revoke all on function public.expire_online_reservations_report(timestamptz,integer),
  public.finish_online_reconciliation(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.expire_online_reservations_report(timestamptz,integer),
  public.finish_online_reconciliation(uuid,boolean) to service_role;
