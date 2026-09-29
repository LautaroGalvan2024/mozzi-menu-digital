-- RLS is the authority. Anonymous users receive no direct access to base tables.
alter table public.profiles enable row level security;
alter table public.platform_user_roles enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_options enable row level security;
alter table public.business_hours enable row level security;
alter table public.special_hours enable row level security;
alter table public.payment_methods enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.restaurant_order_counters enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_options enable row level security;
alter table public.order_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.image_assets enable row level security;

create policy profiles_select_authorized on public.profiles
for select to authenticated
using (private.can_view_profile(id));

create policy profiles_update_self on public.profiles
for update to authenticated
using (id = (select auth.uid()) and active)
with check (id = (select auth.uid()) and active);

create policy platform_roles_select_authorized on public.platform_user_roles
for select to authenticated
using (user_id = (select auth.uid()) or private.is_super_admin());

create policy restaurants_select_member on public.restaurants
for select to authenticated
using (private.can_view_restaurant(id));

create policy restaurants_update_admin on public.restaurants
for update to authenticated
using (private.can_manage_restaurant(id))
with check (private.can_manage_restaurant(id));

create policy restaurant_members_select_authorized on public.restaurant_members
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.is_super_admin()
  or private.has_restaurant_role(
    restaurant_id,
    array['restaurant_admin']::public.restaurant_role[]
  )
);

-- Catalogue: active members can read; only restaurant admins (or aal2 super admins) can write.
do $do$
declare v_table text;
begin
  foreach v_table in array array[
    'categories', 'products', 'product_option_groups', 'product_options'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.can_view_restaurant(restaurant_id))',
      v_table || '_select_member', v_table
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_manage_catalog(restaurant_id))',
      v_table || '_insert_admin', v_table
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_manage_catalog(restaurant_id)) with check (private.can_manage_catalog(restaurant_id))',
      v_table || '_update_admin', v_table
    );
  end loop;
end;
$do$;

-- Tenant configuration has the same read boundary; order managers cannot mutate it.
do $do$
declare v_table text;
begin
  foreach v_table in array array[
    'business_hours', 'special_hours', 'payment_methods', 'delivery_zones'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.can_view_restaurant(restaurant_id))',
      v_table || '_select_member', v_table
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_manage_restaurant(restaurant_id))',
      v_table || '_insert_admin', v_table
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_manage_restaurant(restaurant_id)) with check (private.can_manage_restaurant(restaurant_id))',
      v_table || '_update_admin', v_table
    );
  end loop;
end;
$do$;

create policy orders_select_operator on public.orders
for select to authenticated
using (private.can_manage_orders(restaurant_id));

create policy order_items_select_operator on public.order_items
for select to authenticated
using (private.can_manage_orders(restaurant_id));

create policy order_item_options_select_operator on public.order_item_options
for select to authenticated
using (private.can_manage_orders(restaurant_id));

create policy order_events_select_operator on public.order_events
for select to authenticated
using (private.can_manage_orders(restaurant_id));

create policy audit_logs_select_restaurant_admin on public.audit_logs
for select to authenticated
using (
  private.is_super_admin()
  or (
    restaurant_id is not null
    and private.has_restaurant_role(
      restaurant_id,
      array['restaurant_admin']::public.restaurant_role[]
    )
  )
);

create policy image_assets_select_member on public.image_assets
for select to authenticated
using (private.can_view_restaurant(restaurant_id));

create policy image_assets_insert_admin on public.image_assets
for insert to authenticated
with check (
  private.can_manage_catalog(restaurant_id)
  and created_by = (select auth.uid())
);

create policy image_assets_update_admin on public.image_assets
for update to authenticated
using (private.can_manage_catalog(restaurant_id))
with check (private.can_manage_catalog(restaurant_id));

-- Explicit privileges complement RLS. No DELETE privilege is given for historical or soft-delete resources.
do $do$
declare v_table text;
begin
  foreach v_table in array array[
    'profiles', 'platform_user_roles', 'restaurants', 'restaurant_members',
    'categories', 'products', 'product_option_groups', 'product_options',
    'business_hours', 'special_hours', 'payment_methods', 'delivery_zones',
    'restaurant_order_counters', 'orders', 'order_items', 'order_item_options',
    'order_events', 'audit_logs', 'image_assets'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format('grant all privileges on table public.%I to service_role', v_table);
  end loop;
end;
$do$;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select on public.platform_user_roles, public.restaurants, public.restaurant_members to authenticated;
grant update on public.restaurants to authenticated;

grant select, insert, update on
  public.categories,
  public.products,
  public.product_option_groups,
  public.product_options,
  public.business_hours,
  public.special_hours,
  public.payment_methods,
  public.delivery_zones
to authenticated;

grant select, insert on public.image_assets to authenticated;
grant update (deleted_at) on public.image_assets to authenticated;

grant select on
  public.orders,
  public.order_items,
  public.order_item_options,
  public.order_events,
  public.audit_logs
to authenticated;

-- Counters are mutated only inside definer transactions and have intentionally no client policy/grant.

-- These helpers are referenced by stored RLS expressions. The private schema is not exposed
-- through PostgREST and retains no USAGE grant, so this does not create callable public RPCs.
grant execute on function private.is_super_admin() to authenticated;
grant execute on function private.is_super_admin_aal2() to authenticated;
grant execute on function private.has_restaurant_role(uuid, public.restaurant_role[]) to authenticated;
grant execute on function private.can_view_restaurant(uuid) to authenticated;
grant execute on function private.can_manage_restaurant(uuid) to authenticated;
grant execute on function private.can_manage_catalog(uuid) to authenticated;
grant execute on function private.can_manage_orders(uuid) to authenticated;
grant execute on function private.can_view_profile(uuid) to authenticated;
grant execute on function private.storage_restaurant_id(text) to authenticated;
