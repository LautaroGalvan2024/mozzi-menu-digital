begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.store_id(p_number integer) returns uuid
language sql immutable as $$
  select ('26260000-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data)
values (pg_temp.store_id(1), 'store-merchandising@example.test', now(), '{}');

insert into restaurants(
  id, name, trade_name, slug, status, whatsapp_phone_e164, order_prefix,
  store_enabled, public_menu_enabled
) values
  (pg_temp.store_id(2), 'Store merchandising', 'Store merchandising',
   'store-merchandising', 'active', '+5491111111111', 'SME', true, true),
  (pg_temp.store_id(3), 'Hidden store', 'Hidden store',
   'hidden-store-merchandising', 'active', '+5491111111111', 'HSM', false, true);

insert into categories(id, restaurant_id, name, slug, sort_order, icon_key) values
  (pg_temp.store_id(10), pg_temp.store_id(2), 'Almacén', 'almacen', 0, null),
  (pg_temp.store_id(11), pg_temp.store_id(2), 'Bebidas', 'bebidas', 1, 'drinks');

insert into product_families(
  id, restaurant_id, category_id, code, name, description, axes
) values (
  pg_temp.store_id(50), pg_temp.store_id(2), pg_temp.store_id(10),
  'FAMILY', 'Family offer', 'Two variants', array['Color']
);

insert into products(
  id, restaurant_id, category_id, code, name, description,
  base_price_cents, promotional_price_cents, promotion_starts_at,
  promotion_ends_at, available, featured, sort_order, family_id,
  variant_attributes, quantity_threshold_minimum,
  quantity_threshold_unit_price_cents
) values
  (pg_temp.store_id(100), pg_temp.store_id(2), pg_temp.store_id(10),
   'NORMAL', 'Normal featured', '', 1000, null, null, null,
   true, true, 0, null, '{}', null, null),
  (pg_temp.store_id(101), pg_temp.store_id(2), pg_temp.store_id(10),
   'UNAVAILABLE', 'Unavailable featured', '', 1000, null, null, null,
   false, true, 1, null, '{}', null, null),
  (pg_temp.store_id(102), pg_temp.store_id(2), pg_temp.store_id(10),
   'PROMO', 'Active promotion', '', 1200, 900, now() - interval '1 hour',
   now() + interval '2 hours', true, false, 2, null, '{}', null, null),
  (pg_temp.store_id(103), pg_temp.store_id(2), pg_temp.store_id(10),
   'PACK', 'Quantity pack', '', 700, null, null, null,
   true, false, 3, null, '{}', null, null),
  (pg_temp.store_id(104), pg_temp.store_id(2), pg_temp.store_id(11),
   'THRESHOLD', 'Threshold saving', '', 500, null, null, null,
   true, false, 0, null, '{}', 6, 400),
  (pg_temp.store_id(105), pg_temp.store_id(2), pg_temp.store_id(11),
   'NO-SAVING', 'No saving pack', '', 500, null, null, null,
   true, false, 1, null, '{}', null, null),
  (pg_temp.store_id(106), pg_temp.store_id(2), pg_temp.store_id(11),
   'FUTURE', 'Future promotion', '', 1000, 800, now() + interval '1 hour',
   now() + interval '3 hours', true, false, 2, null, '{}', null, null),
  (pg_temp.store_id(107), pg_temp.store_id(2), pg_temp.store_id(11),
   'EXPIRED', 'Expired promotion', '', 1000, 800, now() - interval '3 hours',
   now() - interval '1 hour', true, false, 3, null, '{}', null, null),
  (pg_temp.store_id(108), pg_temp.store_id(2), pg_temp.store_id(10),
   'FAMILY-RED', 'Family red', '', 1000, 700, now() - interval '1 hour',
   now() + interval '4 hours', false, true, 4, pg_temp.store_id(50),
   '{"Color":"Red"}', null, null),
  (pg_temp.store_id(109), pg_temp.store_id(2), pg_temp.store_id(10),
   'FAMILY-BLUE', 'Family blue', '', 1000, null, null, null,
   true, false, 5, pg_temp.store_id(50), '{"Color":"Blue"}', null, null),
  (pg_temp.store_id(110), pg_temp.store_id(2), pg_temp.store_id(11),
   'OUT-OF-STOCK', 'Out of stock promotion', '', 1000, 600,
   now() - interval '1 hour', now() + interval '5 hours',
   true, false, 4, null, '{}', null, null);

insert into product_quantity_prices(
  id, restaurant_id, product_id, quantity, total_price_cents
) values
  (pg_temp.store_id(200), pg_temp.store_id(2), pg_temp.store_id(103), 3, 1800),
  (pg_temp.store_id(201), pg_temp.store_id(2), pg_temp.store_id(105), 3, 1500);

update restaurants
set inventory_mode = 'enforced', inventory_activated_at = now()
where id = pg_temp.store_id(2);
insert into inventory_balances(restaurant_id, product_id, on_hand, reserved)
values (pg_temp.store_id(2), pg_temp.store_id(110), 0, 0);

select is(
  public.get_public_store_catalog_page('hidden-store-merchandising'),
  null::jsonb,
  'an unpublished store has no merchandising oracle'
);
select has_column(
  'public', 'categories', 'icon_key',
  'categories persist an optional storefront icon choice'
);
select throws_ok(
  $$update public.categories set icon_key = 'unsupported-icon' where id = pg_temp.store_id(11)$$,
  '23514',
  'new row for relation "categories" violates check constraint "categories_icon_key_check"',
  'the database rejects category icons outside the shared allowlist'
);
select is(
  public.get_public_store_catalog_page('store-merchandising')
    #>> array['categoryIcons', pg_temp.store_id(11)::text],
  'drinks',
  'the store catalogue exposes explicit category icons by category ID'
);
select is(
  public.get_public_store_catalog_page('store-merchandising')
    -> 'categoryIcons' ? pg_temp.store_id(10)::text,
  false,
  'automatic category icons stay absent so clients can infer them from the name'
);
select throws_ok(
  $$select public.get_public_store_catalog_page('store-merchandising', 'popular')$$,
  '22023', 'STORE_CATALOG_SECTION_INVALID',
  'only reviewed merchandising sections are accepted'
);
select throws_ok(
  $$select public.get_public_store_catalog_page('store-merchandising', 'all', null, null, null, 49)$$,
  '22023', 'CATALOG_LIMIT_INVALID',
  'store pagination preserves the public page limit'
);
select throws_ok(
  $$select public.get_public_store_catalog_page('store-merchandising', 'all', '26260000-0000-4000-8000-000000000999')$$,
  '22023', 'CATALOG_CATEGORY_INVALID',
  'a category from outside the published catalogue is rejected'
);

create temporary table store_pages as
select public.get_public_store_catalog_page(
  'store-merchandising', 'offers', null, null, null, 1
) first_offer;

select is(
  jsonb_array_length((select first_offer -> 'items' from store_pages)),
  1,
  'a merchandising section obeys its bounded page size'
);
select is(
  jsonb_typeof((select first_offer -> 'nextCursor' from store_pages)),
  'object',
  'the next cursor is an opaque structured value'
);
select ok(
  (select (first_offer ->> 'serverNow')::timestamptz
    < (first_offer ->> 'validUntil')::timestamptz from store_pages),
  'the response exposes a server clock and a future validity boundary'
);
select is(
  (select (first_offer ->> 'validUntil')::timestamptz from store_pages),
  (select promotion_starts_at from products where id = pg_temp.store_id(106)),
  'the next future promotion start bounds every cached section'
);

select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, null,
    (select first_offer -> 'nextCursor' from store_pages), 24
  ) -> 'items'),
  2,
  'the offers cursor reaches savings beyond the first result'
);
create temporary table store_offer_page_two as
select public.get_public_store_catalog_page(
  'store-merchandising', 'offers', null, null,
  (select first_offer -> 'nextCursor' from store_pages), 24
) second_offer;
select is(
  (select count(*)::integer
   from jsonb_array_elements((select first_offer -> 'items' from store_pages)) first_item
   join jsonb_array_elements((select second_offer -> 'items' from store_offer_page_two)) second_item
     on first_item ->> 'id' = second_item ->> 'id'),
  0,
  'successive offer pages never repeat a product group'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, 'Future promotion', null, 24
  ) -> 'items'),
  0,
  'a promotion is not offered before its inclusive start'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, 'Expired promotion', null, 24
  ) -> 'items'),
  0,
  'a promotion is not offered at or after its exclusive end'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, 'Family offer', null, 24
  ) -> 'items'),
  0,
  'an offer that exists only on an unavailable variant is excluded'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, 'No saving pack', null, 24
  ) -> 'items'),
  0,
  'a quantity rule without a real saving is not marketed as an offer'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, 'Out of stock promotion', null, 24
  ) -> 'items'),
  0,
  'the offers section uses the effective inventory availability rule'
);
select is(
  public.get_public_catalog_group(
    'store-merchandising', 'store', pg_temp.store_id(110)
  ) #>> '{group,variants,0,available}',
  'false',
  'the store section and shared public projection agree on availability'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'offers', pg_temp.store_id(11), 'Threshold', null, 24
  ) -> 'items'),
  1,
  'section, category and search filters are applied before pagination'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'featured', null, 'Family offer', null, 24
  ) -> 'items'),
  1,
  'a featured family remains discoverable while another variant is purchasable'
);
select is(
  jsonb_array_length(public.get_public_store_catalog_page(
    'store-merchandising', 'featured', null, 'Unavailable featured', null, 24
  ) -> 'items'),
  0,
  'an entirely unavailable featured group is omitted from merchandising'
);

select throws_ok(
  $$select public.get_public_store_catalog_page(
    'store-merchandising', 'featured', null, null,
    (select first_offer -> 'nextCursor' from store_pages), 24
  )$$,
  '22023', 'CATALOG_CURSOR_STALE',
  'a cursor cannot be reused with another section scope'
);

update products set description = description || ' revision changed'
where id = pg_temp.store_id(100);
select throws_ok(
  $$select public.get_public_store_catalog_page(
    'store-merchandising', 'offers', null, null,
    (select first_offer -> 'nextCursor' from store_pages), 24
  )$$,
  '22023', 'CATALOG_CURSOR_STALE',
  'a cursor cannot cross a catalogue revision'
);
select throws_ok(
  $$select public.get_public_store_catalog_page(
    'store-merchandising', 'all', null, null, '{"revision":"bad"}'::jsonb, 24
  )$$,
  '22023', 'CATALOG_CURSOR_INVALID',
  'a malformed opaque cursor is rejected without leaking details'
);

-- The only state transition after this cursor is issued is the passage of
-- server time across a promotion boundary; no row changes in between.
update products
set promotion_starts_at = statement_timestamp() + interval '250 milliseconds',
    promotion_ends_at = statement_timestamp() + interval '2 hours'
where id = pg_temp.store_id(106);
create temporary table expiring_store_cursor as
select public.get_public_store_catalog_page(
  'store-merchandising', 'all', null, null, null, 1
) first_page;
select pg_sleep(0.35);
select throws_ok(
  $$select public.get_public_store_catalog_page(
    'store-merchandising', 'all', null, null,
    (select first_page -> 'nextCursor' from expiring_store_cursor), 24
  )$$,
  '22023', 'CATALOG_CURSOR_STALE',
  'a promotion boundary expires a cursor without another catalogue revision'
);

select is(
  public.get_public_catalog_page(
    'store-merchandising', 'store', null, 'Normal featured', null, 24
  ) #>> '{items,0,variants,0,name}',
  'Normal featured',
  'the existing channel catalogue RPC remains unchanged'
);
select ok(
  has_function_privilege(
    'anon',
    'public.get_public_store_catalog_page(text,text,uuid,text,jsonb,integer)',
    'execute'
  ),
  'anonymous clients can execute the curated store RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_public_store_catalog_page(text,text,uuid,text,jsonb,integer)',
    'execute'
  ),
  'authenticated previews use the same curated store RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.get_public_store_catalog_page(text,text,uuid,text,jsonb,integer)',
    'execute'
  ),
  'service operations can execute the curated store RPC'
);

select * from finish();
rollback;
