begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(21);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('14000000-0000-4000-8000-000000000001', 'admin-a@example.test', now(), '{"full_name":"Admin A"}'),
  ('14000000-0000-4000-8000-000000000002', 'manager-a@example.test', now(), '{"full_name":"Manager A"}'),
  ('14000000-0000-4000-8000-000000000003', 'admin-b@example.test', now(), '{"full_name":"Admin B"}'),
  ('14000000-0000-4000-8000-000000000004', 'super@example.test', now(), '{"full_name":"Super"}');

insert into public.platform_user_roles (user_id, role, created_by)
values (
  '14000000-0000-4000-8000-000000000004',
  'super_admin',
  '14000000-0000-4000-8000-000000000004'
);

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('24000000-0000-4000-8000-000000000001', 'Restaurant A', 'Restaurant A', 'members-a', 'active',
   '+5491111111111', 'Address A', 'City', 'MBA', true, '14000000-0000-4000-8000-000000000004'),
  ('24000000-0000-4000-8000-000000000002', 'Restaurant B', 'Restaurant B', 'members-b', 'active',
   '+5492222222222', 'Address B', 'City', 'MBB', true, '14000000-0000-4000-8000-000000000004');

insert into public.restaurant_members (
  id, restaurant_id, user_id, role, status, invited_by
) values
  ('25000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
   '14000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active',
   '14000000-0000-4000-8000-000000000004'),
  ('25000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001',
   '14000000-0000-4000-8000-000000000002', 'order_manager', 'active',
   '14000000-0000-4000-8000-000000000001'),
  ('25000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000002',
   '14000000-0000-4000-8000-000000000003', 'restaurant_admin', 'active',
   '14000000-0000-4000-8000-000000000004');

insert into public.business_hours (
  id, restaurant_id, day_of_week, slot_index, opens_at, closes_at
) values
  ('26000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 1, 0, '09:00', '13:00'),
  ('26000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001', 1, 1, '18:00', '23:00'),
  ('26000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000002', 1, 0, '09:00', '13:00');

insert into public.special_hours (
  id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at, reason
) values (
  '27000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  current_date + 1, 0, true, null, null, 'Holiday'
);

insert into public.categories (
  id, restaurant_id, name, slug, created_by, updated_by
) values (
  '28000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  'Food', 'food', '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001'
);

insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents, created_by, updated_by
) values (
  '29000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001', 'PIZZA', 'Pizza', 1000,
  '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001'
);

select ok(
  not has_function_privilege('anon', 'public.set_restaurant_member_status(uuid, public.membership_status)', 'execute'),
  'anonymous cannot execute member status RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.set_restaurant_member_status(uuid, public.membership_status)', 'execute'),
  'authenticated users can execute member status RPC subject to authorization'
);
select ok(
  has_table_privilege('authenticated', 'public.business_hours', 'delete')
  and has_table_privilege('authenticated', 'public.special_hours', 'delete'),
  'authenticated role has DELETE privilege on both schedule tables subject to RLS'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.product_option_groups'::regclass
      and c.conname = 'product_option_groups_max_select_check'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%20%'
  ),
  'database constrains option-group max_select to 20'
);

select set_config('request.jwt.claim.sub', '14000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"14000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_restaurant_member_status(
      '25000000-0000-4000-8000-000000000002', 'invited'
    )$$,
  '22023', 'MEMBERSHIP_STATUS_INVALID',
  'member status RPC accepts only active or suspended'
);
select is(
  public.set_restaurant_member_status(
    '25000000-0000-4000-8000-000000000002', 'suspended'
  ) ->> 'status',
  'suspended',
  'restaurant admin can suspend an order manager in the same tenant'
);
reset role;
select is(
  (select status::text from public.restaurant_members where id = '25000000-0000-4000-8000-000000000002'),
  'suspended',
  'suspension persists'
);
set local role authenticated;
select is(
  (public.set_restaurant_member_status(
    '25000000-0000-4000-8000-000000000002', 'active'
  ) ->> 'changed')::boolean,
  true,
  'restaurant admin can reactivate its order manager'
);
select is(
  (public.set_restaurant_member_status(
    '25000000-0000-4000-8000-000000000002', 'active'
  ) ->> 'changed')::boolean,
  false,
  'repeating the same member status is an idempotent no-op'
);
select throws_ok(
  $$select public.set_restaurant_member_status(
      '25000000-0000-4000-8000-000000000001', 'suspended'
    )$$,
  '42501', 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN',
  'restaurant admin cannot change another restaurant-admin membership'
);
select throws_ok(
  $$select public.set_restaurant_member_status(
      '25000000-0000-4000-8000-000000000003', 'suspended'
    )$$,
  '42501', 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN',
  'restaurant admin cannot change a membership in another tenant'
);
select throws_ok(
  $$select public.import_products_batch(
    '24000000-0000-4000-8000-000000000001',
    '{
      "products":[],
      "optionGroups":[{
        "productCode":"PIZZA",
        "groupCode":"TOPPINGS",
        "name":"Toppings",
        "minSelect":0,
        "maxSelect":21
      }],
      "options":[]
    }'::jsonb,
    'upsert'
  )$$,
  '22023', 'OPTION_GROUP_MAX_SELECT_EXCEEDED',
  'batch import rejects option groups above max_select 20'
);
delete from public.business_hours where id = '26000000-0000-4000-8000-000000000001';
delete from public.business_hours where id = '26000000-0000-4000-8000-000000000003';
delete from public.special_hours where id = '27000000-0000-4000-8000-000000000001';
reset role;
select is(
  (select count(*)::integer from public.business_hours where restaurant_id = '24000000-0000-4000-8000-000000000001'),
  1,
  'restaurant admin can delete its own recurring schedule row'
);
select is(
  (select count(*)::integer from public.business_hours where restaurant_id = '24000000-0000-4000-8000-000000000002'),
  1,
  'restaurant admin cannot delete another tenant schedule row'
);
select is(
  (select count(*)::integer from public.special_hours where restaurant_id = '24000000-0000-4000-8000-000000000001'),
  0,
  'restaurant admin can delete its own special-hours row'
);

select set_config('request.jwt.claim.sub', '14000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"14000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
delete from public.business_hours where id = '26000000-0000-4000-8000-000000000002';
reset role;
select is(
  (select count(*)::integer from public.business_hours where id = '26000000-0000-4000-8000-000000000002'),
  1,
  'order manager cannot delete schedule rows'
);

select set_config('request.jwt.claim.sub', '14000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"14000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_restaurant_member_status(
      '25000000-0000-4000-8000-000000000002', 'suspended'
    )$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED',
  'super admin must present AAL2 for member status changes'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"14000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is(
  public.set_restaurant_member_status(
    '25000000-0000-4000-8000-000000000002', 'suspended'
  ) ->> 'status',
  'suspended',
  'AAL2 super admin can suspend an order manager'
);
select throws_ok(
  $$select public.set_restaurant_member_status(
      '25000000-0000-4000-8000-000000000003', 'suspended'
    )$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED',
  'even a super admin cannot suspend the final active tenant admin'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.audit_logs
    where entity_type = 'restaurant_member'
      and entity_id = '25000000-0000-4000-8000-000000000002'
      and metadata ->> 'source' = 'set_restaurant_member_status'
  ),
  3,
  'every actual member status transition is audited'
);
select ok(
  exists (
    select 1 from public.audit_logs
    where entity_type = 'restaurant_member'
      and entity_id = '25000000-0000-4000-8000-000000000002'
      and actor_user_id = '14000000-0000-4000-8000-000000000004'
      and action = 'suspend'
  ),
  'member audit identifies the AAL2 super-admin actor'
);

select * from finish();
rollback;
