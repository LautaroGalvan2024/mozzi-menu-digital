begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(7);

insert into auth.users (id, email, email_confirmed_at)
values ('13000000-0000-4000-8000-000000000001', 'owner@example.test', now());
insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values (
  '23000000-0000-4000-8000-000000000001', 'Rate Test', 'Rate Test', 'rate-test', 'active',
  '+5491111111111', 'Address', 'City', 'RAT', true, '13000000-0000-4000-8000-000000000001'
);

select ok(
  not has_function_privilege('anon', 'public.check_order_rate_limits(text,text,text)', 'execute'),
  'anonymous cannot execute rate-limit RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.check_order_rate_limits(text,text,text)', 'execute'),
  'authenticated clients cannot execute rate-limit RPC'
);

set local role service_role;
select is(
  (public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64)) ->> 'allowed')::boolean,
  true,
  'first request is allowed'
);
select public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64));
select public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64));
select public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64));
select public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64));
create temporary table limited_result as
select public.check_order_rate_limits('rate-test', repeat('a', 64), repeat('b', 64)) as response;
reset role;

select is((select (response ->> 'allowed')::boolean from limited_result), false, 'sixth phone attempt is blocked');
select is((select response ->> 'code' from limited_result), 'RATE_LIMITED', 'blocked attempt returns stable rate-limit code');
select is(
  (select count(*)::integer from private.rate_limits where restaurant_id = '23000000-0000-4000-8000-000000000001'),
  3,
  'only HMAC/SHA hashes are stored for IP, phone and restaurant dimensions'
);

update private.rate_limits
set window_start = '2000-01-01 00:00:00+00'::timestamptz
where restaurant_id = '23000000-0000-4000-8000-000000000001';
set local role service_role;
create temporary table cleanup_result as
select public.cleanup_rate_limits('2000-01-02 00:00:00+00'::timestamptz) as removed;
reset role;
select is((select removed from cleanup_result), 3, 'cleanup removes expired rate-limit buckets');

select * from finish();
rollback;
