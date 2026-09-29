-- Foundation: extensions, private schema and strongly typed state values.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  create type public.platform_role as enum ('super_admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.restaurant_role as enum ('restaurant_admin', 'order_manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.membership_status as enum ('invited', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.restaurant_status as enum ('draft', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fulfillment_type as enum ('delivery', 'pickup');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_adjustment_type as enum ('none', 'discount', 'surcharge');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_adjustment_scope as enum ('subtotal', 'shipping', 'total');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum (
    'generated',
    'whatsapp_opened',
    'accepted',
    'completed',
    'cancelled',
    'expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_actor_type as enum ('customer', 'authenticated_user', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.audit_action as enum (
    'create',
    'update',
    'delete',
    'invite',
    'activate',
    'suspend',
    'claim_order',
    'complete_order',
    'cancel_order',
    'import'
  );
exception when duplicate_object then null; end $$;

comment on schema private is
  'Server-only tables and helper functions. This schema must not be exposed by the Data API.';
