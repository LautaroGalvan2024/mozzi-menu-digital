-- Run only as trusted database administration after the commerce migrations.
-- Dedicated synthetic tenant: never resets existing shop stock or order history.
-- No Auth invitation API is called. Existing confirmed demo admins are reused.
-- All actor claims are transaction-local, following the existing seed convention.
begin;

do $pilot$
declare
  v_source_id constant uuid := 'a5501eb8-4e60-4a01-8afe-a795ed135009';
  v_slug constant text := 'mozzi-tienda-demo';
  v_seed_key constant uuid := '5088c12a-e4da-44e7-a52e-a380ce9b3e57';
  v_create_key constant uuid := '54cb4849-6f80-41b9-890b-9eb9d423db22';
  v_count_key constant uuid := 'f435684a-e72e-4e95-9156-41ab5da36a8e';
  v_actor uuid;
  v_admin uuid;
  v_admin_ids uuid[];
  v_primary_admin uuid;
  v_primary_email text;
  v_primary_name text;
  v_source public.restaurants%rowtype;
  v_existing_id uuid;
  v_restaurant_id uuid;
  v_category_id uuid := extensions.gen_random_uuid();
  v_family_id uuid := extensions.gen_random_uuid();
  v_record jsonb;
  v_created jsonb;
  v_variants jsonb;
  v_count_rows jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('commerce-pilot:' || v_slug, 0));
  if (select count(*) from public.platform_user_roles pur join public.profiles p on p.id=pur.user_id and p.active
      where pur.role='super_admin') <> 1 then
    raise exception 'EXPECTED_ONE_ACTIVE_SUPER_ADMIN';
  end if;
  select pur.user_id into v_actor from public.platform_user_roles pur
    join public.profiles p on p.id=pur.user_id and p.active where pur.role='super_admin';
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated','aal','aal2')::text,true);

  select id into v_existing_id from public.restaurants where slug=v_slug;
  select response into v_record from private.operation_idempotency
    where operation='seed_commerce_pilot_v1' and idempotency_key=v_seed_key;
  if v_record is not null then
    if v_existing_id is null or v_record->>'seedVersion' is distinct from '1'
      or v_record->>'slug' is distinct from v_slug
      or v_existing_id::text is distinct from v_record->>'restaurantId' then
      raise exception 'COMMERCE_PILOT_MARKER_MISMATCH';
    end if;
    -- An operated pilot is real application state: a seed replay never restocks
    -- sold units or reverses the administrator's subsequent changes.
    return;
  end if;
  if v_existing_id is not null then
    raise exception 'COMMERCE_PILOT_SLUG_NOT_OWNED';
  end if;
  if exists(select 1 from private.operation_idempotency
      where operation='seed_commerce_pilot_v1' and idempotency_key=v_seed_key) then
    raise exception 'COMMERCE_PILOT_MARKER_INCOMPLETE';
  end if;

  select * into v_source from public.restaurants where id=v_source_id;
  if not found then raise exception 'SOURCE_DEMO_NOT_FOUND'; end if;
  select array_agg(rm.user_id order by rm.created_at,rm.user_id) into v_admin_ids
    from public.restaurant_members rm join public.profiles p on p.id=rm.user_id and p.active
    join auth.users u on u.id=rm.user_id and u.email_confirmed_at is not null and u.email is not null
    where rm.restaurant_id=v_source_id and rm.role='restaurant_admin' and rm.status='active';
  if coalesce(cardinality(v_admin_ids),0)=0 then raise exception 'SOURCE_DEMO_CONFIRMED_ADMIN_REQUIRED'; end if;
  if (select count(*) from public.restaurant_members rm join public.profiles p on p.id=rm.user_id and p.active
      where rm.restaurant_id=v_source_id and rm.role='restaurant_admin' and rm.status='active')<>cardinality(v_admin_ids) then
    raise exception 'SOURCE_DEMO_ADMIN_NOT_CONFIRMED';
  end if;
  v_primary_admin:=v_admin_ids[1];
  select u.email,p.full_name into v_primary_email,v_primary_name
    from auth.users u join public.profiles p on p.id=u.id where u.id=v_primary_admin;

  v_created:=public.create_restaurant_transaction(
    jsonb_build_object('name','Mozzi Tienda Demo','tradeName','Mozzi Tienda Demo','slug',v_slug,
      'description','Tienda de demostración. Productos, precios y existencias ficticios para probar el catálogo y los pedidos.',
      'whatsappPhoneE164',v_source.whatsapp_phone_e164,'address',v_source.address,'city',v_source.city,
      'timezone',v_source.timezone,'currencyCode','ARS','locale','es-AR','primaryColor','#155E75','secondaryColor','#0F172A',
      'deliveryEnabled',false,'pickupEnabled',true,'minimumOrderCents',0,'defaultPreparationMinutes',30,
      'orderPrefix','TDEMO','createDefaultPaymentMethods',true,'adminName',v_primary_name),
    v_actor,v_primary_admin,v_primary_email,v_create_key);
  v_restaurant_id:=(v_created#>>'{restaurant,id}')::uuid;
  if v_restaurant_id is null or v_created#>>'{restaurant,slug}' is distinct from v_slug then
    raise exception 'COMMERCE_PILOT_CREATION_MISMATCH';
  end if;
  foreach v_admin in array v_admin_ids loop
    perform public.upsert_restaurant_membership(v_restaurant_id,v_admin,'restaurant_admin','active',v_actor);
  end loop;

  insert into public.categories(id,restaurant_id,name,slug,description,created_by,updated_by)
    values(v_category_id,v_restaurant_id,'Fundas para celulares','fundas','Modelos y colores de demostración.',v_actor,v_actor);
  select jsonb_agg(jsonb_build_object('productId',extensions.gen_random_uuid(),
    'attributes',jsonb_build_object('Modelo',model,'Color',color),
    'product',jsonb_build_object('code',code,'description','Funda de silicona de demostración. Producto ficticio.',
      'basePriceCents',1500000,'active',true,'available',true,'featured',true,'sortOrder',position,'quantityPrices','[]'::jsonb)) order by position)
    into v_variants from (values
      ('iPhone 15','Negro','DEMO-IP15-NEGRO',10),('iPhone 15','Azul','DEMO-IP15-AZUL',20),
      ('Samsung S24','Negro','DEMO-S24-NEGRO',30),('Samsung S24','Azul','DEMO-S24-AZUL',40)
    ) variants(model,color,code,position);
  perform public.save_product_family(v_restaurant_id,jsonb_build_object('id',v_family_id,'categoryId',v_category_id,
    'code','DEMO-FUNDAS','name','Funda de silicona','description','Elegí modelo y color. Artículo de demostración.',
    'axes',jsonb_build_array('Modelo','Color'),'active',true),v_variants);

  if exists(select 1 from public.orders where restaurant_id=v_restaurant_id)
    or exists(select 1 from public.inventory_balances where restaurant_id=v_restaurant_id)
    or (select count(*) from public.products where restaurant_id=v_restaurant_id)<>4 then
    raise exception 'COMMERCE_PILOT_EXPECTED_NEW_EMPTY_INVENTORY';
  end if;
  perform public.confirm_inventory_business_policy(v_restaurant_id,'{
    "unitModel":"whole_product","sourceOfTruth":"app","otherChannels":"none",
    "returns":"full_only","partialDeliveries":"none","physicalScope":"until_handoff_including_transit",
    "acceptance":"reserve","delivery":"physical_handoff","acceptedReservationsExpire":false
  }'::jsonb);
  perform public.begin_inventory_count(v_restaurant_id,v_count_key,'DEMO: apertura de inventario sintético');
  -- clock_timestamp must be taken after begin_inventory_count, not transaction now().
  select jsonb_agg(jsonb_build_object('productId',id,'quantity',10,'countedAt',clock_timestamp()) order by id)
    into v_count_rows from public.products where restaurant_id=v_restaurant_id and deleted_at is null;
  perform public.finish_inventory_count(v_count_key,v_count_rows,'{}'::uuid[],true,
    'DEMO: diez unidades ficticias por variante. Comercio nuevo, sin ventas ni movimientos físicos reales.',true);

  update public.restaurants set status='active',public_menu_enabled=false,store_enabled=true,
    store_ordering_policy='always',store_checkout_whatsapp_enabled=true,store_checkout_online_enabled=false
    where id=v_restaurant_id;
  insert into private.operation_idempotency(operation,idempotency_key,actor_user_id,response)
    values('seed_commerce_pilot_v1',v_seed_key,v_actor,jsonb_build_object('seedVersion',1,'restaurantId',v_restaurant_id,
      'slug',v_slug,'sourceRestaurantId',v_source_id,'familyId',v_family_id,'countId',v_count_key,'initialUnitsPerSku',10));
end;
$pilot$;

set constraints all immediate;
commit;

-- Public, aggregate verification only: no auth emails, credentials or tokens.
select jsonb_build_object('restaurantId',r.id,'slug',r.slug,'name',r.trade_name,'status',r.status,
  'storeEnabled',r.store_enabled,'menuEnabled',r.public_menu_enabled,'storeOrderingPolicy',r.store_ordering_policy,
  'whatsappEnabled',r.store_checkout_whatsapp_enabled,'onlineEnabled',r.store_checkout_online_enabled,
  'inventoryMode',r.inventory_mode,'pickupEnabled',r.pickup_enabled,'deliveryEnabled',r.delivery_enabled,
  'products',(select count(*) from public.products where restaurant_id=r.id and deleted_at is null),
  'families',(select count(*) from public.product_families where restaurant_id=r.id),
  'totalOnHand',(select coalesce(sum(on_hand),0) from public.inventory_balances where restaurant_id=r.id),
  'totalReserved',(select coalesce(sum(reserved),0) from public.inventory_balances where restaurant_id=r.id),
  'activeAdmins',(select count(*) from public.restaurant_members where restaurant_id=r.id and role='restaurant_admin' and status='active'),
  'seedOwned',exists(select 1 from private.operation_idempotency where operation='seed_commerce_pilot_v1'
    and idempotency_key='5088c12a-e4da-44e7-a52e-a380ce9b3e57' and response->>'restaurantId'=r.id::text)
) as commerce_pilot
from public.restaurants r where r.slug='mozzi-tienda-demo';
