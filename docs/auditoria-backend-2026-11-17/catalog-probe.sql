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

update restaurants set store_enabled=true where id in(select restaurant_id from scale_fixtures);
analyze public.products; analyze public.categories; analyze public.restaurants;
create temp table audit_timings(size integer,method text,ms numeric,bytes integer);
do $$ declare f record; k text; j integer; started timestamptz; doc jsonb; begin
for f in select * from scale_fixtures order by product_count loop
foreach k in array array['meta','menu_page_24','store_page_24','legacy_full'] loop
for j in 0..5 loop
started:=clock_timestamp();
if k='meta' then doc:=public.get_public_catalog_meta(f.slug,'store');
elsif k='menu_page_24' then doc:=public.get_public_catalog_page(f.slug,'menu',null,null,null,24);
elsif k='store_page_24' then doc:=public.get_public_store_catalog_page(f.slug,'all',null,null,null,24);
else doc:=public.get_public_menu(f.slug); end if;
if j>0 then insert into audit_timings values(f.product_count,k,extract(epoch from clock_timestamp()-started)*1000,octet_length(doc::text)); end if;
end loop; end loop; end loop; end $$;
select json_agg(t) from(select size,method,round(avg(ms),2) mean_ms,round(max(ms),2) max_ms,max(bytes) response_bytes from audit_timings group by size,method order by size,method)t;
rollback;