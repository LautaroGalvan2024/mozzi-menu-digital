-- Supabase-managed projects may install explicit default EXECUTE grants for
-- API roles. Revoking only from PUBLIC does not remove those role-specific
-- grants, so every callable RPC is reset and then granted to its exact actor.

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated, service_role;

revoke all on function public.get_public_menu(text) from public, anon, authenticated, service_role;
revoke all on function public.get_actor_authorization() from public, anon, authenticated, service_role;
revoke all on function public.get_order_by_action(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_order(uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_order(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_order(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.expire_orders(timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function public.check_rate_limit(text, uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.cleanup_rate_limits(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.check_order_rate_limits(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_order_transaction(jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.register_whatsapp_opened(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.create_restaurant_transaction(jsonb, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) from public, anon, authenticated, service_role;
revoke all on function public.import_products_batch(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.get_order_metrics(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.set_restaurant_member_status(uuid, public.membership_status) from public, anon, authenticated, service_role;
revoke all on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.list_orphan_image_assets(uuid) from public, anon, authenticated, service_role;

grant execute on function public.get_public_menu(text) to anon, authenticated;

grant execute on function public.get_actor_authorization() to authenticated;
grant execute on function public.get_order_by_action(uuid) to authenticated;
grant execute on function public.claim_order(uuid) to authenticated;
grant execute on function public.complete_order(uuid) to authenticated;
grant execute on function public.cancel_order(uuid, text) to authenticated;
grant execute on function public.import_products_batch(uuid, jsonb, text) to authenticated;
grant execute on function public.get_order_metrics(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.set_restaurant_member_status(uuid, public.membership_status) to authenticated;
grant execute on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[]) to authenticated;
grant execute on function public.save_product_catalog(uuid, jsonb, jsonb, uuid[], uuid[]) to authenticated;
grant execute on function public.list_orphan_image_assets(uuid) to authenticated;

grant execute on function public.expire_orders(timestamptz, integer) to service_role;
grant execute on function public.check_rate_limit(text, uuid, integer, integer) to service_role;
grant execute on function public.cleanup_rate_limits(timestamptz) to service_role;
grant execute on function public.check_order_rate_limits(text, text, text) to service_role;
grant execute on function public.create_order_transaction(jsonb, text, text, text) to service_role;
grant execute on function public.register_whatsapp_opened(uuid, text) to service_role;
grant execute on function public.create_restaurant_transaction(jsonb, uuid, uuid, text, uuid) to service_role;
grant execute on function public.upsert_restaurant_membership(uuid, uuid, public.restaurant_role, public.membership_status, uuid) to service_role;

comment on schema public is
  'API schema. Function EXECUTE is deny-by-default and granted explicitly by 202609290001_function_execute_privilege_hardening.sql.';
