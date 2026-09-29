-- Opening hours, fulfilment/payment configuration and public-image metadata.
create table public.business_hours (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  slot_index smallint not null check (slot_index between 0 and 20),
  opens_at time not null,
  closes_at time not null,
  spans_next_day boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, day_of_week, slot_index),
  unique (id, restaurant_id),
  check (opens_at <> closes_at),
  check ((spans_next_day and closes_at < opens_at) or (not spans_next_day and closes_at > opens_at))
);

create index business_hours_lookup_idx
  on public.business_hours (restaurant_id, day_of_week, active, opens_at, closes_at);

create table public.special_hours (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  date date not null,
  is_closed boolean not null default false,
  slot_index smallint not null default 0 check (slot_index between 0 and 20),
  opens_at time,
  closes_at time,
  spans_next_day boolean not null default false,
  reason text check (reason is null or char_length(reason) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, date, slot_index),
  unique (id, restaurant_id),
  check (
    (is_closed and opens_at is null and closes_at is null and not spans_next_day)
    or
    (not is_closed and opens_at is not null and closes_at is not null and opens_at <> closes_at)
  ),
  check (
    is_closed
    or (spans_next_day and closes_at < opens_at)
    or (not spans_next_day and closes_at > opens_at)
  )
);

create index special_hours_lookup_idx
  on public.special_hours (restaurant_id, date, slot_index);

create table public.payment_methods (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  code text not null check (char_length(btrim(code)) between 1 and 50),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  active boolean not null default true,
  adjustment_type public.payment_adjustment_type not null default 'none',
  adjustment_scope public.payment_adjustment_scope not null default 'subtotal',
  adjustment_bps integer not null default 0 check (adjustment_bps between 0 and 50000),
  adjustment_fixed_cents bigint not null default 0 check (adjustment_fixed_cents between 0 and 1000000000000),
  transfer_alias text check (transfer_alias is null or char_length(transfer_alias) <= 120),
  account_holder text check (account_holder is null or char_length(account_holder) <= 160),
  bank_name text check (bank_name is null or char_length(bank_name) <= 160),
  instructions text check (instructions is null or char_length(instructions) <= 1000),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  check (
    (adjustment_type = 'none' and adjustment_bps = 0 and adjustment_fixed_cents = 0)
    or adjustment_type <> 'none'
  )
);

create unique index payment_methods_restaurant_code_uidx
  on public.payment_methods (restaurant_id, lower(code));
create index payment_methods_public_order_idx
  on public.payment_methods (restaurant_id, sort_order, name)
  where active;

create table public.delivery_zones (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  delivery_fee_cents bigint not null default 0 check (delivery_fee_cents between 0 and 1000000000000),
  minimum_order_cents bigint not null default 0 check (minimum_order_cents between 0 and 1000000000000),
  free_shipping_from_cents bigint check (free_shipping_from_cents between 0 and 1000000000000),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id)
);

create index delivery_zones_public_order_idx
  on public.delivery_zones (restaurant_id, sort_order, name)
  where active;

create table public.restaurant_order_counters (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  next_value bigint not null default 1 check (next_value > 0),
  updated_at timestamptz not null default now()
);

create table public.image_assets (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  entity_type text not null check (entity_type in ('restaurant_logo', 'restaurant_cover', 'category', 'product', 'promotion')),
  entity_id uuid,
  bucket text not null default 'restaurant-assets' check (bucket = 'restaurant-assets'),
  path text not null check (char_length(path) between 10 and 500),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 1048576),
  width integer not null check (width between 1 and 1200),
  height integer not null check (height between 1 and 1200),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (bucket, path),
  unique (id, restaurant_id),
  check (path like 'restaurants/' || restaurant_id::text || '/%')
);

create index image_assets_restaurant_entity_idx
  on public.image_assets (restaurant_id, entity_type, entity_id)
  where deleted_at is null;
