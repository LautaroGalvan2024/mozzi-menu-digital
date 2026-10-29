begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('1b220000-0000-4000-8000-000000000001', 'revision-admin@example.test', now(), '{}'),
  ('1b220000-0000-4000-8000-000000000002', 'revision-other@example.test', now(), '{}');

insert into public.restaurants(
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('2b220000-0000-4000-8000-000000000001', 'Revision menu', 'Revision menu',
   'revision-menu', 'active', '+5491111111111', 'Address', 'City', 'RVA', true,
   '1b220000-0000-4000-8000-000000000001'),
  ('2b220000-0000-4000-8000-000000000002', 'Hidden menu', 'Hidden menu',
   'revision-hidden', 'active', '+5492222222222', 'Address', 'City', 'RVB', false,
   '1b220000-0000-4000-8000-000000000002');

insert into public.restaurant_members(restaurant_id, user_id, role, status, invited_by) values
  ('2b220000-0000-4000-8000-000000000001', '1b220000-0000-4000-8000-000000000001',
   'restaurant_admin', 'active', '1b220000-0000-4000-8000-000000000001'),
  ('2b220000-0000-4000-8000-000000000002', '1b220000-0000-4000-8000-000000000002',
   'restaurant_admin', 'active', '1b220000-0000-4000-8000-000000000002');

insert into public.categories(id, restaurant_id, name, slug, sort_order) values
  ('3b220000-0000-4000-8000-000000000001', '2b220000-0000-4000-8000-000000000001',
   'Cases', 'cases', 0),
  ('3b220000-0000-4000-8000-000000000002', '2b220000-0000-4000-8000-000000000001',
   'Extras', 'extras', 1),
  ('3b220000-0000-4000-8000-000000000003', '2b220000-0000-4000-8000-000000000002',
   'Hidden', 'hidden', 0);

insert into public.product_families(
  id, restaurant_id, category_id, code, name, description, axes, active
) values (
  '5b220000-0000-4000-8000-000000000001',
  '2b220000-0000-4000-8000-000000000001',
  '3b220000-0000-4000-8000-000000000001',
  'FAMILY', 'Family case', 'Grouped variants', array['Color'], true
);

insert into public.products(
  id, restaurant_id, category_id, code, name, description, base_price_cents,
  featured, sort_order, family_id, variant_attributes
) values
  ('4b220000-0000-4000-8000-000000000001', '2b220000-0000-4000-8000-000000000001',
   '3b220000-0000-4000-8000-000000000001', 'FAM-B', 'Family black', 'Black case', 1000,
   true, 0, '5b220000-0000-4000-8000-000000000001', '{"Color":"Black"}'),
  ('4b220000-0000-4000-8000-000000000002', '2b220000-0000-4000-8000-000000000001',
   '3b220000-0000-4000-8000-000000000001', 'FAM-R', 'Family red', 'Red case', 1200,
   false, 1, '5b220000-0000-4000-8000-000000000001', '{"Color":"Crimson"}'),
  ('4b220000-0000-4000-8000-000000000003', '2b220000-0000-4000-8000-000000000001',
   '3b220000-0000-4000-8000-000000000001', 'SIMPLE-A', 'Simple alpha', 'First simple', 800,
   false, 2, null, '{}'),
  ('4b220000-0000-4000-8000-000000000004', '2b220000-0000-4000-8000-000000000001',
   '3b220000-0000-4000-8000-000000000002', 'SIMPLE-B', 'Simple beta', 'Second simple', 900,
   false, 3, null, '{}'),
  ('4b220000-0000-4000-8000-000000000005', '2b220000-0000-4000-8000-000000000001',
   '3b220000-0000-4000-8000-000000000002', 'SIMPLE-C', 'Simple gamma', 'Third simple', 950,
   false, 4, null, '{}'),
  ('4b220000-0000-4000-8000-000000000099', '2b220000-0000-4000-8000-000000000002',
   '3b220000-0000-4000-8000-000000000003', 'OTHER', 'Other tenant product', '', 500,
   false, 0, null, '{}');

insert into public.product_option_groups(
  id, restaurant_id, product_id, code, name, required, min_select, max_select
) values (
  '6b220000-0000-4000-8000-000000000001',
  '2b220000-0000-4000-8000-000000000001',
  '4b220000-0000-4000-8000-000000000003',
  'FINISH', 'Finish', false, 0, 1
);
insert into public.product_options(
  id, restaurant_id, option_group_id, code, name, price_delta_cents
) values (
  '6b220000-0000-4000-8000-000000000002',
  '2b220000-0000-4000-8000-000000000001',
  '6b220000-0000-4000-8000-000000000001',
  'MATTE', 'Matte', 100
);
insert into public.product_quantity_prices(
  id, restaurant_id, product_id, quantity, total_price_cents
) values (
  '6b220000-0000-4000-8000-000000000003',
  '2b220000-0000-4000-8000-000000000001',
  '4b220000-0000-4000-8000-000000000003', 2, 1500
);

insert into public.inventory_balances(restaurant_id, product_id, on_hand, reserved) values
  ('2b220000-0000-4000-8000-000000000001', '4b220000-0000-4000-8000-000000000001', 5, 1),
  ('2b220000-0000-4000-8000-000000000001', '4b220000-0000-4000-8000-000000000003', 7, 0);
insert into public.payment_methods(id, restaurant_id, code, name) values
  ('7b220000-0000-4000-8000-000000000001', '2b220000-0000-4000-8000-000000000001', 'cash', 'Cash');
insert into public.business_hours(restaurant_id, day_of_week, slot_index, opens_at, closes_at)
select '2b220000-0000-4000-8000-000000000001', day_number, 0, '00:00'::time, '23:59'::time
from generate_series(0, 6) day_number;

select ok(
  (public.get_public_catalog_revision('revision-menu') ->> 'revision')::bigint > 0,
  'published tenant has a seeded positive revision'
);
select is(
  public.get_public_catalog_revision('revision-hidden'), null::jsonb,
  'unpublished tenant has no anonymous revision oracle'
);
select ok(
  not (public.get_public_catalog_meta('revision-menu') #> '{categories,0}' ? 'products'),
  'metadata does not embed products'
);
select is(
  public.get_public_catalog_meta('revision-menu') #>> '{paymentMethods,0,provider}', null::text,
  'metadata keeps the provider field nullable for manual methods'
);

create temporary table revision_checkpoint as
select revision, updated_at from private.catalog_revisions
where restaurant_id = '2b220000-0000-4000-8000-000000000001';
update public.products
set description = description || ' changed'
where id in (
  '4b220000-0000-4000-8000-000000000003',
  '4b220000-0000-4000-8000-000000000004'
);
select is(
  (select revision from private.catalog_revisions where restaurant_id = '2b220000-0000-4000-8000-000000000001'),
  (select revision + 1 from revision_checkpoint),
  'multi-row statement advances the tenant revision exactly once'
);
select ok(
  (select updated_at from private.catalog_revisions where restaurant_id = '2b220000-0000-4000-8000-000000000001')
    > (select updated_at from revision_checkpoint),
  'revision timestamp advances with the monotonic value'
);

create temporary table public_pages(first_page jsonb, second_page jsonb);
insert into public_pages(first_page)
values (public.get_public_catalog_page('revision-menu', 'menu', null, null, null, 2));
update public_pages
set second_page = public.get_public_catalog_page(
  'revision-menu', 'menu', null, null, (first_page ->> 'nextCursor')::uuid, 2
);
select is(
  jsonb_array_length((select first_page -> 'items' from public_pages)), 2,
  'first public page obeys its bounded limit'
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements((select first_page -> 'items' from public_pages)) first_group(value)
    join jsonb_array_elements((select second_page -> 'items' from public_pages)) second_group(value)
      on first_group.value ->> 'id' = second_group.value ->> 'id'
  ),
  'cursor pages contain no duplicate groups'
);
select is(
  jsonb_array_length(
    public.get_public_catalog_group(
      'revision-menu', 'menu', '4b220000-0000-4000-8000-000000000001'
    ) #> '{group,variants}'
  ),
  2,
  'direct detail accepts a variant id and resolves its complete family'
);
select is(
  jsonb_array_length(public.get_public_catalog_page(
    'revision-menu', 'menu', null, 'Crimson', null, 24
  ) -> 'items'),
  1,
  'server-side search finds variant attributes without loading the full catalogue'
);
select is(
  jsonb_array_length(public.get_public_products_by_ids(
    'revision-menu', 'menu', array['4b220000-0000-4000-8000-000000000002'::uuid]
  ) -> 'products'),
  1,
  'cart reconciliation returns only requested variants'
);
select is(
  public.get_public_products_by_ids(
    'revision-menu', 'menu', array['4b220000-0000-4000-8000-000000000003'::uuid]
  ) #>> '{products,0,quantityPrices,0,totalPriceCents}',
  '1500',
  'set-based product projection includes quantity offers'
);
select is(
  public.get_public_products_by_ids(
    'revision-menu', 'menu', array['4b220000-0000-4000-8000-000000000003'::uuid]
  ) #>> '{products,0,optionGroups,0,options,0,name}',
  'Matte',
  'set-based product projection includes nested options'
);
select is(
  jsonb_array_length(public.get_public_menu('revision-menu') #> '{categories,0,products}'),
  3,
  'legacy menu contract remains a flat product array per category'
);
select is(
  public.get_public_catalog('revision-menu', 'menu') #>> '{restaurant,channel}',
  'menu',
  'legacy channel-aware catalogue remains available'
);
select throws_ok(
  $$select public.get_public_catalog_page('revision-menu', 'menu', null, null, null, 49)$$,
  '22023', 'CATALOG_LIMIT_INVALID',
  'public page enforces its maximum limit'
);

select ok(
  has_function_privilege('anon', 'public.get_public_catalog_page(text,text,uuid,text,uuid,integer)', 'execute'),
  'anonymous role can execute the curated page RPC'
);
select ok(
  not has_function_privilege('anon', 'public.list_catalog_products(uuid,text,uuid,boolean,integer,uuid,integer)', 'execute'),
  'anonymous role cannot execute the administrative list'
);
select ok(
  not has_table_privilege('authenticated', 'private.catalog_revisions', 'select')
  and not has_function_privilege('authenticated', 'private.public_catalog_groups(uuid,uuid[])', 'execute'),
  'revision state and projection helper stay private'
);

select set_config('request.jwt.claim.sub', '1b220000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims',
  '{"sub":"1b220000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  jsonb_array_length(public.list_catalog_products(
    '2b220000-0000-4000-8000-000000000001', null,
    '5b220000-0000-4000-8000-000000000001', false, null, null, 50
  ) -> 'items'),
  2,
  'administrative list pages one family variants only'
);
select is(
  jsonb_array_length(public.list_catalog_products(
    '2b220000-0000-4000-8000-000000000001', 'simple',
    null, true, null, null, 2
  ) -> 'items'),
  2,
  'unassigned candidate search is independently paginated'
);
select ok(
  public.list_catalog_products(
    '2b220000-0000-4000-8000-000000000001', 'simple',
    null, true, null, null, 2
  ) -> 'nextCursor' is not null,
  'administrative page returns a stable composite cursor'
);
select throws_ok(
  $$select public.list_catalog_products(
    '2b220000-0000-4000-8000-000000000001', null,
    '5b220000-0000-4000-8000-000000000001', true, null, null, 50
  )$$,
  '22023', 'CATALOG_FILTER_INVALID',
  'family and unassigned filters cannot be combined ambiguously'
);
select is(
  jsonb_array_length(public.get_inventory_items(
    '2b220000-0000-4000-8000-000000000001', null, 2, null
  ) -> 'items'),
  2,
  'inventory item endpoint is independently paginated'
);
select ok(
  not (public.get_inventory_items(
    '2b220000-0000-4000-8000-000000000001', null, 2, null
  ) ? 'operations'),
  'inventory item pages do not repeat history'
);
select is(
  jsonb_array_length(public.get_inventory_overview(
    '2b220000-0000-4000-8000-000000000001'
  ) -> 'operations'),
  0,
  'inventory overview owns the operation history exactly once'
);
reset role;

create temporary table archive_checkpoint as
select revision from private.catalog_revisions
where restaurant_id = '2b220000-0000-4000-8000-000000000001';
update public.products
set deleted_at = now(), active = false
where id = '4b220000-0000-4000-8000-000000000005';
select is(
  (select revision from private.catalog_revisions where restaurant_id = '2b220000-0000-4000-8000-000000000001'),
  (select revision + 1 from archive_checkpoint),
  'archiving a product invalidates the public catalogue revision'
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.get_public_catalog('revision-menu', 'menu') -> 'categories') category(value)
    cross join lateral jsonb_array_elements(category.value -> 'products') product(value)
    where product.value ->> 'id' = '4b220000-0000-4000-8000-000000000005'
  ),
  'archived product disappears from the compatibility catalogue'
);

select set_config('request.jwt.claim.sub', '1b220000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"1b220000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$select public.list_catalog_products(
    '2b220000-0000-4000-8000-000000000001', null, null, false, null, null, 50
  )$$,
  '42501', 'CATALOG_FORBIDDEN',
  'administrative list does not expose another tenant'
);
select throws_ok(
  $$select public.get_inventory_overview('2b220000-0000-4000-8000-000000000001')$$,
  '42501', 'INVENTORY_FORBIDDEN',
  'inventory overview does not expose another tenant'
);
reset role;

select * from finish();
rollback;
