begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(19);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('10000000-0000-4000-8000-000000000001', 'admin-a@example.test', now(), '{"full_name":"Admin A"}'),
  ('10000000-0000-4000-8000-000000000002', 'manager-a@example.test', now(), '{"full_name":"Manager A"}'),
  ('10000000-0000-4000-8000-000000000003', 'admin-b@example.test', now(), '{"full_name":"Admin B"}'),
  ('10000000-0000-4000-8000-000000000004', 'super@example.test', now(), '{"full_name":"Super"}');

insert into public.platform_user_roles (user_id, role, created_by)
values ('10000000-0000-4000-8000-000000000004', 'super_admin', '10000000-0000-4000-8000-000000000004');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('20000000-0000-4000-8000-000000000001', 'Restaurant A', 'Restaurant A', 'tenant-a', 'active',
   '+5491111111111', 'Address A', 'City', 'TNA', true, '10000000-0000-4000-8000-000000000004'),
  ('20000000-0000-4000-8000-000000000002', 'Restaurant B', 'Restaurant B', 'tenant-b', 'active',
   '+5492222222222', 'Address B', 'City', 'TNB', true, '10000000-0000-4000-8000-000000000004');

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '10000000-0000-4000-8000-000000000004'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'order_manager', 'active', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'restaurant_admin', 'active', '10000000-0000-4000-8000-000000000004');

insert into public.categories (id, restaurant_id, name, slug, created_by, updated_by) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Category A', 'category-a',
   '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Category B', 'category-b',
   '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');

insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents, created_by, updated_by
) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'A-1', 'Product A', 1000,
   '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002', 'B-1', 'Product B', 2000,
   '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');

set local role anon;
select ok(not has_table_privilege(current_user, 'public.orders', 'select'), 'anonymous has no orders SELECT privilege');
select ok(not has_table_privilege(current_user, 'public.orders', 'insert'), 'anonymous has no orders INSERT privilege');
select ok(has_function_privilege(current_user, 'public.get_public_menu(text)', 'execute'), 'anonymous can execute only the public menu surface');
select is(public.get_public_menu('tenant-a') #>> '{restaurant,slug}', 'tenant-a', 'published active menu is visible');
select ok(not (public.get_public_menu('tenant-a') ? 'orders'), 'public menu contains no orders collection');
select ok(not has_function_privilege(current_user, 'public.claim_order(uuid)', 'execute'), 'anonymous cannot execute claim_order');
reset role;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::integer from public.restaurants), 1, 'admin A sees exactly its own restaurant');
select is((select count(*)::integer from public.restaurants where id = '20000000-0000-4000-8000-000000000002'), 0, 'admin A cannot read tenant B');
select lives_ok(
  $$update public.restaurants set name = 'Compromised' where id = '20000000-0000-4000-8000-000000000002'$$,
  'cross-tenant update is filtered by RLS'
);
reset role;
select is((select name from public.restaurants where id = '20000000-0000-4000-8000-000000000002'), 'Restaurant B', 'tenant B was not modified');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::integer from public.products), 1, 'order manager can read own catalogue');
select lives_ok(
  $$update public.products set base_price_cents = 1 where id = '40000000-0000-4000-8000-000000000001'$$,
  'order manager price update matches no rows'
);
reset role;
select is((select base_price_cents from public.products where id = '40000000-0000-4000-8000-000000000001'), 1000::bigint, 'order manager cannot change a price');
set local role authenticated;
select throws_ok(
  $$insert into public.products (restaurant_id, category_id, code, name, base_price_cents)
    values ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'FORBIDDEN', 'Forbidden', 1)$$,
  '42501', null, 'order manager cannot insert a product'
);
reset role;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::integer from public.restaurants where id in ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002')), 2, 'super admin can read both fixture restaurants');
select lives_ok(
  $$update public.restaurants set status = 'suspended' where id = '20000000-0000-4000-8000-000000000002'$$,
  'aal1 super admin critical update matches no rows'
);
reset role;
select is((select status::text from public.restaurants where id = '20000000-0000-4000-8000-000000000002'), 'active', 'aal1 cannot suspend a restaurant');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok(
  $$update public.restaurants set status = 'suspended' where id = '20000000-0000-4000-8000-000000000002'$$,
  'aal2 super admin can perform critical update'
);
reset role;
select is((select status::text from public.restaurants where id = '20000000-0000-4000-8000-000000000002'), 'suspended', 'aal2 update persisted');

select * from finish();
rollback;
