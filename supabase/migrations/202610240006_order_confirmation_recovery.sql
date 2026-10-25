-- Temporary bearer recovery is deliberately separate from WhatsApp telemetry.
-- Only hashes are persisted; a public order/action UUID is never sufficient.
create table private.order_confirmation_recovery_tokens (
  order_id uuid not null references public.orders(id) on delete cascade,
  token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(order_id,token_hash),
  check(expires_at>created_at and expires_at<=created_at+interval '30 minutes')
);
create table private.order_recovery_rate_limits (
  key_hash text not null check(key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  request_count integer not null check(request_count>0),
  primary key(key_hash,window_start)
);
revoke all on private.order_confirmation_recovery_tokens,private.order_recovery_rate_limits
  from public,anon,authenticated,service_role;

alter function public.create_order_transaction(jsonb,text,text,text) rename to create_order_transaction_with_request_hash;
alter function public.create_order_transaction_with_request_hash(jsonb,text,text,text) set schema private;
revoke all on function private.create_order_transaction_with_request_hash(jsonb,text,text,text)
  from public,anon,authenticated,service_role;

create function public.create_order_transaction(p_request jsonb,p_ip_hash text,p_phone_hash text,p_client_event_token_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_order uuid; v_hash text; v_requested_expiry timestamptz;
  v_created timestamptz; v_expires timestamptz; v_existing timestamptz;
begin
  -- Existing clients remain compatible. New clients must supply the complete pair.
  if p_request ? 'recoveryTokenHash' or p_request ? 'recoveryExpiresAt' then
    v_hash:=p_request->>'recoveryTokenHash';
    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_request->'recoveryTokenHash') is distinct from 'string'
      or jsonb_typeof(p_request->'recoveryExpiresAt') is distinct from 'string' then
      raise exception using errcode='22023',message='RECOVERY_TOKEN_INVALID';
    end if;
    begin v_requested_expiry:=(p_request->>'recoveryExpiresAt')::timestamptz;
    exception when others then raise exception using errcode='22023',message='RECOVERY_TOKEN_INVALID'; end;
    if not isfinite(v_requested_expiry) or v_requested_expiry<=clock_timestamp() then
      raise exception using errcode='22023',message='RECOVERY_TOKEN_INVALID';
    end if;
  end if;
  -- Recovery transport fields are excluded from the existing immutable intent hash.
  v_result:=private.create_order_transaction_with_request_hash(
    p_request-'recoveryTokenHash'-'recoveryExpiresAt',p_ip_hash,p_phone_hash,p_client_event_token_hash);
  if v_hash is null then return v_result; end if;
  select id into strict v_order from public.orders where action_id=(v_result#>>'{order,actionId}')::uuid for update;
  v_created:=clock_timestamp();
  v_expires:=least(v_requested_expiry,v_created+interval '30 minutes');
  if v_expires<=v_created then raise exception using errcode='22023',message='RECOVERY_TOKEN_INVALID'; end if;
  -- A retry with another random token adds a capability without invalidating a
  -- response still in flight. Reuse of the same hash never extends its expiry.
  insert into private.order_confirmation_recovery_tokens(order_id,token_hash,expires_at,created_at)
  values(v_order,v_hash,v_expires,v_created) on conflict(order_id,token_hash) do nothing;
  select expires_at into v_existing from private.order_confirmation_recovery_tokens
    where order_id=v_order and token_hash=v_hash;
  if v_existing<=clock_timestamp() then raise exception using errcode='22023',message='RECOVERY_TOKEN_INVALID'; end if;
  delete from private.order_confirmation_recovery_tokens where order_id=v_order and expires_at<=clock_timestamp();
  return v_result||jsonb_build_object('recoveryTokenStored',true,'recoveryExpiresAt',v_existing);
end;
$$;

create function public.recover_order_confirmation(p_action_id uuid,p_recovery_token_hash text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_order uuid; v_expires timestamptz;
begin
  if p_action_id is null or p_recovery_token_hash is null or p_recovery_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  select o.id,t.expires_at into v_order,v_expires
  from public.orders o join private.order_confirmation_recovery_tokens t on t.order_id=o.id
  where o.action_id=p_action_id and t.token_hash=p_recovery_token_hash and t.expires_at>clock_timestamp();
  if not found then return null; end if;
  -- No order, event, inventory or token mutation occurs in this lookup.
  return private.create_order_response(v_order,true)||jsonb_build_object(
    'clientEventTokenStored',false,'clientEventExpiresAt',v_expires,
    'recoveryTokenStored',true,'recoveryExpiresAt',v_expires);
end;
$$;

-- Called by Edge in a separate transaction so unsuccessful lookups also consume
-- the quota. Hash is an HMAC of the client IP in a recovery-specific namespace.
create function public.check_order_recovery_rate_limit(p_ip_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_window timestamptz; v_count integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='HASH_ARGUMENT_INVALID';
  end if;
  v_window:=to_timestamp(floor(extract(epoch from clock_timestamp())/60)*60);
  insert into private.order_recovery_rate_limits(key_hash,window_start,request_count)
  values(p_ip_hash,v_window,1) on conflict(key_hash,window_start) do update
    set request_count=private.order_recovery_rate_limits.request_count+1
    returning request_count into v_count;
  delete from private.order_recovery_rate_limits where key_hash=p_ip_hash and window_start<v_window-interval '1 day';
  return jsonb_build_object('allowed',v_count<=30,'code',case when v_count>30 then 'RATE_LIMITED' else null end);
end;
$$;
revoke all on function public.create_order_transaction(jsonb,text,text,text),
  public.recover_order_confirmation(uuid,text),public.check_order_recovery_rate_limit(text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_order_transaction(jsonb,text,text,text),
  public.recover_order_confirmation(uuid,text),public.check_order_recovery_rate_limit(text) to service_role;
