-- B03: preserve the allocator -> product lock order and validate complete option graphs.
-- No historical catalogue data is silently repaired by this migration.
do $$
begin
  if exists (
    select 1 from public.product_option_groups g
    where g.active and (g.max_select not between 1 and 20
      or g.min_select > (select count(*) from public.product_options o where o.option_group_id=g.id and o.active))
  ) then
    raise exception using errcode='22023', message='CATALOG_INVALID_OPTION_GROUPS_REVIEW_REQUIRED';
  end if;
end;
$$;

-- A row BEFORE UPDATE trigger runs after the product row was locked. Acquiring
-- the allocator there would invert save/import's allocator -> product order.
-- Column ACLs reject direct code updates before any row is touched. Other direct
-- updates (images, operational flags and soft deletion) retain their existing RLS.
revoke update on public.products from public, anon, authenticated;
revoke update (code, id, restaurant_id, created_by, created_at) on public.products from public, anon, authenticated;
grant update (
  category_id, name, description, base_price_cents,
  promotional_price_cents, promotion_starts_at, promotion_ends_at, image_path,
  active, available, featured, sort_order, deleted_at,
  updated_by, updated_at
) on public.products to authenticated;

-- Browser edits already use save_product_catalog/import_products_batch. Requiring
-- those atomic operations prevents direct deactivation of options from bypassing
-- the final min_select <= active options check or racing another graph edit.
revoke insert, update, delete on public.product_option_groups, public.product_options
  from public, anon, authenticated;

alter table public.product_option_groups
  add constraint product_option_groups_active_max_positive check (not active or max_select >= 1);

create or replace function private.enforce_option_group_selection_limit()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.max_select > 20 then
    raise exception using errcode='22023', message='OPTION_GROUP_MAX_SELECT_EXCEEDED';
  end if;
  if new.active and new.max_select < 1 then
    raise exception using errcode='22023', message='OPTION_GROUP_SELECTION_INVALID';
  end if;
  return new;
end;
$$;
drop trigger product_option_groups_selection_limit on public.product_option_groups;
create trigger product_option_groups_selection_limit
before insert or update of max_select, active on public.product_option_groups
for each row execute function private.enforce_option_group_selection_limit();
revoke all on function private.enforce_option_group_selection_limit() from public, anon, authenticated;
