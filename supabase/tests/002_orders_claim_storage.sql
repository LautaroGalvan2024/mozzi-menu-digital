begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(23);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11000000-0000-4000-8000-000000000001', 'admin-a@example.test', now(), '{"full_name":"Admin A"}'),
  ('11000000-0000-4000-8000-000000000002', 'manager-a@example.test', now(), '{"full_name":"Manager A"}'),
  ('11000000-0000-4000-8000-000000000003', 'admin-b@example.test', now(), '{"full_name":"Admin B"}');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('21000000-0000-4000-8000-000000000001', 'Restaurant A', 'Restaurant A', 'orders-a', 'active',
   '+5491111111111', 'Address A', 'City', 'ORA', true, '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', 'Restaurant B', 'Restaurant B', 'orders-b', 'active',
   '+5492222222222', 'Address B', 'City', 'ORB', true, '11000000-0000-4000-8000-000000000003'),
  ('21000000-0000-4000-8000-000000000003', 'Closed', 'Closed', 'orders-closed', 'active',
   '+5493333333333', 'Address C', 'City', 'ORC', true, '11000000-0000-4000-8000-000000000001');

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'order_manager', 'active', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000003', 'restaurant_admin', 'active', '11000000-0000-4000-8000-000000000003');

insert into public.categories (id, restaurant_id, name, slug, created_by, updated_by) values
  ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'Food', 'food',
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003', 'Food', 'food',
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');

insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents, created_by, updated_by
) values
  ('41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', 'PIZZA', 'Pizza snapshot', 1000,
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('41000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000002', 'CLOSED', 'Closed product', 1000,
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');

insert into public.product_option_groups (
  id, restaurant_id, product_id, code, name, required, min_select, max_select
) values
  ('51000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001', 'SIZE', 'Size', true, 1, 1);
insert into public.product_options (
  id, restaurant_id, option_group_id, code, name, price_delta_cents
) values
  ('61000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
   '51000000-0000-4000-8000-000000000001', 'LARGE', 'Large', 200);

insert into public.payment_methods (id, restaurant_id, code, name) values
  ('71000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'cash', 'Cash'),
  ('71000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003', 'cash', 'Cash');

insert into public.business_hours (restaurant_id, day_of_week, slot_index, opens_at, closes_at)
select '21000000-0000-4000-8000-000000000001', d, 0, '00:00'::time, '23:59'::time
from generate_series(0, 6) d;

set local role service_role;
create temporary table first_result as
select public.create_order_transaction(
  '{
    "restaurantSlug":"orders-a",
    "idempotencyKey":"81000000-0000-4000-8000-000000000001",
    "customer":{"name":"Client","phone":"+5494444444444"},
    "fulfillment":{"type":"pickup"},
    "paymentMethodId":"71000000-0000-4000-8000-000000000001",
    "totalCents":"1",
    "items":[{
      "productId":"41000000-0000-4000-8000-000000000001",
      "quantity":2,
      "optionIds":["61000000-0000-4000-8000-000000000001"]
    }]
  }'::jsonb,
  repeat('a', 64), repeat('b', 64), repeat('c', 64)
) as response;
reset role;
create temporary table order_identity as
select id, action_id from public.orders
where restaurant_id = '21000000-0000-4000-8000-000000000001';
grant select on order_identity to authenticated, service_role;

select is((select response #>> '{order,totalCents}' from first_result), '2400', 'server ignores client total and recalculates price');
select is((select count(*)::integer from public.orders where restaurant_id = '21000000-0000-4000-8000-000000000001'), 1, 'first request creates exactly one order');
select is((select product_name_snapshot from public.order_items where restaurant_id = '21000000-0000-4000-8000-000000000001'), 'Pizza snapshot', 'order item stores product snapshot');
select is((select line_total_cents from public.order_items where restaurant_id = '21000000-0000-4000-8000-000000000001'), 2400::bigint, 'line total includes option and quantity');

set local role service_role;
create temporary table replay_result as
select public.create_order_transaction(
  '{"restaurantSlug":"orders-a","idempotencyKey":"81000000-0000-4000-8000-000000000001"}'::jsonb,
  repeat('a', 64), repeat('b', 64), repeat('d', 64)
) as response;
reset role;
select is((select (response ->> 'idempotentReplay')::boolean from replay_result), true, 'same idempotency key returns replay');
select is((select count(*)::integer from public.orders where restaurant_id = '21000000-0000-4000-8000-000000000001'), 1, 'idempotent replay does not duplicate order');
select is((select token_hash from private.order_client_event_tokens where order_id = (select id from order_identity limit 1)), repeat('d', 64), 'replay safely renews unused event token');

update public.products set name = 'Changed later', base_price_cents = 9999
where id = '41000000-0000-4000-8000-000000000001';
select is((select product_name_snapshot from public.order_items where restaurant_id = '21000000-0000-4000-8000-000000000001'), 'Pizza snapshot', 'product edit does not alter historical name');
select is((select unit_price_cents from public.order_items where restaurant_id = '21000000-0000-4000-8000-000000000001'), 1000::bigint, 'product edit does not alter historical price');

set local role service_role;
select is(
  (public.register_whatsapp_opened(
    (select action_id from order_identity limit 1), repeat('d', 64)
  ) ->> 'registered')::boolean,
  true,
  'valid minimum-scope token records WhatsApp opened'
);
reset role;
select is((select status::text from public.orders where id = (select id from order_identity limit 1)), 'whatsapp_opened', 'WhatsApp event changes only generated to opened');

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  (public.claim_order((select action_id from order_identity limit 1)) ->> 'claimed')::boolean,
  true,
  'order manager can claim own restaurant order'
);
reset role;
select is((select accepted_by from public.orders where id = (select id from order_identity limit 1)), '11000000-0000-4000-8000-000000000002'::uuid, 'claim stores the authenticated actor');

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  (public.claim_order((select action_id from order_identity limit 1)) ->> 'claimed')::boolean,
  false,
  'second authorized claimant cannot claim an accepted order'
);
reset role;
select is((select accepted_by from public.orders where id = (select id from order_identity limit 1)), '11000000-0000-4000-8000-000000000002'::uuid, 'second claimant never overwrites first actor');

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  format('select public.claim_order(%L::uuid)', (select action_id from order_identity limit 1)),
  '42501', 'ORDER_NOT_FOUND_OR_FORBIDDEN', 'other tenant cannot claim the order'
);
reset role;

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is(
  (public.complete_order((select id from order_identity limit 1)) ->> 'completed')::boolean,
  true,
  'order manager can complete accepted own order'
);
reset role;
select is((select status::text from public.orders where id = (select id from order_identity limit 1)), 'completed', 'completed transition persisted');

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select lives_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('restaurant-assets', 'restaurants/21000000-0000-4000-8000-000000000001/logo/ok.webp', '{"mimetype":"image/webp"}')$$,
  'restaurant admin can upload allowed image in own prefix'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('restaurant-assets', 'restaurants/21000000-0000-4000-8000-000000000002/logo/cross.webp', '{"mimetype":"image/webp"}')$$,
  '42501', null, 'storage blocks cross-tenant upload'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('restaurant-assets', 'restaurants/21000000-0000-4000-8000-000000000001/logo/bad.svg', '{"mimetype":"image/svg+xml"}')$$,
  '42501', null, 'storage blocks SVG'
);
reset role;

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('restaurant-assets', 'restaurants/21000000-0000-4000-8000-000000000001/products/nope.webp', '{"mimetype":"image/webp"}')$$,
  '42501', null, 'order manager cannot upload images'
);
reset role;

set local role anon;
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'restaurant-assets' and name like 'restaurants/21000000-0000-4000-8000-000000000001/%'),
  1,
  'public can read only the intentionally public asset'
);
reset role;

select * from finish();
rollback;
