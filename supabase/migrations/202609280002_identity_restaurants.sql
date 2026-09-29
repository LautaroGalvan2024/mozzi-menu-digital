-- Identity projection, platform roles and the tenant root.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email text not null check (char_length(email) between 3 and 320),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_lower_uidx on public.profiles (lower(email));

create table public.platform_user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.platform_role not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.restaurants (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  trade_name text not null check (char_length(btrim(trade_name)) between 2 and 120),
  slug text not null unique check (
    char_length(slug) between 2 and 80
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  description text not null default '' check (char_length(description) <= 1200),
  status public.restaurant_status not null default 'draft',
  whatsapp_phone_e164 text not null check (whatsapp_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  address text not null default '' check (char_length(address) <= 240),
  city text not null default '' check (char_length(city) <= 120),
  timezone text not null default 'America/Argentina/Cordoba' check (char_length(timezone) between 3 and 64),
  currency_code text not null default 'ARS' check (currency_code ~ '^[A-Z]{3}$'),
  locale text not null default 'es-AR' check (locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  logo_path text check (logo_path is null or char_length(logo_path) <= 500),
  cover_path text check (cover_path is null or char_length(cover_path) <= 500),
  primary_color text not null default '#E85D2A' check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text not null default '#1F2937' check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  delivery_enabled boolean not null default true,
  pickup_enabled boolean not null default true,
  minimum_order_cents bigint not null default 0 check (minimum_order_cents >= 0),
  default_preparation_minutes integer not null default 30 check (default_preparation_minutes between 1 and 1440),
  order_prefix text not null check (order_prefix ~ '^[A-Z0-9]{2,8}$'),
  public_menu_enabled boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, slug)
);

create table public.restaurant_members (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.restaurant_role not null,
  status public.membership_status not null default 'invited',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, user_id),
  unique (id, restaurant_id)
);

create index restaurant_members_user_status_idx
  on public.restaurant_members (user_id, status, restaurant_id, role);

create index restaurant_members_restaurant_role_idx
  on public.restaurant_members (restaurant_id, role, status);

comment on table public.profiles is 'Private profile projection; anonymous users receive no table privileges.';
comment on column public.restaurants.order_prefix is 'Short non-secret prefix used only in human-readable display numbers.';
