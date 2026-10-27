-- A merchant may move from sandbox to production without replacing the
-- credentials used by historical purchases. Only service RPCs can access these
-- connections; environment is verified from the encrypted envelope by Edge.
alter table private.payment_accounts add column id uuid not null default extensions.gen_random_uuid();
alter table private.payment_accounts add column live_mode boolean;
alter table private.payment_accounts add column is_current boolean not null default true;
alter table private.payment_accounts drop constraint payment_accounts_pkey;
alter table private.payment_accounts add primary key(id);
alter table private.payment_accounts add constraint payment_accounts_id_restaurant_key unique(id,restaurant_id);
alter table private.payment_accounts drop constraint payment_accounts_provider_user_id_key;
alter table private.payment_accounts add constraint payment_accounts_provider_environment_key unique nulls not distinct(provider_user_id,live_mode);
alter table private.payment_accounts add constraint payment_accounts_active_current check(not active or is_current);
create unique index payment_accounts_one_current on private.payment_accounts(restaurant_id) where is_current;

alter table private.online_payment_attempts add column account_id uuid;
update private.online_payment_attempts a set account_id=c.id from private.payment_accounts c where c.restaurant_id=a.restaurant_id;
alter table private.online_payment_attempts alter column account_id set not null;
alter table private.online_payment_attempts add constraint online_payment_attempts_account_tenant_fk
  foreign key(account_id,restaurant_id) references private.payment_accounts(id,restaurant_id);
create index online_payment_attempts_account_idx on private.online_payment_attempts(account_id);

create function private.guard_payment_account_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.id is distinct from old.id or new.restaurant_id is distinct from old.restaurant_id or new.provider_user_id is distinct from old.provider_user_id
    or (new.live_mode is distinct from old.live_mode and (old.live_mode is not null or new.live_mode is null
      or current_setting('app.payment_environment_backfill',true) is distinct from 'on')) then
    raise exception using errcode='22023',message='PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger payment_account_identity_guard before update on private.payment_accounts
for each row execute function private.guard_payment_account_identity();
create function private.guard_payment_attempt_account() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.account_id is distinct from old.account_id or new.restaurant_id is distinct from old.restaurant_id or new.order_id is distinct from old.order_id then
    raise exception using errcode='22023',message='PAYMENT_ATTEMPT_ACCOUNT_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger payment_attempt_account_guard before update on private.online_payment_attempts
for each row execute function private.guard_payment_attempt_account();

-- No default environment: old callers fail closed instead of assigning a mode.
drop function public.save_payment_account(uuid,text,text,timestamptz,boolean);
create function public.save_payment_account(p_restaurant_id uuid,p_provider_user_id text,p_encrypted_credentials text,p_expires_at timestamptz,p_live_mode boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare account private.payment_accounts%rowtype; previous_id uuid;
begin
  if p_live_mode is null then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_REQUIRED'; end if;
  perform id from public.restaurants where id=p_restaurant_id for update;
  if not found then raise exception using errcode='22023',message='RESTAURANT_NOT_AVAILABLE'; end if;
  select id into previous_id from private.payment_accounts where restaurant_id=p_restaurant_id and is_current;
  select * into account from private.payment_accounts where provider_user_id=p_provider_user_id and live_mode=p_live_mode for update;
  if found and account.restaurant_id<>p_restaurant_id then
    raise exception using errcode='22023',message='PAYMENT_ACCOUNT_ALREADY_CONNECTED';
  end if;
  update private.payment_accounts set active=false,is_current=false,updated_at=now()
    where restaurant_id=p_restaurant_id and is_current and id is distinct from account.id;
  if account.id is null then
    begin
      insert into private.payment_accounts(restaurant_id,provider_user_id,encrypted_credentials,expires_at,live_mode,is_current,active)
        values(p_restaurant_id,p_provider_user_id,p_encrypted_credentials,p_expires_at,p_live_mode,true,true) returning * into account;
    exception when unique_violation then
      raise exception using errcode='22023',message='PAYMENT_ACCOUNT_ALREADY_CONNECTED';
    end;
  else
    update private.payment_accounts set encrypted_credentials=p_encrypted_credentials,expires_at=p_expires_at,
      active=true,is_current=true,refresh_lease_until=null,updated_at=now() where id=account.id returning * into account;
  end if;
  if previous_id is distinct from account.id then
    update public.restaurants set store_checkout_online_enabled=false where id=p_restaurant_id;
  end if;
  insert into public.payment_methods(restaurant_id,code,name,provider,active,sort_order)
    values(p_restaurant_id,'mozzi-online-mp','Mercado Pago','mercadopago',true,999)
    on conflict(restaurant_id,provider) where provider is not null do update set active=true;
  return jsonb_build_object('connected',true,'accountId',account.id,'liveMode',account.live_mode);
end $$;

-- Refresh is tied to the exact connection. It cannot switch the current account
-- or reactivate a disconnected one, including during a concurrent OAuth flow.
create function public.refresh_payment_account(p_account_id uuid,p_provider_user_id text,p_encrypted_credentials text,p_expires_at timestamptz,p_live_mode boolean,p_expected_expires_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare account private.payment_accounts%rowtype;
begin
  select * into account from private.payment_accounts where id=p_account_id for update;
  if not found then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_NOT_FOUND'; end if;
  if p_live_mode is null or account.live_mode is null then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_RECONNECT_REQUIRED'; end if;
  if account.provider_user_id is distinct from p_provider_user_id or account.live_mode is distinct from p_live_mode then
    raise exception using errcode='22023',message='PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE';
  end if;
  if p_expected_expires_at is null or account.expires_at is distinct from p_expected_expires_at then
    raise exception using errcode='40001',message='PAYMENT_LEASE_CONFLICT';
  end if;
  update private.payment_accounts set encrypted_credentials=p_encrypted_credentials,expires_at=p_expires_at,
    refresh_lease_until=null,updated_at=now() where id=account.id returning * into account;
  return jsonb_build_object('accountId',account.id,'liveMode',account.live_mode,'active',account.active,'isCurrent',account.is_current);
end $$;

-- One-time bridge only after a server operator verifies the encrypted envelope.
-- Never infer a legacy environment from the current deployment's mode.
create function public.backfill_payment_account_environment(p_account_id uuid,p_live_mode boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare account private.payment_accounts%rowtype; changed boolean:=false;
begin
  if p_live_mode is null then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_REQUIRED'; end if;
  select * into account from private.payment_accounts where id=p_account_id for update;
  if not found then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_NOT_FOUND'; end if;
  if account.live_mode is not null and account.live_mode<>p_live_mode then
    raise exception using errcode='22023',message='PAYMENT_ACCOUNT_IDENTITY_IMMUTABLE';
  end if;
  if account.live_mode is null then
    perform set_config('app.payment_environment_backfill','on',true);
    begin
      update private.payment_accounts set live_mode=p_live_mode,updated_at=now() where id=account.id;
    exception when unique_violation then
      raise exception using errcode='22023',message='PAYMENT_ACCOUNT_ALREADY_CONNECTED';
    end;
    perform set_config('app.payment_environment_backfill','off',true);
    changed:=true;
  end if;
  return jsonb_build_object('accountId',account.id,'liveMode',p_live_mode,'updated',changed);
end $$;

drop function public.get_payment_account(uuid,text);
create function public.get_payment_account(p_restaurant_id uuid default null,p_provider_user_id text default null,p_account_id uuid default null,p_live_mode boolean default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare account private.payment_accounts%rowtype; candidates bigint;
begin
  if p_account_id is not null then
    select * into account from private.payment_accounts where id=p_account_id
      and (p_restaurant_id is null or restaurant_id=p_restaurant_id)
      and (p_provider_user_id is null or provider_user_id=p_provider_user_id)
      and (p_live_mode is null or live_mode=p_live_mode);
  elsif p_restaurant_id is not null then
    select * into account from private.payment_accounts where restaurant_id=p_restaurant_id and is_current
      and (p_provider_user_id is null or provider_user_id=p_provider_user_id)
      and (p_live_mode is null or live_mode=p_live_mode);
  elsif p_provider_user_id is not null then
    if p_live_mode is null then
      select count(*) into candidates from private.payment_accounts where provider_user_id=p_provider_user_id;
      if candidates=0 then return null; end if;
      if candidates<>1 or exists(select 1 from private.payment_accounts where provider_user_id=p_provider_user_id and live_mode is null) then
        raise exception using errcode='22023',message='PAYMENT_ACCOUNT_LOOKUP_AMBIGUOUS';
      end if;
    end if;
    select * into account from private.payment_accounts where provider_user_id=p_provider_user_id and (p_live_mode is null or live_mode=p_live_mode);
  else
    raise exception using errcode='22023',message='PAYMENT_ACCOUNT_LOOKUP_INVALID';
  end if;
  if account.id is null then return null; end if;
  return jsonb_build_object('accountId',account.id,'restaurantId',account.restaurant_id,'providerUserId',account.provider_user_id,
    'encryptedCredentials',account.encrypted_credentials,'expiresAt',account.expires_at,'active',account.active,'isCurrent',account.is_current,'liveMode',account.live_mode);
end $$;

create or replace function public.get_payment_connection(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_manage_restaurant(p_restaurant_id) then raise exception using errcode='42501',message='PAYMENT_ACCOUNT_FORBIDDEN'; end if;
  return coalesce((select jsonb_build_object('connected',active,'active',active,'accountId',id,'providerUserId',provider_user_id,'expiresAt',expires_at,'liveMode',live_mode)
    from private.payment_accounts where restaurant_id=p_restaurant_id and is_current),jsonb_build_object('connected',false));
end $$;
create or replace function public.disconnect_payment_account(p_restaurant_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform id from public.restaurants where id=p_restaurant_id for update;
  update private.payment_accounts set active=false,updated_at=now() where restaurant_id=p_restaurant_id and is_current;
  update public.restaurants set store_checkout_online_enabled=false where id=p_restaurant_id;
  return jsonb_build_object('connected',false);
end $$;
drop function public.acquire_payment_account_refresh(uuid,timestamptz);
create function public.acquire_payment_account_refresh(p_account_id uuid,p_expected_expires_at timestamptz)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  update private.payment_accounts set refresh_lease_until=now()+interval '60 seconds'
    where id=p_account_id and live_mode is not null and expires_at=p_expected_expires_at and (refresh_lease_until is null or refresh_lease_until<now());
  return found;
end $$;
create or replace function private.guard_online_checkout_activation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.store_checkout_online_enabled and (tg_op='INSERT' or not old.store_checkout_online_enabled) and
    (new.inventory_mode<>'enforced' or new.inventory_cutover_id is not null or new.currency_code<>'ARS'
      or not exists(select 1 from private.payment_accounts where restaurant_id=new.id and is_current and active and live_mode is not null)) then
    raise exception using errcode='22023',message='ONLINE_CHECKOUT_NOT_READY';
  end if;
  return new;
end $$;

drop function public.begin_online_checkout(jsonb,text,text,text,text);
create function public.begin_online_checkout(p_request jsonb,p_ip_hash text,p_phone_hash text,p_client_event_token_hash text,p_status_token_hash text,p_live_mode boolean,p_expected_account_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; o public.orders%rowtype; a private.online_payment_attempts%rowtype;
  account private.payment_accounts%rowtype; original_account private.payment_accounts%rowtype;
  response jsonb; method_id uuid; replayed boolean; lease uuid; token_expiry timestamptz:=now()+interval '30 days';
begin
  if p_live_mode is null then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_REQUIRED'; end if;
  if p_status_token_hash is null or p_status_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PAYMENT_TOKEN_INVALID'; end if;
  select * into r from public.restaurants where slug=lower(btrim(p_request->>'restaurantSlug')) for share;
  if not found or not r.store_enabled or not r.store_checkout_online_enabled or r.status<>'active' or r.currency_code<>'ARS' then
    raise exception using errcode='22023',message='ONLINE_CHECKOUT_NOT_READY';
  end if;
  select * into account from private.payment_accounts where restaurant_id=r.id and is_current and active;
  if account.id is null then raise exception using errcode='22023',message='ONLINE_CHECKOUT_NOT_READY'; end if;
  if p_expected_account_id is null or account.id is distinct from p_expected_account_id then
    raise exception using errcode='40001',message='PAYMENT_ACCOUNT_NOT_CURRENT';
  end if;
  if account.live_mode is null then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_RECONNECT_REQUIRED'; end if;
  if account.live_mode<>p_live_mode then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_MISMATCH'; end if;
  perform private.inventory_require_sales(r.id,true);
  select id into method_id from public.payment_methods where restaurant_id=r.id and provider='mercadopago' and active;
  if method_id is null then raise exception 'ONLINE_CHECKOUT_NOT_READY'; end if;
  response:=private.create_commerce_order(p_request||jsonb_build_object('channel','store','checkoutMode','online','paymentMethodId',method_id),p_ip_hash,p_phone_hash,p_client_event_token_hash);
  replayed:=coalesce((response->>'idempotentReplay')::boolean,false);
  select * into strict o from public.orders where action_id=(response#>>'{order,actionId}')::uuid for update;
  if o.total_cents<=0 then raise exception using errcode='22023',message='ONLINE_AMOUNT_INVALID'; end if;
  insert into private.online_payment_attempts(order_id,restaurant_id,account_id) values(o.id,r.id,account.id) on conflict(order_id) do nothing;
  select * into a from private.online_payment_attempts where order_id=o.id for update;
  select * into strict original_account from private.payment_accounts where id=a.account_id;
  if original_account.live_mode is null then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_RECONNECT_REQUIRED'; end if;
  if original_account.live_mode<>p_live_mode then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_MISMATCH'; end if;
  if a.checkout_url is null and a.account_id<>account.id then raise exception using errcode='22023',message='PAYMENT_ACCOUNT_NOT_CURRENT'; end if;
  if o.status in ('cancelled','expired','completed') or (a.expires_at<=now() and o.payment_status<>'approved') then
    raise exception using errcode='22023',message='PAYMENT_ATTEMPT_EXPIRED';
  end if;
  perform set_config('app.order_mutation','on',true);
  if o.payment_status in ('unpaid','pending','rejected') then
    perform private.online_stock_operation(a.id,'payment_hold');
    update public.orders set payment_status='pending',expires_at=a.expires_at where id=o.id returning * into o;
  end if;
  insert into private.online_payment_status_tokens(order_id,token_hash,expires_at) values(o.id,p_status_token_hash,token_expiry)
    on conflict(order_id,token_hash) do update set expires_at=greatest(excluded.expires_at,private.online_payment_status_tokens.expires_at);
  if a.checkout_url is null and (a.preference_lease_until is null or a.preference_lease_until<now()) then
    lease:=extensions.gen_random_uuid();
    update private.online_payment_attempts set preference_lease_id=lease,preference_lease_until=now()+interval '2 minutes' where id=a.id;
  end if;
  return jsonb_build_object('orderId',o.id,'restaurantId',r.id,'actionId',o.action_id,'displayNumber',o.display_number,'createdAt',o.created_at,
    'status',o.status,'paymentStatus',o.payment_status,'totalCents',o.total_cents::text,'currencyCode',o.currency_code,'expiresAt',a.expires_at,
    'attemptId',a.id,'accountId',a.account_id,'liveMode',original_account.live_mode,'providerPreferenceId',a.provider_preference_id,'checkoutUrl',a.checkout_url,'replayed',replayed,
    'recoveryExpiresAt',token_expiry,'preferenceLeaseAcquired',lease is not null,'preferenceLeaseId',lease);
end $$;

create or replace function public.get_online_payment_attempt(p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('attemptId',a.id,'orderId',a.order_id,'restaurantId',a.restaurant_id,'accountId',a.account_id,'liveMode',c.live_mode,
    'providerPreferenceId',a.provider_preference_id,'providerPaymentId',a.provider_payment_id,'totalCents',o.total_cents::text,
    'currencyCode',o.currency_code,'expiresAt',a.expires_at,'paymentStatus',o.payment_status)
  from private.online_payment_attempts a join public.orders o on o.id=a.order_id join private.payment_accounts c on c.id=a.account_id where a.id=p_attempt_id
$$;

drop function public.get_online_checkout_status(uuid,text);
create function public.get_online_checkout_status(p_action_id uuid,p_token_hash text,p_live_mode boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.orders%rowtype; a private.online_payment_attempts%rowtype; account private.payment_accounts%rowtype; expiry timestamptz;
begin
  if p_live_mode is null then raise exception using errcode='22023',message='PAYMENT_ENVIRONMENT_REQUIRED'; end if;
  select orders.* into o from public.orders orders join private.online_payment_status_tokens tokens on tokens.order_id=orders.id
    where orders.action_id=p_action_id and tokens.token_hash=p_token_hash and tokens.expires_at>now();
  if not found then raise exception using errcode='42501',message='PAYMENT_STATUS_FORBIDDEN'; end if;
  select expires_at into expiry from private.online_payment_status_tokens where order_id=o.id and token_hash=p_token_hash;
  select * into a from private.online_payment_attempts where order_id=o.id;
  select * into account from private.payment_accounts where id=a.account_id;
  return jsonb_build_object('order',jsonb_build_object('actionId',o.action_id,'displayNumber',o.display_number,'status',o.status,
    'totalCents',o.total_cents::text,'currencyCode',o.currency_code,'createdAt',o.created_at,'channel',o.channel,'checkoutMode',o.checkout_mode,'paymentStatus',o.payment_status),
    'payment',jsonb_build_object('status',o.payment_status,'checkoutUrl',case when a.expires_at>now() and o.payment_status in ('pending','rejected')
      and o.status in ('generated','whatsapp_opened') and account.live_mode=p_live_mode then a.checkout_url else null end,
      'expiresAt',a.expires_at,'reviewRequired',o.payment_status in ('requires_refund','partially_refunded','charged_back')),'recoveryExpiresAt',expiry);
end $$;

revoke all on function private.guard_payment_account_identity(),private.guard_payment_attempt_account() from public,anon,authenticated,service_role;
revoke all on function public.save_payment_account(uuid,text,text,timestamptz,boolean),public.refresh_payment_account(uuid,text,text,timestamptz,boolean,timestamptz),
  public.backfill_payment_account_environment(uuid,boolean),public.get_payment_account(uuid,text,uuid,boolean),public.acquire_payment_account_refresh(uuid,timestamptz),
  public.begin_online_checkout(jsonb,text,text,text,text,boolean,uuid),public.get_online_checkout_status(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.save_payment_account(uuid,text,text,timestamptz,boolean),public.refresh_payment_account(uuid,text,text,timestamptz,boolean,timestamptz),
  public.backfill_payment_account_environment(uuid,boolean),public.get_payment_account(uuid,text,uuid,boolean),public.acquire_payment_account_refresh(uuid,timestamptz),
  public.begin_online_checkout(jsonb,text,text,text,text,boolean,uuid),public.get_online_checkout_status(uuid,text,boolean) to service_role;
revoke all on private.payment_accounts,private.online_payment_attempts from public,anon,authenticated,service_role;
