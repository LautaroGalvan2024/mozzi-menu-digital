-- Orders preserve immutable monetary/catalogue snapshots. Public clients never receive table grants.
create table public.orders (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete restrict,
  action_id uuid not null default extensions.gen_random_uuid() unique,
  display_number text not null check (char_length(display_number) between 3 and 40),
  idempotency_key uuid not null,
  status public.order_status not null default 'generated',
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 120),
  customer_phone text not null check (char_length(customer_phone) between 8 and 32),
  fulfillment_type public.fulfillment_type not null,
  delivery_zone_id uuid,
  delivery_address text check (delivery_address is null or char_length(delivery_address) between 1 and 240),
  delivery_city text check (delivery_city is null or char_length(delivery_city) <= 120),
  delivery_neighborhood text check (delivery_neighborhood is null or char_length(delivery_neighborhood) <= 120),
  delivery_floor text check (delivery_floor is null or char_length(delivery_floor) <= 40),
  delivery_apartment text check (delivery_apartment is null or char_length(delivery_apartment) <= 40),
  delivery_reference text check (delivery_reference is null or char_length(delivery_reference) <= 240),
  customer_notes text check (customer_notes is null or char_length(customer_notes) <= 1000),
  payment_method_id uuid not null,
  payment_method_name_snapshot text not null check (char_length(payment_method_name_snapshot) between 1 and 120),
  payment_adjustment_type_snapshot public.payment_adjustment_type not null,
  payment_adjustment_scope_snapshot public.payment_adjustment_scope not null,
  payment_adjustment_bps_snapshot integer not null check (payment_adjustment_bps_snapshot between 0 and 50000),
  payment_adjustment_fixed_cents_snapshot bigint not null check (payment_adjustment_fixed_cents_snapshot >= 0),
  payment_transfer_alias_snapshot text,
  payment_account_holder_snapshot text,
  payment_bank_name_snapshot text,
  payment_instructions_snapshot text,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  surcharge_cents bigint not null default 0 check (surcharge_cents >= 0),
  delivery_fee_cents bigint not null default 0 check (delivery_fee_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  whatsapp_opened_at timestamptz,
  accepted_by uuid references auth.users (id) on delete restrict,
  accepted_at timestamptz,
  completed_by uuid references auth.users (id) on delete restrict,
  completed_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete restrict,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(btrim(cancel_reason)) between 3 and 500),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, idempotency_key),
  unique (restaurant_id, display_number),
  unique (id, restaurant_id),
  foreign key (delivery_zone_id, restaurant_id)
    references public.delivery_zones (id, restaurant_id) on delete restrict,
  foreign key (payment_method_id, restaurant_id)
    references public.payment_methods (id, restaurant_id) on delete restrict,
  check (
    (fulfillment_type = 'delivery' and delivery_zone_id is not null and delivery_address is not null)
    or (fulfillment_type = 'pickup' and delivery_zone_id is null)
  ),
  check (total_cents = subtotal_cents - discount_cents + surcharge_cents + delivery_fee_cents),
  check ((accepted_by is null) = (accepted_at is null)),
  check ((completed_by is null) = (completed_at is null)),
  check ((cancelled_by is null) = (cancelled_at is null)),
  check ((cancelled_at is null and cancel_reason is null) or (cancelled_at is not null and cancel_reason is not null))
);

create index orders_restaurant_created_idx on public.orders (restaurant_id, created_at desc);
create index orders_restaurant_status_created_idx on public.orders (restaurant_id, status, created_at desc);
create index orders_action_restaurant_idx on public.orders (action_id, restaurant_id);
create index orders_expiry_idx on public.orders (expires_at)
  where status in ('generated', 'whatsapp_opened') and expires_at is not null;
create index orders_accepted_by_idx on public.orders (restaurant_id, accepted_by, accepted_at desc)
  where accepted_by is not null;

create table public.order_items (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete restrict,
  order_id uuid not null,
  product_id uuid,
  product_code_snapshot text not null check (char_length(product_code_snapshot) between 1 and 80),
  product_name_snapshot text not null check (char_length(product_name_snapshot) between 1 and 160),
  quantity integer not null check (quantity between 1 and 50),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  options_total_unit_cents bigint not null default 0 check (options_total_unit_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  unique (id, restaurant_id),
  foreign key (order_id, restaurant_id)
    references public.orders (id, restaurant_id) on delete restrict,
  foreign key (product_id, restaurant_id)
    references public.products (id, restaurant_id) on delete restrict,
  check (line_total_cents = (unit_price_cents + options_total_unit_cents) * quantity)
);

create index order_items_order_idx on public.order_items (order_id, created_at, id);

create table public.order_item_options (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete restrict,
  order_item_id uuid not null,
  product_option_id uuid,
  group_name_snapshot text not null check (char_length(group_name_snapshot) between 1 and 120),
  option_name_snapshot text not null check (char_length(option_name_snapshot) between 1 and 120),
  price_delta_cents bigint not null check (price_delta_cents >= 0),
  created_at timestamptz not null default now(),
  foreign key (order_item_id, restaurant_id)
    references public.order_items (id, restaurant_id) on delete restrict,
  foreign key (product_option_id, restaurant_id)
    references public.product_options (id, restaurant_id) on delete restrict
);

create index order_item_options_item_idx on public.order_item_options (order_item_id, created_at, id);

create table public.order_events (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete restrict,
  order_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 80),
  from_status public.order_status,
  to_status public.order_status,
  actor_type public.order_actor_type not null,
  actor_user_id uuid references auth.users (id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (order_id, restaurant_id)
    references public.orders (id, restaurant_id) on delete restrict
);

create index order_events_order_created_idx on public.order_events (order_id, created_at, id);
create index order_events_restaurant_created_idx on public.order_events (restaurant_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid references public.restaurants (id) on delete restrict,
  actor_user_id uuid references auth.users (id) on delete restrict,
  action public.audit_action not null,
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  check (before_data is null or jsonb_typeof(before_data) = 'object'),
  check (after_data is null or jsonb_typeof(after_data) = 'object')
);

create index audit_logs_restaurant_created_idx on public.audit_logs (restaurant_id, created_at desc);
create index audit_logs_actor_created_idx on public.audit_logs (actor_user_id, created_at desc);

create table private.order_client_event_tokens (
  order_id uuid primary key references public.orders (id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table private.rate_limits (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (key_hash, restaurant_id, window_start)
);

create index rate_limits_cleanup_idx on private.rate_limits (window_start);

create table private.operation_idempotency (
  operation text not null check (char_length(operation) between 1 and 80),
  idempotency_key uuid not null,
  actor_user_id uuid references auth.users (id) on delete restrict,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (operation, idempotency_key)
);

revoke all on all tables in schema private from public, anon, authenticated;
