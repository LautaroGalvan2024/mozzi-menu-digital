begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Acceptance fixtures for the catalogue sizes supported by the UI. Set-based
-- inserts also exercise the statement-level revision triggers used by imports.
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data)
values ('1c230000-0000-4000-8000-000000000001', 'catalog-scale@example.test', now(), '{}');

create temporary table scale_fixtures(
  product_count integer primary key,
  restaurant_id uuid not null,
  category_id uuid not null,
  slug text not null unique
);

insert into scale_fixtures(product_count, restaurant_id, category_id, slug)
select
  fixture_size,
  md5('scale-restaurant:' || fixture_size)::uuid,
  md5('scale-category:' || fixture_size)::uuid,
  'catalog-scale-' || fixture_size
from unnest(array[10, 500, 1500, 5000]) fixture(fixture_size);

insert into public.restaurants(
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
)
select
  restaurant_id,
  'Scale ' || product_count,
  'Scale ' || product_count,
  slug,
  'active',
  '+5491111111111',
  'Address',
  'City',
  'S' || product_count,
  true,
  '1c230000-0000-4000-8000-000000000001'
from scale_fixtures;

insert into public.categories(id, restaurant_id, name, slug, sort_order)
select category_id, restaurant_id, 'Products', 'products', 0
from scale_fixtures;

insert into public.products(
  id, restaurant_id, category_id, code, name, description, base_price_cents,
  featured, sort_order
)
select
  md5('scale-product:' || fixture.product_count || ':' || ordinal)::uuid,
  fixture.restaurant_id,
  fixture.category_id,
  'S' || lpad(ordinal::text, 5, '0'),
  'Scale product ' || lpad(ordinal::text, 5, '0'),
  'Synthetic catalogue fixture',
  1000 + ordinal,
  false,
  ordinal
from scale_fixtures fixture
cross join lateral generate_series(1, fixture.product_count) ordinal;

select is(
  (select count(*) from public.products product
    where product.restaurant_id = fixture.restaurant_id),
  fixture.product_count::bigint,
  'creates the ' || fixture.product_count || '-product catalogue fixture'
)
from scale_fixtures fixture
order by fixture.product_count;

-- The final item must be searchable without downloading preceding pages.
select is(
  jsonb_array_length(public.get_public_catalog_page(
    fixture.slug,
    'menu',
    null,
    'S' || lpad(fixture.product_count::text, 5, '0'),
    null,
    24
  ) -> 'items'),
  1,
  'server-side search covers all ' || fixture.product_count || ' products'
)
from scale_fixtures fixture
order by fixture.product_count;

create temporary table scale_catalog_pages as
with recursive pages(product_count, slug, page_number, document) as (
  select
    fixture.product_count,
    fixture.slug,
    1,
    public.get_public_catalog_page(fixture.slug, 'menu', null, null, null, 48)
  from scale_fixtures fixture

  union all

  select
    page.product_count,
    page.slug,
    page.page_number + 1,
    public.get_public_catalog_page(
      page.slug,
      'menu',
      null,
      null,
      (page.document ->> 'nextCursor')::uuid,
      48
    )
  from pages page
  where page.document ->> 'nextCursor' is not null
)
select * from pages;

select is(
  count(catalog_group.value),
  page.product_count::bigint,
  'cursor traversal reaches all ' || page.product_count || ' catalogue groups'
)
from scale_catalog_pages page
cross join lateral jsonb_array_elements(page.document -> 'items') catalog_group(value)
group by page.product_count
order by page.product_count;

select is(
  count(catalog_group.value),
  count(distinct catalog_group.value ->> 'id'),
  page.product_count || '-product cursor traversal contains no duplicates'
)
from scale_catalog_pages page
cross join lateral jsonb_array_elements(page.document -> 'items') catalog_group(value)
group by page.product_count
order by page.product_count;

select ok(
  max(jsonb_array_length(page.document -> 'items')) <= 48,
  page.product_count || '-product fixture respects the public page limit'
)
from scale_catalog_pages page
group by page.product_count
order by page.product_count;

select * from finish();
rollback;
