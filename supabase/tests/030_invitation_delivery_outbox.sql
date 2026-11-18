begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('10300000-0000-4000-8000-000000000001','delivery-actor@example.test',now(),'{}'),
 ('10300000-0000-4000-8000-000000000002','delivery-target@example.test',null,'{}'),
 ('10300000-0000-4000-8000-000000000003','delivery-disabled@example.test',null,'{}'),
 ('10300000-0000-4000-8000-000000000004','delivery-confirmed@example.test',now(),'{}'),
 ('10300000-0000-4000-8000-000000000005','delivery-rollback@example.test',null,'{}');
update public.profiles set active=false where id='10300000-0000-4000-8000-000000000003';

-- A legacy Auth identity predating the projection trigger is repaired once.
alter table auth.users disable trigger on_auth_user_created;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('10300000-0000-4000-8000-000000000006','DELIVERY-LEGACY@example.test',null,'{"full_name":"Legacy account"}');
alter table auth.users enable trigger on_auth_user_created;
select is(private.backfill_auth_profiles(),1,'backfill repairs only missing profiles');
select is((select full_name from public.profiles where id='10300000-0000-4000-8000-000000000006'),'Legacy account','backfill preserves Auth name projection');
select is((select email from public.profiles where id='10300000-0000-4000-8000-000000000006'),'delivery-legacy@example.test','backfill normalizes email');
select is(private.backfill_auth_profiles(),0,'backfill is idempotent');
select is((select active from public.profiles where id='10300000-0000-4000-8000-000000000003'),false,'backfill never reactivates an existing disabled profile');
select throws_ok($$
  update public.profiles set email='delivery-collision@example.test' where id='10300000-0000-4000-8000-000000000001';
  alter table auth.users disable trigger on_auth_user_created;
  insert into auth.users(id,email,raw_user_meta_data) values('10300000-0000-4000-8000-000000000007','delivery-collision@example.test','{}');
  alter table auth.users enable trigger on_auth_user_created;
  select private.backfill_auth_profiles();
$$,'22023','AUTH_DIRECTORY_AMBIGUOUS_REVIEW_REQUIRED','ambiguous legacy ownership fails instead of choosing a user');

insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix) values
 ('20300000-0000-4000-8000-000000000001','Delivery fixture','Delivery','invitation-delivery-test','draft','+5491111111111','INV'),
 ('20300000-0000-4000-8000-000000000002','Suspended fixture','Suspended','invitation-suspended-test','suspended','+5491111111112','INS');
insert into auth.users(id,email,invited_at,raw_user_meta_data)
values('10300000-0000-4000-8000-000000000008','delivery-legacy-sent@example.test',clock_timestamp()-interval '2 minutes','{}');
insert into public.restaurant_members(id,restaurant_id,user_id,role,status) values
 ('30300000-0000-4000-8000-000000000001','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000001','restaurant_admin','active'),
 ('30300000-0000-4000-8000-000000000002','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002','order_manager','invited'),
 ('30300000-0000-4000-8000-000000000003','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000003','order_manager','invited'),
 ('30300000-0000-4000-8000-000000000004','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000004','order_manager','invited'),
 ('30300000-0000-4000-8000-000000000005','20300000-0000-4000-8000-000000000002','10300000-0000-4000-8000-000000000002','order_manager','invited'),
 ('30300000-0000-4000-8000-000000000008','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000008','order_manager','invited'),
 ('30300000-0000-4000-8000-000000000009','20300000-0000-4000-8000-000000000002','10300000-0000-4000-8000-000000000008','order_manager','invited');
select is((select pending from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000002'),true,'invited membership queues durable pending delivery');
select is((select count(*)::integer from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000001'),0,'active membership does not queue email');
select ok((select not pending and sent_at is not null from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000008'),'mixed deployment preserves Auth invite sent before membership insert');
select is((select pending from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000009'),false,'membership in another restaurant does not queue a duplicate Auth invite');
select ok(not has_table_privilege('service_role','private.restaurant_invitation_deliveries','select'),'service API has no direct outbox table access');
select ok(not has_table_privilege('authenticated','private.restaurant_invitation_deliveries','select'),'browser cannot read outbox');
select ok(not has_function_privilege('anon','public.find_auth_user_by_email(text)','execute'),'anonymous cannot enumerate directory');
select ok(not has_function_privilege('authenticated','public.find_auth_user_by_email(text)','execute'),'authenticated browser cannot enumerate directory');
select ok(not has_function_privilege('authenticated','public.claim_restaurant_invitation(uuid,uuid,boolean,public.restaurant_role)','execute'),'browser cannot bypass invitation authorization');
select ok(not has_function_privilege('anon','public.finish_restaurant_invitation(uuid,boolean)','execute'),'anonymous cannot forge delivery completion');

create temporary table delivery_claims(name text primary key,payload jsonb);
grant all on delivery_claims to service_role;
set local role service_role;
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000008'),null::jsonb,'normal retry after legacy delivery sends no duplicate');
select ok(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000008',true,'order_manager') is not null,'legacy invitation supports explicit resend after rate limit');
select is(public.find_auth_user_by_email(' DELIVERY-TARGET@example.test '),'10300000-0000-4000-8000-000000000002'::uuid,'exact indexed directory handles case and outer whitespace');
select is(public.find_auth_user_by_email('delivery-legacy@example.test'),'10300000-0000-4000-8000-000000000006'::uuid,'backfilled identity is available to exact lookup');
select is(public.find_auth_user_by_email('missing@example.test'),null::uuid,'unknown email returns no identity');
select throws_ok($$select public.find_auth_user_by_email(null)$$,'22023','AUTH_DIRECTORY_EMAIL_INVALID','invalid directory input fails closed');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',false,'restaurant_admin'),null::jsonb,'role changed since Edge authorization prevents sending');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000003',false,'order_manager'),null::jsonb,'disabled profile cannot receive provisioned delivery');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000004',false,'order_manager'),null::jsonb,'confirmed Auth account is never invited again');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000002','10300000-0000-4000-8000-000000000002',false,'order_manager'),null::jsonb,'suspended restaurant cannot send');
insert into delivery_claims values('first',public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',false,'order_manager'));
select is((select payload->>'userId' from delivery_claims where name='first'),'10300000-0000-4000-8000-000000000002','claim returns exact target identity');
select is((select payload->>'email' from delivery_claims where name='first'),'delivery-target@example.test','claim uses current Auth email');
select ok((select (payload->>'leaseId')::uuid is not null from delivery_claims where name='first'),'claim supplies a lease token');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',true,'order_manager'),null::jsonb,'explicit resend cannot bypass a live lease');
select is(public.finish_restaurant_invitation('40300000-0000-4000-8000-000000000001',true),false,'unknown lease cannot complete delivery');
select is(public.finish_restaurant_invitation((select (payload->>'leaseId')::uuid from delivery_claims where name='first'),false),true,'provider failure releases lease for a bounded retry');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002'),null::jsonb,'provider failure still respects sixty-second retry limit');
reset role;
select is((select pending from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000002'),true,'failed delivery remains durably pending');
update private.restaurant_invitation_deliveries set last_attempt_at=clock_timestamp()-interval '61 seconds' where membership_id='30300000-0000-4000-8000-000000000002';
set local role service_role;
insert into delivery_claims values('second',public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002'));
reset role;
update private.restaurant_invitation_deliveries set last_attempt_at=clock_timestamp()-interval '3 minutes',lease_expires_at=clock_timestamp()-interval '1 minute' where membership_id='30300000-0000-4000-8000-000000000002';
set local role service_role;
insert into delivery_claims values('third',public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002'));
select ok((select payload->>'leaseId' from delivery_claims where name='second')<>(select payload->>'leaseId' from delivery_claims where name='third'),'expired delivery receives a new fencing token');
select is(public.finish_restaurant_invitation((select (payload->>'leaseId')::uuid from delivery_claims where name='second'),true),false,'stale handler cannot acknowledge a replacement lease');
select is(public.finish_restaurant_invitation((select (payload->>'leaseId')::uuid from delivery_claims where name='third'),true),true,'current successful handler completes delivery');
reset role;
-- Mirror the Auth service evidence produced by the successful provider call.
update auth.users set invited_at=clock_timestamp() where id='10300000-0000-4000-8000-000000000002';
set local role service_role;
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002'),null::jsonb,'normal endpoint retry does not resend successful email');
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',true,'order_manager'),null::jsonb,'immediate explicit resend also respects rate limit');
reset role;
select ok((select not pending and sent_at is not null and lease_id is null from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000002'),'successful job retains delivery timestamp without lease');
update private.restaurant_invitation_deliveries set last_attempt_at=clock_timestamp()-interval '61 seconds' where membership_id='30300000-0000-4000-8000-000000000002';
set local role service_role;
insert into delivery_claims values('resend',public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',true,'order_manager'));
select ok((select payload is not null from delivery_claims where name='resend'),'explicit resend is available after the limit');
reset role;
update public.restaurant_members set status='suspended' where id='30300000-0000-4000-8000-000000000002';
set local role service_role;
select is(public.finish_restaurant_invitation((select (payload->>'leaseId')::uuid from delivery_claims where name='resend'),true),false,'suspension invalidates in-flight delivery completion');
reset role;
update public.restaurant_members set status='invited' where id='30300000-0000-4000-8000-000000000002';
select is((select pending from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000002'),false,'entering invited again preserves previously sent Auth invitation');
set local role service_role;
select is(public.claim_restaurant_invitation('20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000002',true,'order_manager'),null::jsonb,'status toggling cannot reset the resend rate limit');
reset role;
update auth.users set email_confirmed_at=now() where id='10300000-0000-4000-8000-000000000002';
select is((select pending from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000002'),false,'Auth confirmation cancels pending delivery through membership transition');
select throws_ok($$do $probe$ begin
  insert into public.restaurant_members(id,restaurant_id,user_id,role,status) values('30300000-0000-4000-8000-000000000006','20300000-0000-4000-8000-000000000001','10300000-0000-4000-8000-000000000005','order_manager','invited');
  raise exception using errcode='P0001',message='TEST_BUSINESS_ROLLBACK';
end $probe$;$$,'P0001','TEST_BUSINESS_ROLLBACK','failed business transaction is rolled back');
select is((select count(*)::integer from private.restaurant_invitation_deliveries where membership_id='30300000-0000-4000-8000-000000000006'),0,'rolled-back membership cannot leave an email job');
select * from finish();
rollback;
