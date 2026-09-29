begin;

do $$
begin
  if (select count(*) from public.platform_user_roles pur join public.profiles p on p.id = pur.user_id and p.active where pur.role = 'super_admin') <> 1 then
    raise exception 'EXPECTED_ONE_ACTIVE_SUPER_ADMIN';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select pur.user_id from public.platform_user_roles pur join public.profiles p on p.id = pur.user_id and p.active where pur.role = 'super_admin'),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);

select public.import_products_batch(
  'a5501eb8-4e60-4a01-8afe-a795ed135009',
  '{
    "products": [
      {"category":"Hamburguesas","categorySlug":"hamburguesas","code":"BUR-CLASICA","name":"Hamburguesa Clásica","description":"Medallón de carne, cheddar, lechuga, tomate, pepinos y salsa de la casa.","basePriceCents":1150000,"active":true,"available":true,"featured":true,"sortOrder":10},
      {"category":"Hamburguesas","categorySlug":"hamburguesas","code":"BUR-BACON","name":"Bacon BBQ","description":"Medallón de carne, cheddar, bacon crocante, cebolla caramelizada y salsa BBQ.","basePriceCents":1350000,"active":true,"available":true,"featured":true,"sortOrder":20},
      {"category":"Hamburguesas","categorySlug":"hamburguesas","code":"BUR-DOBLE","name":"Doble Mozzi","description":"Doble medallón de carne, doble cheddar, pepinos, cebolla morada y salsa de la casa.","basePriceCents":1490000,"active":true,"available":true,"featured":false,"sortOrder":30},
      {"category":"Hamburguesas","categorySlug":"hamburguesas","code":"POL-CRISPY","name":"Pollo Crispy","description":"Pechuga de pollo crocante, lechuga, pepinos y salsa cremosa en pan brioche.","basePriceCents":1200000,"active":true,"available":true,"featured":false,"sortOrder":40},
      {"category":"Pizzas","categorySlug":"pizzas","code":"PIZ-MUZZ","name":"Pizza Mozzarella","description":"Salsa de tomate, abundante mozzarella y orégano.","basePriceCents":1400000,"active":true,"available":true,"featured":true,"sortOrder":10},
      {"category":"Pizzas","categorySlug":"pizzas","code":"PIZ-PEPP","name":"Pizza Pepperoni","description":"Salsa de tomate, mozzarella y pepperoni dorado.","basePriceCents":1650000,"active":true,"available":true,"featured":false,"sortOrder":20},
      {"category":"Pizzas","categorySlug":"pizzas","code":"PIZ-NAPO","name":"Pizza Napolitana","description":"Mozzarella, tomate en rodajas, ajo y orégano.","basePriceCents":1550000,"active":true,"available":true,"featured":false,"sortOrder":30},
      {"category":"Acompañamientos","categorySlug":"acompanamientos","code":"SIDE-PAPAS","name":"Papas Fritas","description":"Porción generosa de papas finas, doradas y crocantes.","basePriceCents":550000,"active":true,"available":true,"featured":false,"sortOrder":10},
      {"category":"Acompañamientos","categorySlug":"acompanamientos","code":"SIDE-EMP6","name":"Empanadas x6","description":"Seis empanadas de carne al horno con masa dorada.","basePriceCents":1050000,"active":true,"available":true,"featured":false,"sortOrder":20},
      {"category":"Bebidas","categorySlug":"bebidas","code":"BEB-LIMON","name":"Limonada Casera","description":"Limonada fresca con hielo, rodajas de limón y menta.","basePriceCents":350000,"active":true,"available":true,"featured":false,"sortOrder":10}
    ],
    "optionGroups": [],
    "options": []
  }'::jsonb,
  'upsert'
);

select public.save_restaurant_hours(
  'a5501eb8-4e60-4a01-8afe-a795ed135009',
  '[
    {"id":"da0b53ef-04a8-41e5-8884-f0e67514f1ec","dayOfWeek":0,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"64317749-5d1b-4d36-ba3e-9f8d23aa89e7","dayOfWeek":1,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"80b9cf61-0e07-4e3c-ae6d-50babe548e08","dayOfWeek":2,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"49b18885-8a72-4fb8-a09e-24fb0b21f3f1","dayOfWeek":3,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"50bba86a-72ae-483d-b8d4-02b8ce4eeac2","dayOfWeek":4,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"cf3fbfb9-68f7-4bc4-9b9d-123dc03789d5","dayOfWeek":5,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true},
    {"id":"58a3a510-78eb-4c13-bdfe-7ed07163aeb6","dayOfWeek":6,"slotIndex":0,"opensAt":"00:00","closesAt":"23:59","spansNextDay":false,"active":true}
  ]'::jsonb,
  '[]'::jsonb,
  '{}'::uuid[],
  '{}'::uuid[]
);

update public.restaurants
set status = 'active', public_menu_enabled = true
where id = 'a5501eb8-4e60-4a01-8afe-a795ed135009';

commit;

select jsonb_build_object(
  'restaurant', (
    select jsonb_build_object('slug', slug, 'status', status, 'publicMenuEnabled', public_menu_enabled)
    from public.restaurants
    where id = 'a5501eb8-4e60-4a01-8afe-a795ed135009'
  ),
  'products', (
    select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) order by code)
    from public.products
    where restaurant_id = 'a5501eb8-4e60-4a01-8afe-a795ed135009' and deleted_at is null
  ),
  'hours', (select count(*) from public.business_hours where restaurant_id = 'a5501eb8-4e60-4a01-8afe-a795ed135009' and active)
) as seeded;
