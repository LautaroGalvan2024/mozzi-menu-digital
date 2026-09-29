begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('15000000-0000-4000-8000-000000000001', 'admin-a@example.test', now(), '{"full_name":"Admin A"}'),
  ('15000000-0000-4000-8000-000000000002', 'manager-a@example.test', now(), '{"full_name":"Manager A"}'),
  ('15000000-0000-4000-8000-000000000003', 'admin-b@example.test', now(), '{"full_name":"Admin B"}'),
  ('15000000-0000-4000-8000-000000000004', 'super@example.test', now(), '{"full_name":"Super"}');

insert into public.platform_user_roles (user_id, role, created_by)
values (
  '15000000-0000-4000-8000-000000000004',
  'super_admin',
  '15000000-0000-4000-8000-000000000004'
);

insert into public.restaurants (
  id, name, trade_name, slug, description, status, whatsapp_phone_e164,
  address, city, timezone, currency_code, locale, primary_color, secondary_color,
  delivery_enabled, pickup_enabled, minimum_order_cents,
  default_preparation_minutes, order_prefix, public_menu_enabled, created_by
) values
  ('25000000-0000-4000-8000-000000000001', 'Restaurant A', 'Restaurant A', 'fields-a', '', 'active',
   '+5491111111111', 'Address A', 'City A', 'America/Argentina/Cordoba', 'ARS', 'es-AR', '#E85D2A', '#1F2937',
   true, true, 0, 30, 'FDA', true, '15000000-0000-4000-8000-000000000004'),
  ('25000000-0000-4000-8000-000000000002', 'Restaurant B', 'Restaurant B', 'fields-b', '', 'active',
   '+5492222222222', 'Address B', 'City B', 'America/Argentina/Cordoba', 'ARS', 'es-AR', '#E85D2A', '#1F2937',
   true, true, 0, 30, 'FDB', true, '15000000-0000-4000-8000-000000000004');

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '15000000-0000-4000-8000-000000000004'),
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000002', 'order_manager', 'active', '15000000-0000-4000-8000-000000000001'),
  ('25000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000003', 'restaurant_admin', 'active', '15000000-0000-4000-8000-000000000004'),
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000004', 'restaurant_admin', 'active', '15000000-0000-4000-8000-000000000004');

select ok(
  not has_column_privilege('authenticated', 'public.restaurants', 'id', 'update')
  and not has_column_privilege('authenticated', 'public.restaurants', 'created_by', 'update')
  and not has_column_privilege('authenticated', 'public.restaurants', 'created_at', 'update')
  and not has_column_privilege('authenticated', 'public.restaurants', 'updated_at', 'update'),
  'authenticated clients have no UPDATE grant on immutable or managed columns'
);
select ok(
  has_column_privilege('authenticated', 'public.restaurants', 'name', 'update')
  and has_column_privilege('authenticated', 'public.restaurants', 'logo_path', 'update')
  and has_column_privilege('authenticated', 'public.restaurants', 'public_menu_enabled', 'update'),
  'tenant-operational restaurant columns remain directly editable'
);
select ok(
  has_column_privilege('authenticated', 'public.restaurants', 'status', 'update')
  and has_column_privilege('authenticated', 'public.restaurants', 'slug', 'update')
  and has_column_privilege('authenticated', 'public.restaurants', 'order_prefix', 'update'),
  'platform columns remain reachable for AAL2 super admins and are trigger-protected'
);

select set_config('request.jwt.claim.sub', '15000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select lives_ok(
  $$update public.restaurants set
      name = 'Restaurant A edited',
      trade_name = 'Trade A edited',
      description = 'Operational configuration',
      whatsapp_phone_e164 = '+5491111111122',
      address = 'New address',
      city = 'New city',
      timezone = 'America/Argentina/Buenos_Aires',
      currency_code = 'USD',
      locale = 'en-US',
      logo_path = 'restaurants/25000000-0000-4000-8000-000000000001/logo/logo.webp',
      cover_path = 'restaurants/25000000-0000-4000-8000-000000000001/cover/cover.webp',
      primary_color = '#112233',
      secondary_color = '#445566',
      delivery_enabled = false,
      pickup_enabled = true,
      minimum_order_cents = 500,
      default_preparation_minutes = 45,
      public_menu_enabled = false
    where id = '25000000-0000-4000-8000-000000000001'$$,
  'restaurant admin can still update its complete operational configuration'
);
reset role;
select is(
  (select name || '|' || currency_code || '|' || public_menu_enabled::text
   from public.restaurants where id = '25000000-0000-4000-8000-000000000001'),
  'Restaurant A edited|USD|false',
  'legitimate tenant-operational changes persist'
);

set local role authenticated;
select throws_ok(
  $$update public.restaurants set slug = 'hijacked-slug'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED',
  'restaurant admin cannot change the public tenant slug'
);
select throws_ok(
  $$update public.restaurants set order_prefix = 'HACK'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED',
  'restaurant admin cannot change the order-number namespace'
);
select throws_ok(
  $$update public.restaurants set status = 'suspended'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED',
  'restaurant admin cannot change platform lifecycle status'
);
select throws_ok(
  $$update public.restaurants set created_by = '15000000-0000-4000-8000-000000000001'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'authenticated clients cannot target created_by at the privilege layer'
);
select throws_ok(
  $$update public.restaurants set created_at = now() - interval '1 day'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'authenticated clients cannot target created_at at the privilege layer'
);
select throws_ok(
  $$update public.restaurants set updated_at = now() - interval '1 day'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'authenticated clients cannot forge updated_at'
);
select lives_ok(
  $$update public.restaurants set name = 'Cross tenant'
    where id = '25000000-0000-4000-8000-000000000002'$$,
  'cross-tenant operational update is filtered by RLS'
);
reset role;
select is(
  (select name from public.restaurants where id = '25000000-0000-4000-8000-000000000002'),
  'Restaurant B',
  'cross-tenant restaurant remains unchanged'
);

select set_config('request.jwt.claim.sub', '15000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select lives_ok(
  $$update public.restaurants set name = 'Manager edit'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  'order-manager restaurant update is filtered by RLS'
);
reset role;
select is(
  (select name from public.restaurants where id = '25000000-0000-4000-8000-000000000001'),
  'Restaurant A edited',
  'order manager cannot change restaurant configuration'
);

select set_config('request.jwt.claim.sub', '15000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$update public.restaurants set status = 'suspended'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED',
  'super admin cannot use a tenant membership to bypass AAL2'
);
reset role;
select is(
  (select status::text from public.restaurants where id = '25000000-0000-4000-8000-000000000001'),
  'active',
  'AAL1 protected-field attempt leaves lifecycle unchanged'
);

select set_config('request.jwt.claims', '{"sub":"15000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok(
  $$update public.restaurants
    set status = 'suspended', slug = 'fields-a-renamed', order_prefix = 'FDX'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  'AAL2 super admin can change platform-controlled restaurant fields'
);
reset role;
select is(
  (select status::text || '|' || slug || '|' || order_prefix
   from public.restaurants where id = '25000000-0000-4000-8000-000000000001'),
  'suspended|fields-a-renamed|FDX',
  'authorized platform-field changes persist'
);
select ok(
  exists (
    select 1 from public.audit_logs
    where restaurant_id = '25000000-0000-4000-8000-000000000001'
      and actor_user_id = '15000000-0000-4000-8000-000000000004'
      and action = 'suspend'
      and before_data ->> 'slug' = 'fields-a'
      and after_data ->> 'slug' = 'fields-a-renamed'
      and before_data ->> 'orderPrefix' = 'FDA'
      and after_data ->> 'orderPrefix' = 'FDX'
  ),
  'platform identity changes are captured in the append-only audit log'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok(
  $$update public.restaurants set id = '25000000-0000-4000-8000-000000000099'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'RESTAURANT_ID_IMMUTABLE',
  'even service role cannot rewrite restaurant identity'
);
select throws_ok(
  $$update public.restaurants set created_by = '15000000-0000-4000-8000-000000000001'
    where id = '25000000-0000-4000-8000-000000000001'$$,
  '42501', 'RESTAURANT_CREATED_BY_IMMUTABLE',
  'even service role cannot rewrite restaurant provenance'
);
reset role;

select * from finish();
rollback;
