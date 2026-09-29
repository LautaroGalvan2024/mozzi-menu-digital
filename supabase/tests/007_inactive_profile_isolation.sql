begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(5);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('16000000-0000-4000-8000-000000000001', 'disabled-admin@example.test', now(), '{"full_name":"Disabled Admin"}'),
  ('16000000-0000-4000-8000-000000000002', 'coworker@example.test', now(), '{"full_name":"Coworker"}');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values (
  '26000000-0000-4000-8000-000000000001', 'Profile Test', 'Profile Test',
  'profile-test', 'active', '+5491111111199', 'Address', 'City', 'PRF', true,
  '16000000-0000-4000-8000-000000000001'
);

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('26000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001',
   'restaurant_admin', 'active', '16000000-0000-4000-8000-000000000001'),
  ('26000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000002',
   'order_manager', 'active', '16000000-0000-4000-8000-000000000001');

update public.profiles
set active = false
where id = '16000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub', '16000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);
set local role authenticated;

select is(
  (select count(*)::integer from public.profiles
   where id = '16000000-0000-4000-8000-000000000001'),
  1,
  'a disabled user can still read its own disabled profile'
);
select is(
  (select count(*)::integer from public.profiles
   where id = '16000000-0000-4000-8000-000000000002'),
  0,
  'a disabled restaurant admin cannot read a coworker profile'
);
select throws_ok(
  $$select public.get_actor_authorization()$$,
  '42501', 'ACCOUNT_DISABLED',
  'a disabled profile cannot obtain an Edge Function authorization snapshot'
);

reset role;
update public.profiles
set active = true
where id = '16000000-0000-4000-8000-000000000001';
set local role authenticated;

select is(
  (select count(*)::integer from public.profiles
   where id = '16000000-0000-4000-8000-000000000002'),
  1,
  'an active restaurant admin retains authorized coworker visibility'
);
select is(
  jsonb_array_length(public.get_actor_authorization() -> 'memberships'),
  1,
  'an active profile receives its current membership authorization'
);

select * from finish();
rollback;

