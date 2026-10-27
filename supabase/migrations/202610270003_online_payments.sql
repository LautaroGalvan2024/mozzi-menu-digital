-- Checkout Pro credentials, payment attempts and temporary stock reservations.
-- Provider communication is performed by Edge; only verified server calls may
-- reconcile money. Public payment status requires a separately hashed bearer.
create table private.payment_accounts (
  restaurant_id uuid primary key references public.restaurants(id),
  provider_user_id text not null unique check(char_length(provider_user_id) between 1 and 100),
  encrypted_credentials text not null check(char_length(encrypted_credentials) between 1 and 20000),
  expires_at timestamptz not null,
  active boolean not null default true,
  refresh_lease_until timestamptz,
  updated_at timestamptz not null default now()
);
create table private.payment_oauth_states (
  state_hash text primary key check(state_hash ~ '^[0-9a-f]{64}$'),
  encrypted_payload text not null check(char_length(encrypted_payload) between 1 and 20000),
  expires_at timestamptz not null default now()+interval '10 minutes'
);
create table private.online_payment_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  restaurant_id uuid not null references public.restaurants(id),
  provider_preference_id text unique,
  checkout_url text,
  provider_payment_id text,
  expires_at timestamptz not null default now()+interval '30 minutes',
  reservation_state text not null default 'none' check(reservation_state in ('none','held','committed','released')),
  preference_lease_id uuid,
  preference_lease_until timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(order_id,restaurant_id) references public.orders(id,restaurant_id)
);
create table private.online_payment_receipts (
  provider_payment_id text primary key,
  attempt_id uuid not null references private.online_payment_attempts(id),
  status text not null,
  amount_cents bigint not null,
  currency text not null,
  provider_updated_at timestamptz not null,
  provider_data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table private.online_payment_status_tokens (
  order_id uuid not null references public.orders(id),
  token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  primary key(order_id,token_hash)
);
revoke all on private.payment_accounts,private.payment_oauth_states,private.online_payment_attempts,
  private.online_payment_receipts,private.online_payment_status_tokens from public,anon,authenticated,service_role;

alter table public.payment_methods add column provider text check(provider is null or provider='mercadopago');
create unique index payment_methods_one_provider on public.payment_methods(restaurant_id,provider) where provider is not null;
create function private.guard_provider_payment_method() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') and
    (new.provider is not null or (tg_op='UPDATE' and old.provider is not null)) then
    raise exception using errcode='42501',message='PAYMENT_PROVIDER_METHOD_MANAGED';
  end if;
  return new;
end $$;
create trigger payment_methods_provider_guard before insert or update on public.payment_methods
for each row execute function private.guard_provider_payment_method();

create function public.save_payment_account(p_restaurant_id uuid,p_provider_user_id text,p_encrypted_credentials text,p_expires_at timestamptz,p_activate boolean default true)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform id from public.restaurants where id=p_restaurant_id for update;
  if not found then raise exception 'RESTAURANT_NOT_AVAILABLE'; end if;
  if exists(select 1 from private.payment_accounts where restaurant_id=p_restaurant_id and provider_user_id<>p_provider_user_id)
    and exists(select 1 from private.online_payment_attempts where restaurant_id=p_restaurant_id) then
    raise exception 'PAYMENT_ACCOUNT_CHANGE_REQUIRES_REVIEW';
  end if;
  insert into private.payment_accounts(restaurant_id,provider_user_id,encrypted_credentials,expires_at)
  values(p_restaurant_id,p_provider_user_id,p_encrypted_credentials,p_expires_at)
  on conflict(restaurant_id) do update set provider_user_id=excluded.provider_user_id,
    encrypted_credentials=excluded.encrypted_credentials,expires_at=excluded.expires_at,
    active=case when p_activate then true else private.payment_accounts.active end,refresh_lease_until=null,updated_at=now();
  insert into public.payment_methods(restaurant_id,code,name,provider,active,sort_order)
    values(p_restaurant_id,'mozzi-online-mp','Mercado Pago','mercadopago',true,999)
  on conflict(restaurant_id,provider) where provider is not null do update set active=true;
  return jsonb_build_object('connected',true);
end $$;
create function public.get_payment_account(p_restaurant_id uuid default null,p_provider_user_id text default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('restaurantId',restaurant_id,'providerUserId',provider_user_id,'encryptedCredentials',encrypted_credentials,
    'expiresAt',expires_at,'active',active) from private.payment_accounts
  where (p_restaurant_id is not null and restaurant_id=p_restaurant_id and (p_provider_user_id is null or provider_user_id=p_provider_user_id))
    or (p_restaurant_id is null and p_provider_user_id is not null and provider_user_id=p_provider_user_id)
$$;
create function public.get_payment_connection(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_manage_restaurant(p_restaurant_id) then raise exception using errcode='42501',message='PAYMENT_ACCOUNT_FORBIDDEN'; end if;
  return coalesce((select jsonb_build_object('connected',active,'providerUserId',provider_user_id,'expiresAt',expires_at)
    from private.payment_accounts where restaurant_id=p_restaurant_id),jsonb_build_object('connected',false));
end $$;
create function public.disconnect_payment_account(p_restaurant_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  -- Retain encrypted access for outstanding payment reconciliation and refunds.
  perform id from public.restaurants where id=p_restaurant_id for update;
  update private.payment_accounts set active=false,updated_at=now() where restaurant_id=p_restaurant_id;
  update public.restaurants set store_checkout_online_enabled=false where id=p_restaurant_id;
  return jsonb_build_object('connected',false);
end $$;
create function public.acquire_payment_account_refresh(p_restaurant_id uuid,p_expected_expires_at timestamptz)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  update private.payment_accounts set refresh_lease_until=now()+interval '60 seconds'
  where restaurant_id=p_restaurant_id and expires_at=p_expected_expires_at and (refresh_lease_until is null or refresh_lease_until<now());
  return found;
end $$;
create function public.save_payment_oauth_state(p_state_hash text,p_encrypted_payload text)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  delete from private.payment_oauth_states where expires_at<=now();
  insert into private.payment_oauth_states(state_hash,encrypted_payload) values(p_state_hash,p_encrypted_payload);
end $$;
create function public.consume_payment_oauth_state(p_state_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare payload text;
begin
  delete from private.payment_oauth_states where state_hash=p_state_hash and expires_at>now() returning encrypted_payload into payload;
  if payload is null then raise exception using errcode='22023',message='OAUTH_STATE_INVALID'; end if;
  return jsonb_build_object('encryptedPayload',payload);
end $$;

create function private.guard_online_checkout_activation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.store_checkout_online_enabled and (tg_op='INSERT' or not old.store_checkout_online_enabled) and
    (new.inventory_mode<>'enforced' or new.inventory_cutover_id is not null or new.currency_code<>'ARS'
      or not exists(select 1 from private.payment_accounts where restaurant_id=new.id and active)) then
    raise exception using errcode='22023',message='ONLINE_CHECKOUT_NOT_READY';
  end if;
  return new;
end $$;
create trigger restaurants_online_checkout_guard before insert or update on public.restaurants
for each row execute function private.guard_online_checkout_activation();

-- Expose whether a method is manual/online, and never let a WhatsApp request use
-- the internal processor method or an online request borrow a cash discount.
do $migration$
declare source text;
begin
  source:=pg_get_functiondef('private.get_public_catalog_base(text,text)'::regprocedure);
  source:=replace(source,'''code'', pm.code,','''code'', pm.code, ''provider'', pm.provider,');
  execute source;
  source:=pg_get_functiondef('private.create_order_transaction_without_request_hash(jsonb,text,text,text)'::regprocedure);
  if position('pm.restaurant_id = v_restaurant.id and pm.active' in source)=0 then raise exception 'Unexpected payment selection definition'; end if;
  source:=replace(source,'pm.restaurant_id = v_restaurant.id and pm.active',
    'pm.restaurant_id = v_restaurant.id and pm.active and ((coalesce(p_request->>''checkoutMode'',''whatsapp'')=''whatsapp'' and pm.provider is null) or (p_request->>''checkoutMode''=''online'' and pm.provider=''mercadopago''))');
  execute source;
end $migration$;
alter function public.create_order_transaction(jsonb,text,text,text) rename to create_commerce_order;
alter function public.create_commerce_order(jsonb,text,text,text) set schema private;
create function public.create_order_transaction(p_request jsonb,p_ip_hash text,p_phone_hash text,p_client_event_token_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if coalesce(p_request->>'checkoutMode','whatsapp')<>'whatsapp' then
    raise exception using errcode='22023',message='ONLINE_CHECKOUT_ENDPOINT_REQUIRED';
  end if;
  return private.create_commerce_order(p_request,p_ip_hash,p_phone_hash,p_client_event_token_hash);
end $$;

alter table public.inventory_operations alter column actor_user_id drop not null;
alter table public.inventory_operations add column actor_type text not null default 'authenticated_user'
  check(actor_type in ('authenticated_user','system'));
alter table public.inventory_operations add constraint inventory_operation_actor
  check((actor_type='system' and actor_user_id is null) or (actor_type='authenticated_user' and actor_user_id is not null));
alter table public.inventory_operations drop constraint inventory_operations_kind_check;
alter table public.inventory_operations add constraint inventory_operations_kind_check
  check(kind in ('count','reserve','release','delivery','receipt','adjustment','external_sale','correction','return','payment_hold','payment_release'));

create function private.lock_online_attempt(p_attempt_id uuid) returns private.online_payment_attempts
language plpgsql volatile security definer set search_path='' as $$
declare a private.online_payment_attempts%rowtype;
begin
  select * into a from private.online_payment_attempts where id=p_attempt_id;
  if not found then raise exception using errcode='22023',message='PAYMENT_ATTEMPT_NOT_FOUND'; end if;
  perform id from public.restaurants where id=a.restaurant_id for share;
  perform id from public.orders where id=a.order_id for update;
  select * into a from private.online_payment_attempts where id=p_attempt_id for update;
  return a;
end $$;
create function private.online_stock_operation(p_attempt_id uuid,p_kind text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare a private.online_payment_attempts%rowtype; rows jsonb; result jsonb; operation_id uuid:=extensions.gen_random_uuid();
begin
  select * into strict a from private.online_payment_attempts where id=p_attempt_id;
  if p_kind='payment_hold' and a.reservation_state in ('held','committed') then return; end if;
  if p_kind='payment_release' and a.reservation_state<>'held' then return; end if;
  if p_kind='reserve' and a.reservation_state='committed' then return; end if;
  if p_kind not in ('payment_hold','payment_release','reserve') or (p_kind='reserve' and a.reservation_state<>'held') then raise exception 'PAYMENT_RESERVATION_INVALID'; end if;
  if p_kind in ('payment_hold','payment_release') and exists(select 1 from public.restaurants where id=a.restaurant_id and inventory_cutover_id is not null) then
    raise exception using errcode='22023',message='INVENTORY_CUTOVER';
  end if;
  if p_kind='payment_hold' then perform private.inventory_require_sales(a.restaurant_id,true); end if;
  perform private.inventory_snapshot(a.order_id);
  if p_kind='reserve' then
    -- The units are already reserved by the hold; conversion is a ledger marker.
    result:=jsonb_build_object('operationId',operation_id,'kind','reserve','orderId',a.order_id,'items','[]'::jsonb,'fromPaymentHold',true);
  else
    select jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',0,
      'deltaReserved',case when p_kind='payment_hold' then x.quantity else -x.quantity end) order by x.product_id)
      into rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=a.order_id group by product_id)x;
    result:=jsonb_build_object('operationId',operation_id,'kind',p_kind,'orderId',a.order_id,'items',private.inventory_apply(a.restaurant_id,operation_id,rows));
  end if;
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,actor_type,result)
    values(operation_id,a.restaurant_id,operation_id,private.inventory_hash(jsonb_build_object('attemptId',a.id,'kind',p_kind)),p_kind,a.order_id,
      'Mercado Pago: '||p_kind,null,'system',result);
  update private.online_payment_attempts set reservation_state=case p_kind when 'payment_hold' then 'held' when 'payment_release' then 'released' else 'committed' end where id=a.id;
end $$;

create function public.begin_online_checkout(p_request jsonb,p_ip_hash text,p_phone_hash text,p_client_event_token_hash text,p_status_token_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r public.restaurants%rowtype; o public.orders%rowtype; a private.online_payment_attempts%rowtype;
  response jsonb; method_id uuid; replayed boolean; lease uuid; token_expiry timestamptz:=now()+interval '30 days';
begin
  if p_status_token_hash is null or p_status_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PAYMENT_TOKEN_INVALID'; end if;
  select * into r from public.restaurants where slug=lower(btrim(p_request->>'restaurantSlug')) for share;
  if not found or not r.store_enabled or not r.store_checkout_online_enabled or r.status<>'active' or r.currency_code<>'ARS'
    or not exists(select 1 from private.payment_accounts where restaurant_id=r.id and active) then
    raise exception using errcode='22023',message='ONLINE_CHECKOUT_NOT_READY';
  end if;
  perform private.inventory_require_sales(r.id,true);
  select id into method_id from public.payment_methods where restaurant_id=r.id and provider='mercadopago' and active;
  if method_id is null then raise exception 'ONLINE_CHECKOUT_NOT_READY'; end if;
  response:=private.create_commerce_order(p_request||jsonb_build_object('channel','store','checkoutMode','online','paymentMethodId',method_id),p_ip_hash,p_phone_hash,p_client_event_token_hash);
  replayed:=coalesce((response->>'idempotentReplay')::boolean,false);
  select * into strict o from public.orders where action_id=(response#>>'{order,actionId}')::uuid for update;
  if o.total_cents<=0 then raise exception using errcode='22023',message='ONLINE_AMOUNT_INVALID'; end if;
  insert into private.online_payment_attempts(order_id,restaurant_id) values(o.id,r.id) on conflict(order_id) do nothing;
  select * into a from private.online_payment_attempts where order_id=o.id for update;
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
    'attemptId',a.id,'providerPreferenceId',a.provider_preference_id,'checkoutUrl',a.checkout_url,'replayed',replayed,
    'recoveryExpiresAt',token_expiry,'preferenceLeaseAcquired',lease is not null,'preferenceLeaseId',lease);
end $$;

create function public.set_online_checkout_preference(p_attempt_id uuid,p_preference_id text,p_checkout_url text,p_lease_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a private.online_payment_attempts%rowtype;
begin
  a:=private.lock_online_attempt(p_attempt_id);
  if p_preference_id is null or char_length(p_preference_id) not between 1 and 200 or p_checkout_url !~ '^https://[^/]+/' then raise exception 'PAYMENT_PREFERENCE_INVALID'; end if;
  if a.preference_lease_id is distinct from p_lease_id or p_lease_id is null then raise exception using errcode='40001',message='PAYMENT_LEASE_CONFLICT'; end if;
  if a.provider_preference_id is not null and a.provider_preference_id<>p_preference_id then raise exception 'PAYMENT_PREFERENCE_CONFLICT'; end if;
  update private.online_payment_attempts set provider_preference_id=p_preference_id,checkout_url=p_checkout_url,
    preference_lease_until=null where id=a.id;
  return jsonb_build_object('checkoutUrl',p_checkout_url);
end $$;
create function public.get_online_payment_attempt(p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('attemptId',a.id,'orderId',o.id,'restaurantId',o.restaurant_id,'providerPreferenceId',a.provider_preference_id,
    'providerPaymentId',a.provider_payment_id,'totalCents',o.total_cents::text,'currencyCode',o.currency_code,'expiresAt',a.expires_at,
    'paymentStatus',o.payment_status,'reservationState',a.reservation_state)
  from private.online_payment_attempts a join public.orders o on o.id=a.order_id where a.id=p_attempt_id
$$;
create function public.get_online_checkout_status(p_action_id uuid,p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.orders%rowtype; a private.online_payment_attempts%rowtype; expiry timestamptz;
begin
  select orders.* into o from public.orders orders join private.online_payment_status_tokens tokens on tokens.order_id=orders.id
    where orders.action_id=p_action_id and tokens.token_hash=p_token_hash and tokens.expires_at>now();
  if not found then raise exception using errcode='42501',message='PAYMENT_STATUS_FORBIDDEN'; end if;
  select expires_at into expiry from private.online_payment_status_tokens where order_id=o.id and token_hash=p_token_hash;
  select * into a from private.online_payment_attempts where order_id=o.id;
  return jsonb_build_object('order',jsonb_build_object('actionId',o.action_id,'displayNumber',o.display_number,'status',o.status,
    'totalCents',o.total_cents::text,'currencyCode',o.currency_code,'createdAt',o.created_at,'channel',o.channel,'checkoutMode',o.checkout_mode,'paymentStatus',o.payment_status),
    'payment',jsonb_build_object('status',o.payment_status,'checkoutUrl',case when a.expires_at>now() and o.payment_status in ('pending','rejected') then a.checkout_url else null end,
      'expiresAt',a.expires_at,'reviewRequired',o.payment_status in ('requires_refund','partially_refunded','charged_back')),'recoveryExpiresAt',expiry);
end $$;

-- Record system release using the existing immutable ledger. Existing manual
-- operations still require a real user; a payment cannot fabricate acceptance.
create function private.release_paid_order(p_order_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; rows jsonb; result jsonb; operation_id uuid:=extensions.gen_random_uuid();
begin
  select * into o from public.orders where id=p_order_id;
  if exists(select 1 from public.inventory_operations where order_id=o.id and kind in ('delivery','release')) then return; end if;
  if not exists(select 1 from public.inventory_operations where order_id=o.id and kind='reserve') then return; end if;
  if exists(select 1 from public.restaurants where id=o.restaurant_id and inventory_cutover_id is not null) then
    raise exception using errcode='22023',message='INVENTORY_CUTOVER';
  end if;
  select jsonb_agg(jsonb_build_object('productId',x.product_id,'deltaOnHand',0,'deltaReserved',-x.quantity) order by x.product_id)
    into rows from (select product_id,sum(quantity)::bigint quantity from public.order_inventory_lines where order_id=o.id group by product_id)x;
  result:=jsonb_build_object('operationId',operation_id,'kind','release','orderId',o.id,'items',private.inventory_apply(o.restaurant_id,operation_id,rows));
  insert into public.inventory_operations(id,restaurant_id,idempotency_key,request_hash,kind,order_id,reason,actor_user_id,actor_type,result)
    values(operation_id,o.restaurant_id,operation_id,private.inventory_hash(jsonb_build_object('orderId',o.id,'kind','release')),
      'release',o.id,'Mercado Pago: pago revertido',null,'system',result);
end $$;

create function private.online_order_integrity() returns trigger
language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype; a private.online_payment_attempts%rowtype;
begin
  select * into o from public.orders where id=new.id;
  if o.checkout_mode<>'online' then return null; end if;
  select * into a from private.online_payment_attempts where order_id=o.id;
  if not found or not o.inventory_tracked then raise exception 'ONLINE_ORDER_RESERVATION_MISSING'; end if;
  if o.payment_status='approved' and o.status in ('generated','whatsapp_opened','accepted','completed') and
    (a.reservation_state<>'committed' or not exists(select 1 from public.inventory_operations where order_id=o.id and kind='reserve')) then
    raise exception 'ONLINE_APPROVAL_REQUIRES_RESERVED_STOCK';
  end if;
  return null;
end $$;
create constraint trigger orders_online_integrity after insert or update on public.orders
deferrable initially deferred for each row execute function private.online_order_integrity();

create function public.reconcile_online_payment(p_attempt_id uuid,p_payment_id text,p_status text,p_amount_cents bigint,p_currency text,
  p_provider_updated_at timestamptz,p_provider_data jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a private.online_payment_attempts%rowtype; o public.orders%rowtype; receipt private.online_payment_receipts%rowtype;
  new_status text; previous_status text; paid_count integer; has_partial boolean; has_dispute boolean; has_pending boolean;
begin
  a:=private.lock_online_attempt(p_attempt_id);
  select * into o from public.orders where id=a.order_id;
  if p_payment_id is null or char_length(p_payment_id) not between 1 and 200 or p_provider_updated_at is null
    or p_amount_cents is distinct from o.total_cents or p_currency is distinct from o.currency_code
    or p_status is null or p_status not in ('pending','in_process','authorized','approved','rejected','cancelled','refunded','charged_back','partially_refunded','in_mediation') then
    raise exception using errcode='22023',message='PAYMENT_VERIFICATION_FAILED';
  end if;
  select * into receipt from private.online_payment_receipts where provider_payment_id=p_payment_id;
  if found then
    if receipt.attempt_id<>a.id then raise exception 'PAYMENT_ATTEMPT_MISMATCH'; end if;
    if receipt.provider_updated_at>p_provider_updated_at or (receipt.provider_updated_at=p_provider_updated_at and receipt.status=p_status) then
      return jsonb_build_object('replayed',true,'paymentStatus',o.payment_status);
    end if;
    if receipt.status in ('approved','partially_refunded','refunded','charged_back','in_mediation')
      and p_status in ('pending','in_process','authorized','rejected','cancelled') then
      return jsonb_build_object('replayed',true,'paymentStatus',o.payment_status);
    end if;
  end if;
  if pg_column_size(p_provider_data)>65536 then raise exception 'PAYMENT_DATA_TOO_LARGE'; end if;
  insert into private.online_payment_receipts(provider_payment_id,attempt_id,status,amount_cents,currency,provider_updated_at,provider_data)
    values(p_payment_id,a.id,p_status,p_amount_cents,p_currency,p_provider_updated_at,p_provider_data)
  on conflict(provider_payment_id) do update set status=excluded.status,provider_updated_at=excluded.provider_updated_at,
    provider_data=excluded.provider_data,updated_at=now();
  previous_status:=o.payment_status;
  new_status:=case when p_status in ('in_process','authorized') then 'pending' else p_status end;
  select count(*) filter(where status in ('approved','partially_refunded')),
    coalesce(bool_or(status='partially_refunded'),false),coalesce(bool_or(status='in_mediation'),false),
    coalesce(bool_or(status in ('pending','in_process','authorized')),false)
    into paid_count,has_partial,has_dispute,has_pending
    from private.online_payment_receipts where attempt_id=a.id;
  perform set_config('app.order_mutation','on',true);
  if paid_count>0 then
    new_status:=case when paid_count>1 or has_dispute then 'requires_refund' when has_partial then 'partially_refunded' else 'approved' end;
    if o.status='cancelled' or o.payment_status in ('refunded','charged_back') then new_status:='requires_refund';
    else
      begin
        if a.reservation_state not in ('held','committed') then perform private.online_stock_operation(a.id,'payment_hold'); end if;
        perform private.online_stock_operation(a.id,'reserve');
        update public.orders set expires_at=null,status=case when status='expired' then 'generated'::public.order_status else status end where id=o.id;
      exception when sqlstate '22023' then
        -- Every aggregate that appears paid must have real stock, even when the
        -- triggering event is a rejection/refund of another provider payment.
        new_status:='requires_refund';
      end;
    end if;
    update private.online_payment_attempts set provider_payment_id=(select provider_payment_id from private.online_payment_receipts
      where attempt_id=a.id and status in ('approved','partially_refunded') order by provider_updated_at,provider_payment_id limit 1) where id=a.id;
  elsif has_dispute then
    new_status:='requires_refund';
  elsif p_status in ('refunded','charged_back') then
    perform private.online_stock_operation(a.id,'payment_release');
    perform private.release_paid_order(o.id);
    update public.orders set status=case when status='completed' then status else 'cancelled'::public.order_status end,expires_at=null where id=o.id;
  elsif p_status in ('rejected','cancelled') then
    if has_pending then new_status:='pending';
    elsif o.payment_status not in ('approved','partially_refunded','requires_refund','refunded','charged_back') then
      perform private.online_stock_operation(a.id,'payment_release');
    else new_status:=o.payment_status; end if;
  elsif p_status in ('pending','in_process','authorized') and o.payment_status in ('approved','partially_refunded','requires_refund','refunded','charged_back') then
    new_status:=o.payment_status;
  end if;
  update public.orders set payment_status=new_status where id=o.id;
  update private.online_payment_attempts set last_reconciled_at=now() where id=a.id;
  insert into public.order_events(restaurant_id,order_id,event_type,actor_type,metadata)
    values(o.restaurant_id,o.id,'payment_reconciled','system',jsonb_build_object('paymentId',p_payment_id,'providerStatus',p_status,'previousPaymentStatus',previous_status,'paymentStatus',new_status));
  return jsonb_build_object('replayed',false,'paymentStatus',new_status,'reviewRequired',new_status in ('requires_refund','partially_refunded','charged_back'));
end $$;

create function public.list_online_reconciliation(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_limit not between 1 and 500 then raise exception 'LIMIT_INVALID'; end if;
  return coalesce((select jsonb_agg(x.payload) from (select public.get_online_payment_attempt(a.id) payload
    from private.online_payment_attempts a join public.orders o on o.id=a.order_id
    where o.payment_status in ('pending','rejected','requires_refund','approved','partially_refunded')
    order by a.last_reconciled_at nulls first,a.created_at limit p_limit)x),'[]');
end $$;
create function public.mark_online_reconciled(p_attempt_id uuid)
returns void language sql volatile security definer set search_path='' as $$
  update private.online_payment_attempts set last_reconciled_at=now() where id=p_attempt_id
$$;
create function public.expire_online_reservations(p_before timestamptz default now(),p_limit integer default 100)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare candidate record; a private.online_payment_attempts%rowtype; o public.orders%rowtype; count_expired integer:=0;
begin
  if p_limit not between 1 and 500 then raise exception 'LIMIT_INVALID'; end if;
  for candidate in select attempts.id from private.online_payment_attempts attempts join public.orders orders on orders.id=attempts.order_id
    where attempts.expires_at<=least(p_before,now()) and attempts.reservation_state in ('held','released')
      and orders.status in ('generated','whatsapp_opened') and orders.payment_status not in ('approved','partially_refunded','requires_refund')
    order by attempts.expires_at limit p_limit loop
    a:=private.lock_online_attempt(candidate.id);
    select * into o from public.orders where id=a.order_id;
    if o.payment_status in ('approved','partially_refunded','requires_refund') or o.status not in ('generated','whatsapp_opened') then continue; end if;
    perform private.online_stock_operation(a.id,'payment_release');
    perform set_config('app.order_mutation','on',true);
    update public.orders set status='expired' where id=o.id;
    insert into public.order_events(restaurant_id,order_id,event_type,from_status,to_status,actor_type)
      values(o.restaurant_id,o.id,'online_reservation_expired',o.status,'expired','system');
    count_expired:=count_expired+1;
  end loop;
  delete from private.online_payment_status_tokens where expires_at<=now();
  return count_expired;
end $$;

-- Manual acceptance/delivery require a verified paid checkout, and reuse its
-- confirmed stock reservation. WhatsApp retains the original acceptance policy.
alter function public.claim_order(uuid) rename to claim_order_before_online;
alter function public.claim_order_before_online(uuid) set schema private;
create function public.claim_order(p_action_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; order_id uuid;
begin
  select id into order_id from public.orders where action_id=p_action_id;
  o:=private.inventory_lock_order(order_id);
  if o.checkout_mode='online' and o.payment_status<>'approved' then raise exception using errcode='22023',message='PAYMENT_NOT_APPROVED'; end if;
  return private.claim_order_before_online(p_action_id);
end $$;
alter function public.complete_order(uuid) rename to complete_order_before_online;
alter function public.complete_order_before_online(uuid) set schema private;
create function public.complete_order(p_order_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype;
begin
  o:=private.inventory_lock_order(p_order_id);
  if o.checkout_mode='online' and o.payment_status<>'approved' then raise exception using errcode='22023',message='PAYMENT_NOT_APPROVED'; end if;
  return private.complete_order_before_online(p_order_id);
end $$;
alter function public.cancel_order(uuid,text) rename to cancel_order_before_online;
alter function public.cancel_order_before_online(uuid,text) set schema private;
create function public.cancel_order(p_order_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare o public.orders%rowtype; a private.online_payment_attempts%rowtype; result jsonb;
begin
  o:=private.inventory_lock_order(p_order_id);
  if o.checkout_mode='online' and o.status in ('generated','whatsapp_opened','accepted') then
    select * into a from private.online_payment_attempts where order_id=o.id for update;
    perform private.online_stock_operation(a.id,'payment_release');
    if a.reservation_state='committed' and o.status<>'accepted' then perform private.release_paid_order(o.id); end if;
  end if;
  result:=private.cancel_order_before_online(p_order_id,p_reason);
  -- The payment remains approved; the operator must refund it at Mercado Pago.
  if o.checkout_mode='online' and o.payment_status in ('approved','partially_refunded') and (result->>'cancelled')::boolean then
    perform set_config('app.order_mutation','on',true);
    update public.orders set payment_status='requires_refund' where id=o.id;
    result:=jsonb_set(result,'{order}',private.order_admin_json(o.id));
  end if;
  return result;
end $$;
do $migration$
declare source text;
begin
  source:=pg_get_functiondef('public.expire_orders(timestamp with time zone,integer)'::regprocedure);
  if position('and o.expires_at is not null' in source)=0 then raise exception 'Unexpected order expiry definition'; end if;
  source:=replace(source,'and o.expires_at is not null','and o.checkout_mode=''whatsapp'' and o.expires_at is not null');
  execute source;
end $migration$;

-- New security-definer APIs are allowlisted explicitly. No credentials, receipt
-- table, stock primitive or bypass wrapper is exposed through PostgREST.
revoke all on function private.guard_provider_payment_method(),private.guard_online_checkout_activation(),
  private.create_commerce_order(jsonb,text,text,text),private.lock_online_attempt(uuid),private.online_stock_operation(uuid,text),
  private.release_paid_order(uuid),private.online_order_integrity(),private.claim_order_before_online(uuid),private.complete_order_before_online(uuid),private.cancel_order_before_online(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.save_payment_account(uuid,text,text,timestamptz,boolean),public.get_payment_account(uuid,text),
  public.disconnect_payment_account(uuid),public.acquire_payment_account_refresh(uuid,timestamptz),public.save_payment_oauth_state(text,text),
  public.consume_payment_oauth_state(text),public.begin_online_checkout(jsonb,text,text,text,text),
  public.set_online_checkout_preference(uuid,text,text,uuid),public.get_online_payment_attempt(uuid),public.get_online_checkout_status(uuid,text),
  public.reconcile_online_payment(uuid,text,text,bigint,text,timestamptz,jsonb),public.list_online_reconciliation(integer),
  public.expire_online_reservations(timestamptz,integer),public.mark_online_reconciled(uuid),public.get_payment_connection(uuid),public.create_order_transaction(jsonb,text,text,text),
  public.claim_order(uuid),public.complete_order(uuid),public.cancel_order(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.save_payment_account(uuid,text,text,timestamptz,boolean),public.get_payment_account(uuid,text),
  public.disconnect_payment_account(uuid),public.acquire_payment_account_refresh(uuid,timestamptz),public.save_payment_oauth_state(text,text),
  public.consume_payment_oauth_state(text),public.begin_online_checkout(jsonb,text,text,text,text),
  public.set_online_checkout_preference(uuid,text,text,uuid),public.get_online_payment_attempt(uuid),public.get_online_checkout_status(uuid,text),
  public.reconcile_online_payment(uuid,text,text,bigint,text,timestamptz,jsonb),public.list_online_reconciliation(integer),
  public.expire_online_reservations(timestamptz,integer),public.mark_online_reconciled(uuid),public.create_order_transaction(jsonb,text,text,text) to service_role;
grant execute on function public.get_payment_connection(uuid),public.claim_order(uuid),public.complete_order(uuid),public.cancel_order(uuid,text) to authenticated;
