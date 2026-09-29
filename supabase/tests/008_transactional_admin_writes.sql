begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(46);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('18000000-0000-4000-8000-000000000001', 'atomic-a@example.test', now(), '{"full_name":"Atomic A"}'),
  ('18000000-0000-4000-8000-000000000002', 'atomic-b@example.test', now(), '{"full_name":"Atomic B"}');

insert into public.restaurants (
  id, name, trade_name, slug, status, whatsapp_phone_e164, address, city,
  order_prefix, public_menu_enabled, created_by
) values
  ('28000000-0000-4000-8000-000000000001', 'Atomic Restaurant A', 'Atomic A', 'atomic-a', 'active',
   '+5491111111111', 'Address A', 'City', 'ATA', true, '18000000-0000-4000-8000-000000000001'),
  ('28000000-0000-4000-8000-000000000002', 'Atomic Restaurant B', 'Atomic B', 'atomic-b', 'active',
   '+5492222222222', 'Address B', 'City', 'ATB', true, '18000000-0000-4000-8000-000000000002');

insert into public.restaurant_members (restaurant_id, user_id, role, status, invited_by) values
  ('28000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001', 'restaurant_admin', 'active', '18000000-0000-4000-8000-000000000001'),
  ('28000000-0000-4000-8000-000000000002', '18000000-0000-4000-8000-000000000002', 'restaurant_admin', 'active', '18000000-0000-4000-8000-000000000002');

insert into public.categories (id, restaurant_id, name, slug, created_by, updated_by) values
  ('38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', 'Main A', 'main-a', '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001'),
  ('38000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000002', 'Main B', 'main-b', '18000000-0000-4000-8000-000000000002', '18000000-0000-4000-8000-000000000002');

insert into public.products (
  id, restaurant_id, category_id, code, name, base_price_cents, created_by, updated_by
) values
  ('48000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', 'PIZZA', 'Original product', 1000, '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001'),
  ('48000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', 'OTHER', 'Other product', 1200, '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001'),
  ('48000000-0000-4000-8000-000000000003', '28000000-0000-4000-8000-000000000002', '38000000-0000-4000-8000-000000000002', 'FOREIGN', 'Foreign product', 1400, '18000000-0000-4000-8000-000000000002', '18000000-0000-4000-8000-000000000002');

insert into public.product_option_groups (
  id, restaurant_id, product_id, code, name, min_select, max_select
) values
  ('58000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001', 'BASE', 'Original group', 0, 1),
  ('58000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000002', 'OTHER-GROUP', 'Other group', 0, 1),
  ('58000000-0000-4000-8000-000000000003', '28000000-0000-4000-8000-000000000002', '48000000-0000-4000-8000-000000000003', 'FOREIGN-GROUP', 'Foreign group', 0, 1);

insert into public.product_options (
  id, restaurant_id, option_group_id, code, name, price_delta_cents
) values
  ('68000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-000000000001', 'ORIGINAL', 'Original option', 100),
  ('68000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-000000000002', 'OTHER', 'Other option', 100);

insert into public.business_hours (
  id, restaurant_id, day_of_week, slot_index, opens_at, closes_at
) values
  ('78000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', 1, 0, '09:00', '13:00'),
  ('78000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000002', 1, 0, '10:00', '14:00');

select ok(
  not has_function_privilege('anon', 'public.save_restaurant_hours(uuid,jsonb,jsonb,uuid[],uuid[])', 'execute'),
  'anonymous cannot execute the transactional hours RPC'
);
select ok(
  not has_function_privilege('anon', 'public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[])', 'execute'),
  'anonymous cannot execute the transactional catalogue RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.save_restaurant_hours(uuid,jsonb,jsonb,uuid[],uuid[])', 'execute'),
  'authenticated users can execute hours RPC subject to authorization'
);
select ok(
  has_function_privilege('authenticated', 'public.save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[])', 'execute'),
  'authenticated users can execute catalogue RPC subject to authorization'
);
select ok(
  not has_function_privilege('anon', 'public.list_orphan_image_assets(uuid)', 'execute'),
  'anonymous cannot inspect the asset orphan inventory'
);
select ok(
  has_function_privilege('authenticated', 'public.list_orphan_image_assets(uuid)', 'execute'),
  'authenticated users can inspect an authorized tenant asset inventory'
);

select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"18000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;

select throws_ok(
  $$select public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[{"id":"78000000-0000-4000-8000-000000000003","dayOfWeek":2,"slotIndex":0,"opensAt":"09:00","closesAt":"09:00","spansNextDay":false,"active":true}]'::jsonb,
    '[]'::jsonb,
    array['78000000-0000-4000-8000-000000000001']::uuid[],
    '{}'::uuid[]
  )$$,
  '22023', 'HOURS_VALUE_INVALID',
  'invalid schedule rejects the complete hours transaction'
);
reset role;
select is(
  (select count(*)::integer from public.business_hours where id = '78000000-0000-4000-8000-000000000001'),
  1,
  'failed hours save rolls its earlier deletion back'
);

set local role authenticated;
select is(
  public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[{"id":"78000000-0000-4000-8000-000000000003","dayOfWeek":2,"slotIndex":0,"opensAt":"09:00","closesAt":"13:00","spansNextDay":false,"active":true}]'::jsonb,
    '[]'::jsonb,
    array['78000000-0000-4000-8000-000000000001']::uuid[],
    '{}'::uuid[]
  ) ->> 'regular',
  '1',
  'valid hours save reports its replacement row'
);
reset role;
select is(
  (select count(*)::integer from public.business_hours where id = '78000000-0000-4000-8000-000000000001'),
  0,
  'valid hours save removes requested old rows atomically'
);
select is(
  (select count(*)::integer from public.business_hours where id = '78000000-0000-4000-8000-000000000003'),
  1,
  'valid hours save persists its new rows'
);

delete from public.business_hours
where restaurant_id = '28000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.business_hours where restaurant_id = '28000000-0000-4000-8000-000000000001'),
  0,
  'hours fixture is empty before its first shift is saved'
);
set local role authenticated;
select is(
  public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[{"id":"78000000-0000-4000-8000-000000000004","dayOfWeek":0,"slotIndex":0,"opensAt":"09:00","closesAt":"13:00","spansNextDay":false,"active":true}]'::jsonb,
    '[]'::jsonb,
    '{}'::uuid[],
    '{}'::uuid[]
  ) ->> 'regular',
  '1',
  'hours RPC accepts the first shift of an empty restaurant'
);
reset role;
select is(
  (select count(*)::integer from public.business_hours where id = '78000000-0000-4000-8000-000000000004'),
  1,
  'first shift is persisted for the previously empty restaurant'
);

insert into public.business_hours (
  id, restaurant_id, day_of_week, slot_index, opens_at, closes_at
) values (
  '78000000-0000-4000-8000-000000000005',
  '28000000-0000-4000-8000-000000000001', 1, 0, '18:00', '23:00'
);
set local role authenticated;
select is(
  public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[
      {"id":"78000000-0000-4000-8000-000000000004","dayOfWeek":1,"slotIndex":0,"opensAt":"09:00","closesAt":"13:00","spansNextDay":false,"active":true},
      {"id":"78000000-0000-4000-8000-000000000005","dayOfWeek":0,"slotIndex":0,"opensAt":"18:00","closesAt":"23:00","spansNextDay":false,"active":true}
    ]'::jsonb,
    '[]'::jsonb,
    '{}'::uuid[],
    '{}'::uuid[]
  ) ->> 'regular',
  '2',
  'hours RPC replaces regular rows before swapping their day and slot coordinates'
);
reset role;
select is(
  (select day_of_week::text || ':' || slot_index::text from public.business_hours where id = '78000000-0000-4000-8000-000000000004'),
  '1:0',
  'first regular row reaches the coordinate previously occupied by the second row'
);
select is(
  (select day_of_week::text || ':' || slot_index::text from public.business_hours where id = '78000000-0000-4000-8000-000000000005'),
  '0:0',
  'second regular row reaches the coordinate previously occupied by the first row'
);

insert into public.special_hours (
  id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at
) values
  ('79000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '2040-01-10', 0, false, '09:00', '13:00'),
  ('79000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '2040-01-11', 0, false, '18:00', '23:00');
set local role authenticated;
select is(
  public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[]'::jsonb,
    '[
      {"id":"79000000-0000-4000-8000-000000000001","date":"2040-01-11","slotIndex":0,"isClosed":false,"opensAt":"09:00","closesAt":"13:00","spansNextDay":false,"reason":"Moved A"},
      {"id":"79000000-0000-4000-8000-000000000002","date":"2040-01-10","slotIndex":0,"isClosed":false,"opensAt":"18:00","closesAt":"23:00","spansNextDay":false,"reason":"Moved B"}
    ]'::jsonb,
    '{}'::uuid[],
    '{}'::uuid[]
  ) ->> 'special',
  '2',
  'hours RPC replaces special rows before swapping their date and slot coordinates'
);
reset role;
select is(
  (select date::text from public.special_hours where id = '79000000-0000-4000-8000-000000000001'),
  '2040-01-11',
  'first special row moves to the date previously occupied by the second row'
);
select is(
  (select date::text from public.special_hours where id = '79000000-0000-4000-8000-000000000002'),
  '2040-01-10',
  'second special row moves to the date previously occupied by the first row'
);

set local role authenticated;
select throws_ok(
  $$select public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[{"id":"78000000-0000-4000-8000-000000000002","dayOfWeek":2,"slotIndex":0,"opensAt":"10:00","closesAt":"14:00","spansNextDay":false,"active":true}]'::jsonb,
    '[]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]
  )$$,
  '42501', 'TENANT_ID_IMMUTABLE',
  'hours RPC validates payload identifiers before replacement deletes'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[]'::jsonb,
    '[
      {"id":"79000000-0000-4000-8000-000000000003","date":"2040-02-01","slotIndex":0,"isClosed":true,"opensAt":null,"closesAt":null,"spansNextDay":false,"reason":"Closed"},
      {"id":"79000000-0000-4000-8000-000000000004","date":"2040-02-01","slotIndex":1,"isClosed":false,"opensAt":"18:00","closesAt":"23:00","spansNextDay":false,"reason":"Open"}
    ]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]
  )$$,
  '22023', 'HOURS_CLOSED_DATE_MIXED',
  'a closed special date cannot include another payload row'
);
reset role;
select is(
  (select count(*)::integer from public.special_hours where date = '2040-02-01'),
  0,
  'rejected mixed closure does not persist any special row'
);

insert into public.special_hours (
  id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at
) values (
  '79000000-0000-4000-8000-000000000005',
  '28000000-0000-4000-8000-000000000001', '2040-02-02', 1, false, '18:00', '23:00'
);
set local role authenticated;
select throws_ok(
  $$select public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001',
    '[]'::jsonb,
    '[
      {"id":"79000000-0000-4000-8000-000000000006","date":"2040-02-02","slotIndex":0,"isClosed":true,"opensAt":null,"closesAt":null,"spansNextDay":false,"reason":"Closed"}
    ]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]
  )$$,
  '22023', 'HOURS_CLOSED_DATE_MIXED',
  'a closed special date cannot coexist with an untouched open row'
);
reset role;
select is(
  (select count(*)::integer from public.special_hours where date = '2040-02-02' and not is_closed),
  1,
  'rejected closure leaves the existing open special row unchanged'
);

set local role authenticated;
select throws_ok(
  $$select public.save_restaurant_hours(
    '28000000-0000-4000-8000-000000000001', '[]'::jsonb, '[]'::jsonb,
    array['78000000-0000-4000-8000-000000000002']::uuid[], '{}'::uuid[]
  )$$,
  '42501', 'TENANT_ID_IMMUTABLE',
  'hours RPC rejects identifiers from another tenant'
);
reset role;
select is(
  (select count(*)::integer from public.business_hours where id = '78000000-0000-4000-8000-000000000002'),
  1,
  'cross-tenant hours row remains unchanged'
);

set local role authenticated;
select throws_ok(
  $$select public.save_product_catalog(
    '28000000-0000-4000-8000-000000000001',
    '{"id":"48000000-0000-4000-8000-000000000001","categoryId":"38000000-0000-4000-8000-000000000001","code":"PIZZA","name":"Partially changed","description":"","basePriceCents":1100,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0}'::jsonb,
    '[{"id":"58000000-0000-4000-8000-000000000001","name":"Changed group","required":false,"minSelect":0,"maxSelect":1,"sortOrder":0,"active":true,"options":[{"id":"68000000-0000-4000-8000-000000000001","name":"Invalid option","priceDeltaCents":-1,"sortOrder":0,"active":true}]}]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]
  )$$,
  '22023', 'PRODUCT_VALUE_INVALID',
  'invalid nested option rejects the complete catalogue transaction'
);
reset role;
select is(
  (select name from public.products where id = '48000000-0000-4000-8000-000000000001'),
  'Original product',
  'failed catalogue save rolls its earlier product update back'
);

set local role authenticated;
select is(
  public.save_product_catalog(
    '28000000-0000-4000-8000-000000000001',
    '{"id":"48000000-0000-4000-8000-000000000001","categoryId":"38000000-0000-4000-8000-000000000001","code":"PIZZA","name":"Saved atomically","description":"New description","basePriceCents":1500,"promotionalPriceCents":1300,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":true,"sortOrder":1}'::jsonb,
    '[{"id":"58000000-0000-4000-8000-000000000004","name":"New group","required":true,"minSelect":1,"maxSelect":1,"sortOrder":0,"active":true,"options":[{"id":"68000000-0000-4000-8000-000000000004","name":"New option","priceDeltaCents":200,"sortOrder":0,"active":true}]}]'::jsonb,
    array['58000000-0000-4000-8000-000000000001']::uuid[],
    array['68000000-0000-4000-8000-000000000001']::uuid[]
  ) ->> 'groups',
  '1',
  'valid catalogue save reports its nested groups'
);
reset role;
select is(
  (select name from public.products where id = '48000000-0000-4000-8000-000000000001'),
  'Saved atomically',
  'valid catalogue save updates product metadata'
);
select is(
  (select active from public.product_option_groups where id = '58000000-0000-4000-8000-000000000001'),
  false,
  'catalogue save deactivates removed option groups'
);
select is(
  (select active from public.product_options where id = '68000000-0000-4000-8000-000000000001'),
  false,
  'catalogue save deactivates options below removed groups'
);
select ok(
  exists (
    select 1 from public.product_option_groups pog
    join public.product_options po on po.option_group_id = pog.id
    where pog.id = '58000000-0000-4000-8000-000000000004'
      and po.id = '68000000-0000-4000-8000-000000000004'
      and pog.product_id = '48000000-0000-4000-8000-000000000001'
      and pog.active and po.active
  ),
  'catalogue save persists its complete replacement graph'
);

set local role authenticated;
select throws_ok(
  $$select public.save_product_catalog(
    '28000000-0000-4000-8000-000000000001',
    '{"id":"48000000-0000-4000-8000-000000000001","categoryId":"38000000-0000-4000-8000-000000000001","code":"PIZZA","name":"Should roll back","description":"","basePriceCents":1500,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":null,"active":true,"available":true,"featured":false,"sortOrder":0}'::jsonb,
    '[]'::jsonb,
    array['58000000-0000-4000-8000-000000000002']::uuid[], '{}'::uuid[]
  )$$,
  '42501', 'PRODUCT_REFERENCE_INVALID',
  'catalogue RPC rejects a same-tenant group owned by another product'
);
reset role;
select is(
  (select active from public.product_option_groups where id = '58000000-0000-4000-8000-000000000002'),
  true,
  'unrelated same-tenant product graph remains active'
);

set local role authenticated;
select throws_ok(
  $$select public.save_product_catalog(
    '28000000-0000-4000-8000-000000000001',
    '{"id":"48000000-0000-4000-8000-000000000001","categoryId":"38000000-0000-4000-8000-000000000001","code":"PIZZA","name":"Bad path","description":"","basePriceCents":1500,"promotionalPriceCents":null,"promotionStartsAt":null,"promotionEndsAt":null,"imagePath":"restaurants/28000000-0000-4000-8000-000000000002/products/bad.webp","active":true,"available":true,"featured":false,"sortOrder":0}'::jsonb,
    '[]'::jsonb, '{}'::uuid[], '{}'::uuid[]
  )$$,
  '22023', 'PRODUCT_IMAGE_PATH_INVALID',
  'catalogue RPC rejects an image path outside its tenant prefix'
);

select is(
  public.import_products_batch(
    '28000000-0000-4000-8000-000000000001',
    '{
      "products":[
        {"category":"Must not exist","categorySlug":"must-not-exist","code":"PIZZA","name":"Must not replace","description":"","basePriceCents":9999,"active":true,"available":true,"featured":false,"sortOrder":0},
        {"category":"Imported","categorySlug":"imported","code":"NEW","name":"New product","description":"","basePriceCents":2000,"active":true,"available":true,"featured":false,"sortOrder":0}
      ],
      "optionGroups":[
        {"productCode":"PIZZA","groupCode":"BASE","name":"Must not replace group","required":false,"minSelect":0,"maxSelect":1,"sortOrder":0,"active":true},
        {"productCode":"NEW","groupCode":"NEW-GROUP","name":"Imported group","required":false,"minSelect":0,"maxSelect":1,"sortOrder":0,"active":true}
      ],
      "options":[
        {"productCode":"PIZZA","groupCode":"BASE","optionCode":"SKIPPED-OPTION","name":"Must not exist","priceDeltaCents":0,"sortOrder":0,"active":true},
        {"productCode":"NEW","groupCode":"NEW-GROUP","optionCode":"NEW-OPTION","name":"Imported option","priceDeltaCents":300,"sortOrder":0,"active":true}
      ]
    }'::jsonb,
    'skip'
  ) -> 'products' -> 0 ->> 'outcome',
  'skipped',
  'skip mode reports an existing product as skipped'
);
reset role;
select is(
  (select count(*)::integer from public.categories where restaurant_id = '28000000-0000-4000-8000-000000000001' and slug = 'must-not-exist'),
  0,
  'skip mode does not create the skipped product category'
);
select ok(
  (select name = 'Original group' from public.product_option_groups where id = '58000000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.product_options where code = 'SKIPPED-OPTION'),
  'skip mode leaves skipped groups and options untouched'
);
select ok(
  exists (
    select 1 from public.products p
    join public.product_option_groups pog on pog.product_id = p.id
    join public.product_options po on po.option_group_id = pog.id
    where p.restaurant_id = '28000000-0000-4000-8000-000000000001'
      and p.code = 'NEW' and pog.code = 'NEW-GROUP' and po.code = 'NEW-OPTION'
  ),
  'skip batch still creates the complete graph for new products'
);
select is(
  (
    select count(*)::integer from public.audit_logs
    where restaurant_id = '28000000-0000-4000-8000-000000000001'
      and entity_type in ('restaurant_hours', 'product', 'product_batch')
  ),
  6,
  'successful transactional writes and import are audited once each'
);

update public.products
set image_path = 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/referenced.webp'
where id = '48000000-0000-4000-8000-000000000001';

insert into public.image_assets (
  id, restaurant_id, entity_type, entity_id, path, mime_type,
  size_bytes, width, height, created_by, deleted_at
) values
  ('88000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', 'product', '48000000-0000-4000-8000-000000000001', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/referenced.webp', 'image/webp', 100, 10, 10, '18000000-0000-4000-8000-000000000001', null),
  ('88000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', 'product', '48000000-0000-4000-8000-000000000001', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/unreferenced.webp', 'image/webp', 100, 10, 10, '18000000-0000-4000-8000-000000000001', null),
  ('88000000-0000-4000-8000-000000000003', '28000000-0000-4000-8000-000000000001', 'product', '48000000-0000-4000-8000-000000000001', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/missing.webp', 'image/webp', 100, 10, 10, '18000000-0000-4000-8000-000000000001', null),
  ('88000000-0000-4000-8000-000000000004', '28000000-0000-4000-8000-000000000001', 'product', '48000000-0000-4000-8000-000000000001', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/pending.webp', 'image/webp', 100, 10, 10, '18000000-0000-4000-8000-000000000001', now());

insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('restaurant-assets', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/referenced.webp', '18000000-0000-4000-8000-000000000001', '{"mimetype":"image/webp"}'),
  ('restaurant-assets', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/unreferenced.webp', '18000000-0000-4000-8000-000000000001', '{"mimetype":"image/webp"}'),
  ('restaurant-assets', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/pending.webp', '18000000-0000-4000-8000-000000000001', '{"mimetype":"image/webp"}'),
  ('restaurant-assets', 'restaurants/28000000-0000-4000-8000-000000000001/products/48000000-0000-4000-8000-000000000001/unregistered.webp', '18000000-0000-4000-8000-000000000001', '{"mimetype":"image/webp"}');

set local role authenticated;
select is(
  (select count(*)::integer from public.list_orphan_image_assets('28000000-0000-4000-8000-000000000001')),
  4,
  'asset inventory detects every inconsistency class without listing referenced assets'
);
select is(
  (
    select string_agg(issue || ':' || regexp_replace(path, '^.*/', ''), ',' order by path)
    from public.list_orphan_image_assets('28000000-0000-4000-8000-000000000001')
  ),
  'missing_storage_object:missing.webp,pending_storage_delete:pending.webp,unreferenced_asset:unreferenced.webp,unregistered_storage_object:unregistered.webp',
  'asset inventory classifies missing, pending, unreferenced, and unregistered objects'
);
select is(
  (
    select count(*)::integer
    from public.list_orphan_image_assets('28000000-0000-4000-8000-000000000001')
    where path like '%/referenced.webp'
  ),
  0,
  'asset inventory excludes an object still referenced by product metadata'
);
select throws_ok(
  $$select * from public.list_orphan_image_assets('28000000-0000-4000-8000-000000000002')$$,
  '42501', 'ASSET_INVENTORY_FORBIDDEN',
  'restaurant administrator cannot inspect another tenant asset inventory'
);
reset role;

select * from finish();
rollback;
