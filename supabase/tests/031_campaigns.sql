begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
create function pg_temp.cid(n integer) returns uuid language sql immutable as $$ select ('31310000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
grant execute on function pg_temp.cid(integer) to authenticated;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 (pg_temp.cid(1),'campaign-admin@example.test',now(),'{}'),(pg_temp.cid(2),'campaign-manager@example.test',now(),'{}');
insert into restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled,store_enabled) values
 (pg_temp.cid(10),'Campaign fixture','Campaign fixture','campaign-fixture','active','+5491111111111','CMP',true,true),
 (pg_temp.cid(11),'Other fixture','Other fixture','campaign-other','active','+5491111111111','CPO',true,false);
insert into restaurant_members(restaurant_id,user_id,role,status) values
 (pg_temp.cid(10),pg_temp.cid(1),'restaurant_admin','active'),(pg_temp.cid(10),pg_temp.cid(2),'order_manager','active');
insert into categories(id,restaurant_id,name,slug) values(pg_temp.cid(20),pg_temp.cid(10),'Fixture','fixture'),(pg_temp.cid(21),pg_temp.cid(11),'Other','other');
insert into products(id,restaurant_id,category_id,code,name,base_price_cents) values
 (pg_temp.cid(30),pg_temp.cid(10),pg_temp.cid(20),'001','Product',1000),(pg_temp.cid(31),pg_temp.cid(11),pg_temp.cid(21),'002','Foreign product',2000);
insert into image_assets(restaurant_id,entity_type,entity_id,path,mime_type,size_bytes,width,height,created_by)
 values(pg_temp.cid(10),'promotion',pg_temp.cid(40),'restaurants/'||pg_temp.cid(10)::text||'/promotions/campaign.webp','image/webp',100,100,100,pg_temp.cid(1));
create function pg_temp.cdoc(extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('kind','magazine','title','Our offers','description','Selected products','imagePath',null,'channels',jsonb_build_array('menu','store'),
 'status','draft','startsAt',null,'endsAt',null,'productIds',jsonb_build_array(pg_temp.cid(30)),'targetKind','catalog','targetId',null,'sortOrder',0)||extra
$$;
grant execute on function pg_temp.cdoc(jsonb) to authenticated;
select ok(not has_table_privilege('anon','public.campaigns','select'),'anonymous cannot read the editorial table');
select ok(not has_table_privilege('authenticated','private.stage_one_features','insert'),'commerce members cannot opt themselves in');
select ok(not has_function_privilege('anon','public.get_stage_one_features(uuid)','execute'),'only authenticated commerce members can read the flags');
select ok(not has_function_privilege('anon','public.save_campaign(uuid,uuid,uuid,bigint,jsonb)','execute'),'anonymous cannot save campaigns');
select ok(not has_function_privilege('authenticated','private.campaign_document(public.campaigns)','execute'),'projection helper is not callable by clients');
select set_config('request.jwt.claim.sub',pg_temp.cid(1)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.cid(1),'role','authenticated','aal','aal1')::text,true);
set local role authenticated;
select is(public.get_stage_one_features(pg_temp.cid(10)),
 '{"campaigns":false,"sellers":false,"delivery_schedule":false,"assisted_import":false,"stock_design":false}'::jsonb,
 'existing commerces start with every pilot module disabled');
select throws_ok($$select public.get_stage_one_features(pg_temp.cid(11))$$,'42501','FORBIDDEN','flags are tenant-scoped');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(100),null,pg_temp.cdoc())$$,
 '42501','CAMPAIGN_FORBIDDEN','a catalogue admin cannot create a campaign without opt-in');
reset role;
insert into private.stage_one_features(restaurant_id,campaigns) values(pg_temp.cid(10),true);
set local role authenticated;
select is(public.get_stage_one_features(pg_temp.cid(10)),
 '{"campaigns":true,"sellers":false,"delivery_schedule":false,"assisted_import":false,"stock_design":false}'::jsonb,
 'campaign activation is independent from the other pilots');
select is(public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(100),null,pg_temp.cdoc())->>'version','1','admin saves initial draft');
select is(jsonb_array_length(public.get_admin_campaigns(pg_temp.cid(10))),1,'admin can list own drafts');
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store'),null::jsonb,'draft has no public preview');
select is(jsonb_array_length(public.get_public_campaigns('campaign-fixture','store')->'items'),0,'draft never appears as banner');
select is(public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(100),null,pg_temp.cdoc())->>'version','1','same request recovers result without writing another version');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(100),null,pg_temp.cdoc('{"title":"Changed replay"}'))$$,'22023','CAMPAIGN_REQUEST_CONFLICT','request identity cannot carry different content');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(101),0,pg_temp.cdoc())$$,'PT409','CAMPAIGN_CHANGED','stale editor cannot overwrite saved draft');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(41),pg_temp.cid(102),null,pg_temp.cdoc(jsonb_build_object('productIds',jsonb_build_array(pg_temp.cid(31)))))$$,'22023','CAMPAIGN_PRODUCT_INVALID','selection cannot include another tenant product');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(41),pg_temp.cid(102),null,pg_temp.cdoc(jsonb_build_object('productIds',jsonb_build_array(pg_temp.cid(30),pg_temp.cid(30)))))$$,'22023','CAMPAIGN_INVALID','duplicate selections are rejected server-side');
select throws_ok($$select public.get_admin_campaigns(pg_temp.cid(11))$$,'42501','CAMPAIGN_FORBIDDEN','admin cannot inspect another tenant');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(41),pg_temp.cid(102),null,pg_temp.cdoc('{"status":"published","productIds":[]}'))$$,'22023','CAMPAIGN_EMPTY','empty magazine cannot be published');
select is(public.save_campaign(pg_temp.cid(10),pg_temp.cid(40),pg_temp.cid(103),1,pg_temp.cdoc(jsonb_build_object('status','published','imagePath','restaurants/'||pg_temp.cid(10)::text||'/promotions/campaign.webp')))->>'version','2','publishes with existing tenant image');
select is(public.prepare_image_asset_cleanup(pg_temp.cid(10),'restaurants/'||pg_temp.cid(10)::text||'/promotions/campaign.webp')->>'retained','true','cleanup preserves campaign image');
select is(jsonb_array_length(public.get_public_campaigns('campaign-fixture','menu')->'items'),1,'published campaign appears in menu');
select is(jsonb_array_length(public.get_public_campaigns('campaign-fixture','store')->'items'),1,'same campaign appears in store without cloning');
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')#>>'{products,0,basePriceCents}','1000','public magazine projects current catalogue product');
select ok(not ((public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')->'campaign') ? 'last_request_hash'),'private request metadata is excluded');
select is(public.get_public_campaign('campaign-other',pg_temp.cid(40)::text,'menu'),null::jsonb,'public lookup is tenant-bound');
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'unsupported'),null::jsonb,'unsupported channel has no oracle');
select is(public.save_campaign(pg_temp.cid(10),pg_temp.cid(42),pg_temp.cid(104),null,pg_temp.cdoc(jsonb_build_object('status','published','startsAt',now()+interval '1 hour','endsAt',now()+interval '2 hours')))->>'version','1','future publication can be scheduled');
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(42)::text,'store'),null::jsonb,'future magazine has no anonymous preview');
select ok((public.get_public_campaigns('campaign-fixture','store')->>'validUntil')::timestamptz>now(),'public list exposes next scheduling boundary');
reset role;
update private.stage_one_features set campaigns=false where restaurant_id=pg_temp.cid(10);
select is(public.get_public_campaigns('campaign-fixture','store'),null::jsonb,'switching off campaigns hides public banners');
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store'),null::jsonb,'switching off campaigns hides previously shared magazines');
select is((select status from public.campaigns where id=pg_temp.cid(40)),'published','disabling the module preserves campaign state');
update private.stage_one_features set campaigns=true where restaurant_id=pg_temp.cid(10);
update products set base_price_cents=1500 where id=pg_temp.cid(30);
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')#>>'{products,0,basePriceCents}','1500','web selection never freezes catalogue prices');
update products set active=false where id=pg_temp.cid(30);
select is(jsonb_array_length(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')->'products'),0,'hidden products cannot leak through publication');
update products set active=true where id=pg_temp.cid(30);
update campaigns set ends_at=now()-interval '1 minute' where id=pg_temp.cid(40);
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')->>'expired','true','previous publication exposes explicit ended state');
select is(jsonb_array_length(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store')->'products'),0,'ended magazine does not advertise products');
update campaigns set status='paused' where id=pg_temp.cid(40);
select is(public.get_public_campaign('campaign-fixture',pg_temp.cid(40)::text,'store'),null::jsonb,'paused publication is private');
select set_config('request.jwt.claim.sub',pg_temp.cid(2)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.cid(2),'role','authenticated','aal','aal1')::text,true);
set local role authenticated;
select is(public.get_stage_one_features(pg_temp.cid(10))->>'campaigns','true','same-tenant order managers can read the flag');
select is((select count(*)::integer from campaigns),0,'order manager cannot read drafts through table RLS');
select throws_ok($$select public.save_campaign(pg_temp.cid(10),pg_temp.cid(43),pg_temp.cid(105),null,pg_temp.cdoc())$$,'42501','CAMPAIGN_FORBIDDEN','order manager cannot publish or save');
reset role;
update restaurants set store_enabled=false where id=pg_temp.cid(10);
select is(public.get_public_campaigns('campaign-fixture','store'),null::jsonb,'unpublishing channel hides all campaigns');
select * from finish();
rollback;
