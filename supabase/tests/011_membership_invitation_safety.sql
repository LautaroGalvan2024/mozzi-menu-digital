begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(39);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('1b000000-0000-4000-8000-000000000001', 's01-admin-a@example.test', now(), '{"full_name":"S01 Admin A"}'),
  ('1b000000-0000-4000-8000-000000000002', 's01-admin-b@example.test', now(), '{"full_name":"S01 Admin B"}'),
  ('1b000000-0000-4000-8000-000000000003', 's01-admin-suspended@example.test', now(), '{}'),
  ('1b000000-0000-4000-8000-000000000004', 's01-manager-suspended@example.test', now(), '{}'),
  ('1b000000-0000-4000-8000-000000000005', 's01-manager-invited@example.test', null, '{}'),
  ('1b000000-0000-4000-8000-000000000006', 's01-new-manager@example.test', now(), '{}'),
  ('1b000000-0000-4000-8000-000000000007', 's01-super@example.test', now(), '{}'),
  ('1b000000-0000-4000-8000-000000000008', 's01-other-admin@example.test', now(), '{}'),
  ('1b000000-0000-4000-8000-000000000009', 's01-disabled@example.test', now(), '{}');
update public.profiles set active = false where id = '1b000000-0000-4000-8000-000000000009';
insert into public.platform_user_roles (user_id, role, created_by)
values ('1b000000-0000-4000-8000-000000000007', 'super_admin', '1b000000-0000-4000-8000-000000000007');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('2b000000-0000-4000-8000-000000000001', 'S01 A', 'S01 A', 's01-a', 'active', '+5491111111111', 'A', 'City', 'SAA', true, '1b000000-0000-4000-8000-000000000007'),
  ('2b000000-0000-4000-8000-000000000002', 'S01 B', 'S01 B', 's01-b', 'active', '+5492222222222', 'B', 'City', 'SAB', true, '1b000000-0000-4000-8000-000000000007'),
  ('2b000000-0000-4000-8000-000000000003', 'S01 Empty', 'S01 Empty', 's01-empty', 'active', '+5493333333333', 'C', 'City', 'SAC', true, '1b000000-0000-4000-8000-000000000007');
insert into public.restaurant_members (id, restaurant_id, user_id, role, status, invited_by) values
  ('3b000000-0000-4000-8000-000000000001', '2b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '1b000000-0000-4000-8000-000000000007'),
  ('3b000000-0000-4000-8000-000000000002', '2b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000002', 'restaurant_admin', 'active', '1b000000-0000-4000-8000-000000000007'),
  ('3b000000-0000-4000-8000-000000000003', '2b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000003', 'restaurant_admin', 'suspended', '1b000000-0000-4000-8000-000000000007'),
  ('3b000000-0000-4000-8000-000000000004', '2b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000004', 'order_manager', 'suspended', '1b000000-0000-4000-8000-000000000001'),
  ('3b000000-0000-4000-8000-000000000005', '2b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000005', 'order_manager', 'invited', '1b000000-0000-4000-8000-000000000001'),
  ('3b000000-0000-4000-8000-000000000008', '2b000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-000000000008', 'restaurant_admin', 'active', '1b000000-0000-4000-8000-000000000007');

select ok(
  has_function_privilege('service_role', 'public.upsert_restaurant_membership(uuid,uuid,public.restaurant_role,public.membership_status,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_restaurant_membership(uuid,uuid,public.restaurant_role,public.membership_status,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.upsert_restaurant_membership(uuid,uuid,public.restaurant_role,public.membership_status,uuid)', 'execute'),
  'invitation RPC remains service-only'
);
select ok(
  has_function_privilege('authenticated', 'public.set_restaurant_member_status(uuid,public.membership_status)', 'execute')
  and not has_function_privilege('anon', 'public.set_restaurant_member_status(uuid,public.membership_status)', 'execute')
  and not has_function_privilege('service_role', 'public.set_restaurant_member_status(uuid,public.membership_status)', 'execute'),
  'status RPC retains its authenticated-only grant'
);

set local role service_role;
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','order_manager','active','1b000000-0000-4000-8000-000000000001')$$,
  '42501', 'ROLE_ASSIGNMENT_FORBIDDEN', 'tenant admin cannot demote self by invitation'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000002','order_manager','active','1b000000-0000-4000-8000-000000000001')$$,
  '42501', 'ROLE_ASSIGNMENT_FORBIDDEN', 'tenant admin cannot demote another admin by invitation'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000003','order_manager','active','1b000000-0000-4000-8000-000000000001')$$,
  '42501', 'ROLE_ASSIGNMENT_FORBIDDEN', 'prior admin role remains protected when suspended'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','restaurant_admin','active','1b000000-0000-4000-8000-000000000001')$$,
  '42501', 'ROLE_ASSIGNMENT_FORBIDDEN', 'tenant admin cannot assign a new administrator'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000004')$$,
  '42501', 'MEMBERSHIP_MANAGEMENT_FORBIDDEN', 'manager actor cannot invite'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000008')$$,
  '42501', 'MEMBERSHIP_MANAGEMENT_FORBIDDEN', 'admin from another tenant cannot invite'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000003')$$,
  '42501', 'MEMBERSHIP_MANAGEMENT_FORBIDDEN', 'suspended administrator cannot invite'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000009','order_manager','active','1b000000-0000-4000-8000-000000000001')$$,
  '22023', 'TARGET_USER_INVALID', 'inactive target cannot be invited'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006',null,'active','1b000000-0000-4000-8000-000000000001')$$,
  '22023', 'MEMBERSHIP_INPUT_INVALID', 'null requested role is rejected'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager',null,'1b000000-0000-4000-8000-000000000001')$$,
  '22023', 'MEMBERSHIP_INPUT_INVALID', 'null requested status is rejected'
);
reset role;
select is((select count(*)::integer from public.audit_logs where restaurant_id = '2b000000-0000-4000-8000-000000000001'), 0, 'rejected invitations do not write audit events');
update public.profiles set active = false where id = '1b000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000001')$$,
  '42501', 'MEMBERSHIP_MANAGEMENT_FORBIDDEN', 'inactive actor profile prevents invitation despite active membership'
);
reset role;
update public.profiles set active = true where id = '1b000000-0000-4000-8000-000000000001';
set local role service_role;
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000001')->>'changed',
  'true', 'admin can create a new manager membership'
);
reset role;
create temporary table s01_before_reinvite as
select to_jsonb(rm) as snapshot from public.restaurant_members rm
where restaurant_id = '2b000000-0000-4000-8000-000000000001' and user_id = '1b000000-0000-4000-8000-000000000006';
set local role service_role;
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000006','order_manager','active','1b000000-0000-4000-8000-000000000002')->>'changed',
  'false', 'same-role same-status reinvitation is a no-op even by another admin'
);
reset role;
select is(
  (select to_jsonb(rm) from public.restaurant_members rm where restaurant_id = '2b000000-0000-4000-8000-000000000001' and user_id = '1b000000-0000-4000-8000-000000000006'),
  (select snapshot from s01_before_reinvite), 'no-op preserves membership id, inviter and timestamps'
);
select is((select count(*)::integer from public.audit_logs where restaurant_id = '2b000000-0000-4000-8000-000000000001'), 1, 'no-op adds no duplicate audit event');
set local role service_role;
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000004','order_manager','active','1b000000-0000-4000-8000-000000000001')->>'status',
  'active', 'admin can reactivate a suspended manager through invitation'
);
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000005','order_manager','invited','1b000000-0000-4000-8000-000000000001')->>'changed',
  'false', 'reinviting a pending manager preserves the pending membership'
);
reset role;
select ok(exists (
  select 1 from public.audit_logs where entity_id = '3b000000-0000-4000-8000-000000000004'
    and before_data->>'status' = 'suspended' and after_data->>'status' = 'active'
    and before_data->>'role' = 'order_manager' and after_data->>'role' = 'order_manager'
    and actor_user_id = '1b000000-0000-4000-8000-000000000001'
    and metadata->>'source' = 'upsert_restaurant_membership'
), 'reactivation records actor and previous/new membership state');
set local role service_role;
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000002','order_manager','active','1b000000-0000-4000-8000-000000000007')->>'role',
  'order_manager', 'super admin may explicitly demote an admin while another remains active'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','order_manager','active','1b000000-0000-4000-8000-000000000007')$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED', 'even super admin cannot demote the final active admin'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','restaurant_admin','suspended','1b000000-0000-4000-8000-000000000007')$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED', 'upsert cannot suspend the final active admin'
);
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','restaurant_admin','invited','1b000000-0000-4000-8000-000000000007')$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED', 'upsert cannot move the final active admin back to invited'
);
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','restaurant_admin','active','1b000000-0000-4000-8000-000000000007')->>'changed',
  'false', 'identical privileged reinvitation of final active admin is harmless'
);
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000003','1b000000-0000-4000-8000-000000000008','restaurant_admin','invited','1b000000-0000-4000-8000-000000000007')->>'status',
  'invited', 'super admin can bootstrap first invited admin in empty tenant'
);
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000003','1b000000-0000-4000-8000-000000000008','restaurant_admin','active','1b000000-0000-4000-8000-000000000007')->>'status',
  'active', 'bootstrap admin can subsequently activate'
);
reset role;

select set_config('request.jwt.claim.sub', '1b000000-0000-4000-8000-000000000007', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"1b000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000004','suspended')$$,
  '42501', 'SUPER_ADMIN_AAL2_REQUIRED', 'status RPC still requires super-admin AAL2'
);
select set_config('request.jwt.claims', '{"sub":"1b000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}', true);
select throws_ok(
  $$select public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000001','suspended')$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED', 'status RPC sees last admin after upsert demotion'
);
select throws_ok(
  $$select public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000004',null)$$,
  '22023', 'MEMBERSHIP_STATUS_INVALID', 'status RPC rejects null status'
);
select is(public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000004','suspended')->>'changed', 'true', 'super admin can still suspend manager at AAL2');
select is(public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000004','suspended')->>'changed', 'false', 'status no-op remains idempotent');
reset role;
set local role service_role;
select is(
  public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000002','restaurant_admin','active','1b000000-0000-4000-8000-000000000007')->>'role',
  'restaurant_admin', 'super admin may restore a second admin'
);
reset role;
set local role authenticated;
select is(public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000001','suspended')->>'status', 'suspended', 'status RPC may suspend admin when a second active admin exists');
reset role;
set local role service_role;
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000002','order_manager','active','1b000000-0000-4000-8000-000000000007')$$,
  '22023', 'LAST_RESTAURANT_ADMIN_REQUIRED', 'upsert sees final admin after status RPC suspension'
);
reset role;
update public.profiles set active = false where id = '1b000000-0000-4000-8000-000000000007';
set local role service_role;
select throws_ok(
  $$select public.upsert_restaurant_membership('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000004','order_manager','active','1b000000-0000-4000-8000-000000000007')$$,
  '42501', 'MEMBERSHIP_MANAGEMENT_FORBIDDEN', 'inactive super-admin profile cannot use invitation RPC'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select public.set_restaurant_member_status('3b000000-0000-4000-8000-000000000004','active')$$,
  '42501', 'MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN', 'inactive super-admin profile cannot use status RPC'
);
reset role;
select is(
  (select count(*)::integer from public.restaurant_members where restaurant_id = '2b000000-0000-4000-8000-000000000001' and role = 'restaurant_admin' and status = 'active'),
  1, 'mixed permitted and rejected membership operations retain one active administrator'
);
select * from finish();
rollback;
