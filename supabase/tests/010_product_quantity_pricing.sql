begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(59);

select has_table('public', 'product_quantity_prices', 'quantity price table exists');
select has_column('public', 'order_items', 'base_subtotal_cents', 'order items preserve the discounted base subtotal');
select has_column('public', 'order_items', 'pricing_mode_snapshot', 'order items preserve the pricing mode');
select has_column('public', 'order_items', 'pricing_breakdown_snapshot', 'order items preserve the applied decomposition');
select ok(
  not has_table_privilege('anon', 'public.product_quantity_prices', 'select'),
  'anonymous clients cannot read quantity-price rows directly'
);
select ok(
  has_table_privilege('authenticated', 'public.product_quantity_prices', 'select'),
  'authenticated catalogue readers have SELECT subject to RLS'
);
select ok(
  not has_function_privilege(
    'anon',
    'private.calculate_product_base_pricing(uuid,uuid,integer,bigint)',
    'execute'
  ),
  'the canonical pricing helper has no anonymous execute capability'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.calculate_product_base_pricing(uuid,uuid,integer,bigint)',
    'execute'
  ),
  'the canonical pricing helper has no authenticated execute capability'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.calculate_product_base_pricing(uuid,uuid,integer,bigint)',
    'execute'
  ),
  'the canonical pricing helper is callable only from its controlled definer path'
);
select ok(
  not has_function_privilege(
    'anon',
    'private.get_public_menu_without_quantity_prices(text)',
    'execute'
  ),
  'anonymous clients cannot bypass the public menu wrapper'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.save_product_catalog_without_quantity_prices(uuid,jsonb,jsonb,uuid[],uuid[])',
    'execute'
  ),
  'authenticated clients cannot bypass the catalogue wrapper'
);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('1a000000-0000-4000-8000-000000000001', 'quantity-admin-a@example.test', now(), '{"full_name":"Admin A"}'),
  ('1a000000-0000-4000-8000-000000000002', 'quantity-admin-b@example.test', now(), '{"full_name":"Admin B"}'),
  ('1a000000-0000-4000-8000-000000000003', 'quantity-manager@example.test', now(), '{"full_name":"Manager"}'),
  ('1a000000-0000-4000-8000-000000000004', 'quantity-outsider@example.test', now(), '{"full_name":"Outsider"}');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('2a000000-0000-4000-8000-000000000001', 'Quantity A', 'Quantity A', 'quantity-a', 'active',
   '+5491111111111', 'Address A', 'City', 'QTA', true, '1a000000-0000-4000-8000-000000000001'),
  ('2a000000-0000-4000-8000-000000000002', 'Quantity B', 'Quantity B', 'quantity-b', 'active',
   '+5492222222222', 'Address B', 'City', 'QTB', true, '1a000000-0000-4000-8000-000000000002');

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '1a000000-0000-4000-8000-000000000001'),
  ('2a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000002', 'restaurant_admin', 'active', '1a000000-0000-4000-8000-000000000002'),
  ('2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000003', 'order_manager', 'active', '1a000000-0000-4000-8000-000000000001');

insert into public.categories (id, restaurant_id, name, slug, created_by, updated_by) values
  ('3a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', 'Main A', 'main-a', '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001'),
  ('3a000000-0000-4000-8000-000000000002', '2a000000-0000-4000-8000-000000000002', 'Main B', 'main-b', '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000002');

insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents,
  promotional_price_cents, promotion_starts_at, promotion_ends_at,
  created_by, updated_by
) values
  ('4a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 'SAVE', 'Save product', 1000, null, null, null, '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001'),
  ('4a000000-0000-4000-8000-000000000002', '2a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 'ORDER', 'Order product', 1000, 900, now() - interval '1 day', now() + interval '1 day', '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001'),
  ('4a000000-0000-4000-8000-000000000003', '2a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 'DP', 'DP product', 1000, null, null, null, '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001'),
  ('4a000000-0000-4000-8000-000000000004', '2a000000-0000-4000-8000-000000000002', '3a000000-0000-4000-8000-000000000002', 'FOREIGN', 'Foreign product', 1000, null, null, null, '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000002');

insert into public.product_option_groups (
  id, restaurant_id, product_id, code, name, min_select, max_select
) values
  ('5a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001',
   '4a000000-0000-4000-8000-000000000002', 'EXTRA', 'Extra', 0, 1),
  ('5a000000-0000-4000-8000-000000000002', '2a000000-0000-4000-8000-000000000001',
   '4a000000-0000-4000-8000-000000000002', 'SAUCE', 'Sauce', 0, 1);
insert into public.product_options (
  id, restaurant_id, option_group_id, code, name, price_delta_cents
) values
  ('6a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001',
   '5a000000-0000-4000-8000-000000000001', 'CHEESE', 'Cheese', 200),
  ('6a000000-0000-4000-8000-000000000002', '2a000000-0000-4000-8000-000000000001',
   '5a000000-0000-4000-8000-000000000002', 'SAUCE', 'Sauce', 100);

insert into public.product_quantity_prices (
  id, restaurant_id, product_id, quantity, total_price_cents, active
) values
  ('7a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', 2, 1800, true),
  ('7a000000-0000-4000-8000-000000000002', '2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', 3, 2500, false),
  ('7a000000-0000-4000-8000-000000000003', '2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000002', 2, 1700, true),
  ('7a000000-0000-4000-8000-000000000004', '2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 2, 1800, true),
  ('7a000000-0000-4000-8000-000000000005', '2a000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000004', 2, 1500, true);

select throws_ok(
  $$update public.product_quantity_prices
    set id = '7a000000-0000-4000-8000-000000000099'
    where id = '7a000000-0000-4000-8000-000000000001'$$,
  '42501', 'PRIMARY_ID_IMMUTABLE',
  'quantity-price primary identity is immutable'
);
select throws_ok(
  $$update public.product_quantity_prices
    set restaurant_id = '2a000000-0000-4000-8000-000000000002'
    where id = '7a000000-0000-4000-8000-000000000001'$$,
  '42501', 'TENANT_ID_IMMUTABLE',
  'quantity-price tenant identity is immutable'
);

insert into public.payment_methods (
  id, restaurant_id, code, name, adjustment_type, adjustment_scope
) values (
  '8a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001',
  'cash', 'Cash', 'none', 'subtotal'
);
insert into public.business_hours (restaurant_id, day_of_week, slot_index, opens_at, closes_at)
select '2a000000-0000-4000-8000-000000000001', d, 0, '00:00'::time, '23:59'::time
from generate_series(0, 6) d;

select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  (select count(*)::integer from public.product_quantity_prices),
  4,
  'restaurant admin reads every own active and inactive rule'
);
select is(
  (select count(*)::integer from public.product_quantity_prices where restaurant_id = '2a000000-0000-4000-8000-000000000002'),
  0,
  'restaurant admin cannot read another tenant rules'
);
select throws_ok(
  $$insert into public.product_quantity_prices (restaurant_id, product_id, quantity, total_price_cents)
    values ('2a000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000004', 3, 1400)$$,
  '42501', null,
  'restaurant admin cannot insert a rule in another tenant'
);
reset role;

select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"1a000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
update public.product_quantity_prices
set total_price_cents = 1
where id = '7a000000-0000-4000-8000-000000000001';
reset role;
select is(
  (select total_price_cents from public.product_quantity_prices where id = '7a000000-0000-4000-8000-000000000001'),
  1800::bigint,
  'order manager cannot update catalogue pricing'
);

select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"1a000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  (select count(*)::integer from public.product_quantity_prices),
  0,
  'authenticated user without membership cannot read pricing rules'
);
reset role;

set local role anon;
select is(
  (
    select jsonb_array_length(product -> 'quantityPrices')
    from jsonb_array_elements(public.get_public_menu('quantity-a') -> 'categories') category,
         jsonb_array_elements(category -> 'products') product
    where product ->> 'id' = '4a000000-0000-4000-8000-000000000001'
  ),
  1,
  'public menu projects only active quantity prices'
);
select is(
  (
    select product -> 'quantityPrices'
    from jsonb_array_elements(public.get_public_menu('quantity-a') -> 'categories') category,
         jsonb_array_elements(category -> 'products') product
    where product ->> 'id' = '4a000000-0000-4000-8000-000000000001'
  ),
  '[{"quantity":2,"totalPriceCents":"1800"}]'::jsonb,
  'public projection contains only quantity and totalPriceCents'
);
reset role;

select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
create temporary table save_without_rules as
select public.save_product_catalog(
  '2a000000-0000-4000-8000-000000000001',
  '{"id":"4a000000-0000-4000-8000-000000000001","categoryId":"3a000000-0000-4000-8000-000000000001","code":"SAVE","name":"Preserved rules","description":"","basePriceCents":1000,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0}'::jsonb,
  '[]'::jsonb
) as response;
reset role;
select is(
  (select response ->> 'quantityPrices' from save_without_rules),
  null::text,
  'catalogue save reports no quantity-price synchronization when the key is absent'
);
select is(
  (select count(*)::integer from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001'),
  2,
  'omitting quantityPrices preserves existing active and inactive rules'
);

set local role authenticated;
select throws_ok(
  $$select public.save_product_catalog(
    '2a000000-0000-4000-8000-000000000001',
    '{"id":"4a000000-0000-4000-8000-000000000001","categoryId":"3a000000-0000-4000-8000-000000000001","code":"SAVE","name":"Must roll back","description":"","basePriceCents":1000,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0,"quantityPrices":[{"quantity":2,"totalPriceCents":"1700"},{"quantity":2,"totalPriceCents":"1600"}]}'::jsonb,
    '[]'::jsonb, '{}'::uuid[], '{}'::uuid[]
  )$$,
  '22023', 'PRODUCT_QUANTITY_PRICES_INVALID',
  'duplicate quantities reject the complete catalogue save'
);
reset role;
select is(
  (select name from public.products where id = '4a000000-0000-4000-8000-000000000001'),
  'Preserved rules',
  'rejected quantity pricing does not partially update the product'
);

set local role authenticated;
create temporary table synchronized_rules as
select public.save_product_catalog(
  '2a000000-0000-4000-8000-000000000001',
  '{"id":"4a000000-0000-4000-8000-000000000001","categoryId":"3a000000-0000-4000-8000-000000000001","code":"SAVE","name":"Synchronized rules","description":"","basePriceCents":1000,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0,"quantityPrices":[{"quantity":2,"totalPriceCents":"1750"},{"quantity":4,"totalPriceCents":"3200"}]}'::jsonb,
  '[]'::jsonb, '{}'::uuid[], '{}'::uuid[]
) as response;
reset role;
select is((select response ->> 'quantityPrices' from synchronized_rules), '2', 'catalogue save reports synchronized rule count');
select ok(
  (select active and total_price_cents = 1750 from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001' and quantity = 2),
  'catalogue save updates and reactivates a supplied rule'
);
select ok(
  (select not active from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001' and quantity = 3),
  'catalogue save deactivates a missing rule'
);
select ok(
  (select active and total_price_cents = 3200 from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001' and quantity = 4),
  'catalogue save inserts a new supplied rule'
);

set local role authenticated;
create temporary table imported_product as
select public.import_products_batch(
  '2a000000-0000-4000-8000-000000000001',
  '{"products":[{"category":"Main A","categorySlug":"main-a","code":"SAVE","name":"Imported without combos","description":"","basePriceCents":1100,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"active":true,"available":true,"featured":false,"sortOrder":0}],"optionGroups":[],"options":[]}'::jsonb,
  'update'
) as response;
reset role;
select is(
  (select response #>> '{summary,updated}' from imported_product),
  '1',
  'existing import path still updates products'
);
select is(
  (select count(*)::integer from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001' and active),
  2,
  'import without quantity pricing preserves existing rules'
);

select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 1, 1000) ->> 'baseSubtotalCents',
  '1000',
  'one unit uses the canonical unit price'
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 3, 1000) ->> 'baseSubtotalCents',
  '2800',
  'three units combine one reusable two-pack with one unit'
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 4, 1000) ->> 'baseSubtotalCents',
  '3600',
  'four units reuse the two-pack twice'
);

insert into public.product_quantity_prices (
  restaurant_id, product_id, quantity, total_price_cents
) values (
  '2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 3, 2500
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 5, 1000) ->> 'baseSubtotalCents',
  '4300',
  'competing rules choose an exact three-pack plus two-pack'
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 6, 1000) ->> 'baseSubtotalCents',
  '5000',
  'competing reusable rules choose the globally cheapest exact combination'
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 6, 1000) -> 'components',
  '[{"count":2,"quantity":3,"subtotalCents":"5000","totalPriceCents":"2500"}]'::jsonb,
  'canonical pricing snapshots aggregate the chosen repeated components'
);
select is(
  private.calculate_product_base_pricing('2a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000003', 100, 1000) ->> 'baseSubtotalCents',
  '83500',
  'canonical helper supports the full one-hundred-unit order limit'
);

set local role service_role;
create temporary table quantity_order as
select public.create_order_transaction(
  '{
    "restaurantSlug":"quantity-a",
    "idempotencyKey":"9a000000-0000-4000-8000-000000000001",
    "customer":{"name":"Client","phone":"+5493333333333"},
    "fulfillment":{"type":"pickup"},
    "paymentMethodId":"8a000000-0000-4000-8000-000000000001",
    "items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":4,"optionIds":["6a000000-0000-4000-8000-000000000001"],"unitPriceCents":"1","lineTotalCents":"1"}]
  }'::jsonb,
  repeat('1', 64), repeat('2', 64), repeat('3', 64)
) as response;
reset role;
select is((select response #>> '{order,subtotalCents}' from quantity_order), '4200', 'checkout ignores client prices and recalculates combo plus per-unit options');
select is(
  (select oi.unit_price_cents from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  900::bigint,
  'checkout uses the active promotional unit price as the unit offer'
);
select is(
  (select oi.base_subtotal_cents from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  3400::bigint,
  'order item stores the real discounted base subtotal'
);
select is(
  (select oi.pricing_mode_snapshot from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  'quantity',
  'order item marks a quantity-priced line'
);
select is(
  (select oi.options_total_unit_cents from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  200::bigint,
  'option delta remains a per-unit amount outside the combo'
);
select is(
  (select oi.line_total_cents from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  4200::bigint,
  'line total combines base subtotal and options for every unit'
);
select is(
  (select oi.pricing_breakdown_snapshot -> 'components' from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'),
  '[{"count":2,"quantity":2,"subtotalCents":"3400","totalPriceCents":"1700"}]'::jsonb,
  'order item stores the exact reusable combo decomposition'
);

set local role service_role;
create temporary table split_order as
select public.create_order_transaction(
  '{"restaurantSlug":"quantity-a","idempotencyKey":"9a000000-0000-4000-8000-000000000002","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8a000000-0000-4000-8000-000000000001","items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":[]},{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":[]}]}'::jsonb,
  repeat('4', 64), repeat('5', 64), repeat('6', 64)
) as response;
create temporary table grouped_order as
select public.create_order_transaction(
  '{"restaurantSlug":"quantity-a","idempotencyKey":"9a000000-0000-4000-8000-000000000003","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8a000000-0000-4000-8000-000000000001","items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":2,"optionIds":[]}]}'::jsonb,
  repeat('7', 64), repeat('8', 64), repeat('9', 64)
) as response;
reset role;
select is((select response #>> '{order,subtotalCents}' from split_order), '1700', 'identical separate lines are canonicalized before quantity pricing');
select is(
  (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000002'),
  1,
  'identical separate lines persist as one canonical order item'
);
select is(
  (select oi.quantity from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000002'),
  2,
  'canonical order item stores the summed quantity'
);
select is((select response #>> '{order,subtotalCents}' from grouped_order), '1700', 'a grouped identical line receives its quantity price');

set local role service_role;
create temporary table normalized_options_order as
select public.create_order_transaction(
  '{"restaurantSlug":"quantity-a","idempotencyKey":"9a000000-0000-4000-8000-000000000004","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8a000000-0000-4000-8000-000000000001","items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":["6a000000-0000-4000-8000-000000000001","6a000000-0000-4000-8000-000000000002"],"notes":"  Sin cebolla  "},{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":["6a000000-0000-4000-8000-000000000002","6a000000-0000-4000-8000-000000000001"],"notes":"Sin cebolla"}]}'::jsonb,
  repeat('a', 64), repeat('b', 64), repeat('c', 64)
) as response;
create temporary table distinct_lines_order as
select public.create_order_transaction(
  '{"restaurantSlug":"quantity-a","idempotencyKey":"9a000000-0000-4000-8000-000000000005","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8a000000-0000-4000-8000-000000000001","items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":["6a000000-0000-4000-8000-000000000001"],"notes":"A"},{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":["6a000000-0000-4000-8000-000000000002"],"notes":"A"},{"productId":"4a000000-0000-4000-8000-000000000002","quantity":1,"optionIds":["6a000000-0000-4000-8000-000000000001"],"notes":"B"}]}'::jsonb,
  repeat('d', 64), repeat('e', 64), repeat('f', 64)
) as response;
create temporary table hundred_units_order as
select public.create_order_transaction(
  '{"restaurantSlug":"quantity-a","idempotencyKey":"9a000000-0000-4000-8000-000000000006","customer":{"name":"Client","phone":"+5493333333333"},"fulfillment":{"type":"pickup"},"paymentMethodId":"8a000000-0000-4000-8000-000000000001","items":[{"productId":"4a000000-0000-4000-8000-000000000002","quantity":50,"optionIds":[]},{"productId":"4a000000-0000-4000-8000-000000000002","quantity":50,"optionIds":[]}]}'::jsonb,
  repeat('0', 64), repeat('1', 64), repeat('2', 64)
) as response;
reset role;
select is((select response #>> '{order,subtotalCents}' from normalized_options_order), '2300', 'option order and surrounding note whitespace do not split an identical line');
select is(
  (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000004'),
  1,
  'canonical identity ignores option ordering'
);
select is(
  (select oi.notes from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000004'),
  'Sin cebolla',
  'canonical order item stores trimmed observations'
);
select is((select response #>> '{order,subtotalCents}' from distinct_lines_order), '3200', 'different varieties and observations retain independent unit pricing scopes');
select is(
  (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000005'),
  3,
  'different option sets or normalized notes remain separate order items'
);
select is((select response #>> '{order,subtotalCents}' from hundred_units_order), '85000', 'one hundred identical units receive reusable quantity pricing');
select is(
  (select oi.quantity from public.order_items oi join public.orders o on o.id = oi.order_id where o.idempotency_key = '9a000000-0000-4000-8000-000000000006'),
  100,
  'canonical order item supports the global one-hundred-unit limit'
);
select is(
  (
    select o.subtotal_cents
    from public.orders o
    where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'
  ),
  (
    select sum(oi.line_total_cents)
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.idempotency_key = '9a000000-0000-4000-8000-000000000001'
  ),
  'canonical order subtotal equals its persisted line totals'
);

select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
create temporary table cleared_rules as
select public.save_product_catalog(
  '2a000000-0000-4000-8000-000000000001',
  '{"id":"4a000000-0000-4000-8000-000000000001","categoryId":"3a000000-0000-4000-8000-000000000001","code":"SAVE","name":"Imported without combos","description":"","basePriceCents":1100,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0,"quantityPrices":[]}'::jsonb,
  '[]'::jsonb, '{}'::uuid[], '{}'::uuid[]
) as response;
reset role;
select is((select response ->> 'quantityPrices' from cleared_rules), '0', 'an explicit empty list synchronizes zero rules');
select is(
  (select count(*)::integer from public.product_quantity_prices where product_id = '4a000000-0000-4000-8000-000000000001' and active),
  0,
  'an explicit empty list deactivates every existing rule'
);
select ok(
  not has_table_privilege('authenticated', 'public.product_quantity_prices', 'delete'),
  'application roles have no direct delete privilege for quantity prices'
);

select * from finish();
rollback;
