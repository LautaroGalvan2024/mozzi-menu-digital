begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(10);

insert into auth.users (id, email, email_confirmed_at)
values ('12000000-0000-4000-8000-000000000001', 'owner@example.test', now());

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values (
  '22000000-0000-4000-8000-000000000001', 'Validation', 'Validation', 'validation', 'active',
  '+5491111111111', 'Address', 'City', 'VAL', true, '12000000-0000-4000-8000-000000000001'
);
insert into public.categories (id, restaurant_id, name, slug, created_by, updated_by)
values (
  '32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
  'Food', 'food', '12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001'
);
insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents, created_by, updated_by
) values
  ('42000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
   '32000000-0000-4000-8000-000000000001', 'MAIN', 'Main', 1000,
   '12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001',
   '32000000-0000-4000-8000-000000000001', 'OTHER', 'Other', 900,
   '12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001');
insert into public.product_option_groups (
  id, restaurant_id, product_id, code, name, required, min_select, max_select
) values
  ('52000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
   '42000000-0000-4000-8000-000000000001', 'MAIN-G', 'Main group', true, 1, 1),
  ('52000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001',
   '42000000-0000-4000-8000-000000000002', 'OTHER-G', 'Other group', false, 0, 1);
insert into public.product_options (
  id, restaurant_id, option_group_id, code, name, price_delta_cents
) values
  ('62000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
   '52000000-0000-4000-8000-000000000001', 'MAIN-O', 'Main option', 200),
  ('62000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001',
   '52000000-0000-4000-8000-000000000002', 'OTHER-O', 'Other option', 50);
insert into public.payment_methods (
  id, restaurant_id, code, name, adjustment_type, adjustment_scope, adjustment_bps
) values (
  '72000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
  'transfer', 'Transfer', 'discount', 'subtotal', 1000
);
insert into public.delivery_zones (
  id, restaurant_id, name, delivery_fee_cents, free_shipping_from_cents
) values (
  '82000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
  'Center', 500, 2000
);
insert into public.business_hours (restaurant_id, day_of_week, slot_index, opens_at, closes_at)
select '22000000-0000-4000-8000-000000000001', d, 0, '00:00'::time, '23:59'::time
from generate_series(0, 6) d;

select ok(private.restaurant_is_open('22000000-0000-4000-8000-000000000001', now()), 'regular hours report restaurant open');

set local role service_role;
create temporary table priced_order as
select public.create_order_transaction(
  '{
    "restaurantSlug":"validation",
    "idempotencyKey":"92000000-0000-4000-8000-000000000001",
    "customer":{"name":"Client","phone":"+5494444444444"},
    "fulfillment":{"type":"delivery","deliveryZoneId":"82000000-0000-4000-8000-000000000001","address":"Street 123"},
    "paymentMethodId":"72000000-0000-4000-8000-000000000001",
    "items":[{"productId":"42000000-0000-4000-8000-000000000001","quantity":2,"optionIds":["62000000-0000-4000-8000-000000000001"]}]
  }'::jsonb,
  repeat('1', 64), repeat('2', 64), repeat('3', 64)
) as response;
reset role;

select is((select response #>> '{order,subtotalCents}' from priced_order), '2400', 'subtotal uses server product and option prices');
select is((select response #>> '{order,discountCents}' from priced_order), '240', 'basis-point discount uses integer half-up calculation');
select is((select response #>> '{order,deliveryFeeCents}' from priced_order), '0', 'free-shipping threshold is applied server-side');
select is((select response #>> '{order,totalCents}' from priced_order), '2160', 'final total is canonical');

insert into public.special_hours (restaurant_id, date, is_closed, reason)
values (
  '22000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Cordoba')::date,
  true,
  'Test closure'
);
select ok(not private.restaurant_is_open('22000000-0000-4000-8000-000000000001', now()), 'special closure overrides regular hours');
set local role service_role;
select throws_ok(
  $sql$select public.create_order_transaction(
    '{"restaurantSlug":"validation","idempotencyKey":"92000000-0000-4000-8000-000000000002","customer":{"name":"Client","phone":"+5494444444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"72000000-0000-4000-8000-000000000001","items":[{"productId":"42000000-0000-4000-8000-000000000001","quantity":1,"optionIds":["62000000-0000-4000-8000-000000000001"]}]}'::jsonb,
    repeat('4',64), repeat('5',64), repeat('6',64))$sql$,
  '22023', 'RESTAURANT_CLOSED', 'closed restaurant rejects checkout'
);
reset role;
delete from public.special_hours where restaurant_id = '22000000-0000-4000-8000-000000000001';

update public.products set available = false where id = '42000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $sql$select public.create_order_transaction(
    '{"restaurantSlug":"validation","idempotencyKey":"92000000-0000-4000-8000-000000000003","customer":{"name":"Client","phone":"+5494444444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"72000000-0000-4000-8000-000000000001","items":[{"productId":"42000000-0000-4000-8000-000000000001","quantity":1,"optionIds":["62000000-0000-4000-8000-000000000001"]}]}'::jsonb,
    repeat('7',64), repeat('8',64), repeat('9',64))$sql$,
  '22023', 'PRODUCT_UNAVAILABLE', 'unavailable product cannot be purchased'
);
reset role;
update public.products set available = true where id = '42000000-0000-4000-8000-000000000001';

set local role service_role;
select throws_ok(
  $sql$select public.create_order_transaction(
    '{"restaurantSlug":"validation","idempotencyKey":"92000000-0000-4000-8000-000000000004","customer":{"name":"Client","phone":"+5494444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"72000000-0000-4000-8000-000000000001","items":[{"productId":"42000000-0000-4000-8000-000000000001","quantity":1,"optionIds":["62000000-0000-4000-8000-000000000002"]}]}'::jsonb,
    repeat('a',64), repeat('b',64), repeat('c',64))$sql$,
  '22023', 'OPTION_NOT_VALID_FOR_PRODUCT', 'option from another product is rejected'
);
select throws_ok(
  $sql$select public.create_order_transaction(
    '{"restaurantSlug":"validation","idempotencyKey":"92000000-0000-4000-8000-000000000005","customer":{"name":"Client","phone":"+5494444444"},"fulfillment":{"type":"pickup"},"paymentMethodId":"72000000-0000-4000-8000-000000000001","items":[{"productId":"42000000-0000-4000-8000-000000000001","quantity":1,"optionIds":[]}]}'::jsonb,
    repeat('d',64), repeat('e',64), repeat('f',64))$sql$,
  '22023', 'OPTION_GROUP_SELECTION_INVALID', 'required option group is enforced'
);
reset role;

select * from finish();
rollback;
