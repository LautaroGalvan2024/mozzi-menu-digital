-- Tenant-scoped catalogue with composite foreign keys that prevent cross-tenant references.
create table public.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (
    char_length(slug) between 1 and 100
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  description text not null default '' check (char_length(description) <= 1000),
  image_path text check (image_path is null or char_length(image_path) <= 500),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  active boolean not null default true,
  deleted_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id)
);

create unique index categories_restaurant_slug_active_uidx
  on public.categories (restaurant_id, slug)
  where deleted_at is null;
create index categories_public_order_idx
  on public.categories (restaurant_id, sort_order, name)
  where deleted_at is null and active;

create table public.products (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_id uuid not null,
  code text not null check (char_length(btrim(code)) between 1 and 80),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  base_price_cents bigint not null check (base_price_cents between 0 and 1000000000000),
  promotional_price_cents bigint check (promotional_price_cents between 0 and 1000000000000),
  promotion_starts_at timestamptz,
  promotion_ends_at timestamptz,
  image_path text check (image_path is null or char_length(image_path) <= 500),
  active boolean not null default true,
  available boolean not null default true,
  featured boolean not null default false,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  deleted_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  foreign key (category_id, restaurant_id)
    references public.categories (id, restaurant_id) on delete restrict,
  check (
    promotion_starts_at is null
    or promotion_ends_at is null
    or promotion_ends_at > promotion_starts_at
  )
);

create unique index products_restaurant_code_active_uidx
  on public.products (restaurant_id, lower(code))
  where deleted_at is null;
create index products_public_order_idx
  on public.products (restaurant_id, category_id, featured desc, sort_order, name)
  where deleted_at is null and active;

create table public.product_option_groups (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  product_id uuid not null,
  code text check (code is null or char_length(btrim(code)) between 1 and 80),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  required boolean not null default false,
  min_select integer not null default 0 check (min_select between 0 and 50),
  max_select integer not null default 1 check (max_select between 0 and 50),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  foreign key (product_id, restaurant_id)
    references public.products (id, restaurant_id) on delete cascade,
  check (max_select >= min_select),
  check (not required or min_select >= 1)
);

create index product_option_groups_product_order_idx
  on public.product_option_groups (product_id, sort_order, name)
  where active;
create unique index product_option_groups_product_code_uidx
  on public.product_option_groups (product_id, lower(code))
  where code is not null;

create table public.product_options (
  id uuid primary key default extensions.gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  option_group_id uuid not null,
  code text check (code is null or char_length(btrim(code)) between 1 and 80),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  price_delta_cents bigint not null default 0 check (price_delta_cents between 0 and 1000000000000),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  foreign key (option_group_id, restaurant_id)
    references public.product_option_groups (id, restaurant_id) on delete cascade
);

create index product_options_group_order_idx
  on public.product_options (option_group_id, sort_order, name)
  where active;
create unique index product_options_group_code_uidx
  on public.product_options (option_group_id, lower(code))
  where code is not null;
