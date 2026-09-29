create or replace function private.order_admin_json(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'restaurantId', o.restaurant_id,
    'actionId', o.action_id,
    'displayNumber', o.display_number,
    'status', o.status,
    'customerName', o.customer_name,
    'customerPhone', o.customer_phone,
    'fulfillmentType', o.fulfillment_type,
    'deliveryAddress', o.delivery_address,
    'deliveryCity', o.delivery_city,
    'deliveryNeighborhood', o.delivery_neighborhood,
    'deliveryFloor', o.delivery_floor,
    'deliveryApartment', o.delivery_apartment,
    'deliveryReference', o.delivery_reference,
    'customerNotes', o.customer_notes,
    'paymentMethodName', o.payment_method_name_snapshot,
    'paymentInstructions', o.payment_instructions_snapshot,
    'transferAlias', o.payment_transfer_alias_snapshot,
    'subtotalCents', o.subtotal_cents::text,
    'discountCents', o.discount_cents::text,
    'surchargeCents', o.surcharge_cents::text,
    'deliveryFeeCents', o.delivery_fee_cents::text,
    'totalCents', o.total_cents::text,
    'currencyCode', o.currency_code,
    'whatsappOpenedAt', o.whatsapp_opened_at,
    'acceptedBy', o.accepted_by,
    'acceptedByName', accepted.full_name,
    'acceptedAt', o.accepted_at,
    'completedBy', o.completed_by,
    'completedByName', completed.full_name,
    'completedAt', o.completed_at,
    'cancelledBy', o.cancelled_by,
    'cancelledByName', cancelled.full_name,
    'cancelledAt', o.cancelled_at,
    'cancelReason', o.cancel_reason,
    'expiresAt', o.expires_at,
    'createdAt', o.created_at,
    'updatedAt', o.updated_at,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', oi.id,
          'productId', oi.product_id,
          'code', oi.product_code_snapshot,
          'name', oi.product_name_snapshot,
          'quantity', oi.quantity,
          'unitPriceCents', oi.unit_price_cents::text,
          'optionsTotalUnitCents', oi.options_total_unit_cents::text,
          'lineTotalCents', oi.line_total_cents::text,
          'notes', oi.notes,
          'options', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', oio.id,
                'groupName', oio.group_name_snapshot,
                'name', oio.option_name_snapshot,
                'priceDeltaCents', oio.price_delta_cents::text
              ) order by oio.created_at, oio.id
            ) from public.order_item_options oio where oio.order_item_id = oi.id
          ), '[]'::jsonb)
        ) order by oi.created_at, oi.id
      ) from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', oe.id,
          'eventType', oe.event_type,
          'fromStatus', oe.from_status,
          'toStatus', oe.to_status,
          'actorType', oe.actor_type,
          'actorUserId', oe.actor_user_id,
          'actorName', actor.full_name,
          'metadata', oe.metadata,
          'createdAt', oe.created_at
        ) order by oe.created_at, oe.id
      )
      from public.order_events oe
      left join public.profiles actor on actor.id = oe.actor_user_id
      where oe.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  left join public.profiles accepted on accepted.id = o.accepted_by
  left join public.profiles completed on completed.id = o.completed_by
  left join public.profiles cancelled on cancelled.id = o.cancelled_by
  where o.id = p_order_id
$$;

create or replace function public.get_order_by_action(p_action_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_restaurant_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select o.id, o.restaurant_id into v_order_id, v_restaurant_id
  from public.orders o where o.action_id = p_action_id;

  if v_order_id is null or not private.can_manage_orders(v_restaurant_id) then
    raise exception using errcode = '42501', message = 'ORDER_NOT_FOUND_OR_FORBIDDEN';
  end if;
  return private.order_admin_json(v_order_id);
end;
$$;

create or replace function public.claim_order(p_action_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_previous public.order_status;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;

  perform set_config('app.order_mutation', 'on', true);
  update public.orders o
  set status = 'accepted'::public.order_status,
      accepted_by = v_uid,
      accepted_at = now()
  where o.action_id = p_action_id
    and o.status in ('generated'::public.order_status, 'whatsapp_opened'::public.order_status)
    and (o.expires_at is null or o.expires_at > now())
    and private.can_manage_orders(o.restaurant_id)
  returning o.* into v_order;

  if found then
    v_previous := case when v_order.whatsapp_opened_at is null
      then 'generated'::public.order_status else 'whatsapp_opened'::public.order_status end;
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type, actor_user_id
    ) values (
      v_order.restaurant_id, v_order.id, 'order_claimed', v_previous, 'accepted',
      'authenticated_user', v_uid
    );
    insert into public.audit_logs (
      restaurant_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      v_order.restaurant_id, v_uid, 'claim_order', 'order', v_order.id,
      jsonb_build_object('displayNumber', v_order.display_number)
    );
    return jsonb_build_object(
      'claimed', true,
      'alreadyClaimed', false,
      'status', v_order.status,
      'acceptedBy', v_order.accepted_by,
      'acceptedAt', v_order.accepted_at,
      'order', private.order_admin_json(v_order.id)
    );
  end if;

  select o.* into v_order from public.orders o where o.action_id = p_action_id for update;
  if not found or not private.can_manage_orders(v_order.restaurant_id) then
    raise exception using errcode = '42501', message = 'ORDER_NOT_FOUND_OR_FORBIDDEN';
  end if;

  if v_order.status in ('generated', 'whatsapp_opened') and v_order.expires_at <= now() then
    v_previous := v_order.status;
    update public.orders set status = 'expired' where id = v_order.id returning * into v_order;
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type
    ) values (v_order.restaurant_id, v_order.id, 'order_expired', v_previous, 'expired', 'system');
  end if;

  return jsonb_build_object(
    'claimed', false,
    'alreadyClaimed', v_order.accepted_at is not null,
    'status', v_order.status,
    'acceptedBy', v_order.accepted_by,
    'acceptedAt', v_order.accepted_at,
    'order', private.order_admin_json(v_order.id)
  );
end;
$$;

create or replace function public.complete_order(p_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;
  perform set_config('app.order_mutation', 'on', true);

  update public.orders o
  set status = 'completed', completed_by = v_uid, completed_at = now()
  where o.id = p_order_id and o.status = 'accepted'
    and private.can_manage_orders(o.restaurant_id)
  returning o.* into v_order;

  if found then
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type, actor_user_id
    ) values (v_order.restaurant_id, v_order.id, 'order_completed', 'accepted', 'completed', 'authenticated_user', v_uid);
    insert into public.audit_logs (
      restaurant_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (v_order.restaurant_id, v_uid, 'complete_order', 'order', v_order.id, '{}'::jsonb);
    return jsonb_build_object('completed', true, 'order', private.order_admin_json(v_order.id));
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found or not private.can_manage_orders(v_order.restaurant_id) then
    raise exception using errcode = '42501', message = 'ORDER_NOT_FOUND_OR_FORBIDDEN';
  end if;
  return jsonb_build_object('completed', false, 'order', private.order_admin_json(v_order.id));
end;
$$;

create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_previous public.order_status;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'CANCEL_REASON_INVALID';
  end if;
  perform set_config('app.order_mutation', 'on', true);

  update public.orders o
  set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = v_reason
  where o.id = p_order_id
    and o.status in ('generated', 'whatsapp_opened', 'accepted')
    and private.can_manage_orders(o.restaurant_id)
  returning o.* into v_order;

  if found then
    v_previous := case
      when v_order.accepted_at is not null then 'accepted'::public.order_status
      when v_order.whatsapp_opened_at is not null then 'whatsapp_opened'::public.order_status
      else 'generated'::public.order_status end;
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type, actor_user_id,
      metadata
    ) values (
      v_order.restaurant_id, v_order.id, 'order_cancelled', v_previous, 'cancelled',
      'authenticated_user', v_uid, jsonb_build_object('reason', v_reason)
    );
    insert into public.audit_logs (
      restaurant_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      v_order.restaurant_id, v_uid, 'cancel_order', 'order', v_order.id,
      jsonb_build_object('reason', v_reason)
    );
    return jsonb_build_object('cancelled', true, 'order', private.order_admin_json(v_order.id));
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found or not private.can_manage_orders(v_order.restaurant_id) then
    raise exception using errcode = '42501', message = 'ORDER_NOT_FOUND_OR_FORBIDDEN';
  end if;
  return jsonb_build_object('cancelled', false, 'order', private.order_admin_json(v_order.id));
end;
$$;

create or replace function public.expire_orders(
  p_before timestamptz default now(),
  p_limit integer default 500
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if p_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'LIMIT_INVALID';
  end if;
  perform set_config('app.order_mutation', 'on', true);
  with candidates as (
    select o.id from public.orders o
    where o.status in ('generated', 'whatsapp_opened')
      and o.expires_at is not null and o.expires_at <= p_before
    order by o.expires_at
    limit p_limit
    for update skip locked
  ), changed as (
    update public.orders o set status = 'expired'
    from candidates c where o.id = c.id
    returning o.id, o.restaurant_id,
      case when o.whatsapp_opened_at is null then 'generated'::public.order_status
           else 'whatsapp_opened'::public.order_status end as previous_status
  ), events as (
    insert into public.order_events (
      restaurant_id, order_id, event_type, from_status, to_status, actor_type
    )
    select c.restaurant_id, c.id, 'order_expired', c.previous_status, 'expired', 'system'
    from changed c
    returning 1
  )
  select count(*) into v_count from events;
  -- Reuse the maintenance cadence to bound private anti-abuse storage growth.
  delete from private.rate_limits where window_start < now() - interval '2 days';
  return v_count;
end;
$$;

revoke all on function private.order_admin_json(uuid) from public, anon, authenticated;
revoke all on function public.get_order_by_action(uuid) from public;
revoke all on function public.claim_order(uuid) from public;
revoke all on function public.complete_order(uuid) from public;
revoke all on function public.cancel_order(uuid, text) from public;
revoke all on function public.expire_orders(timestamptz, integer) from public;

grant execute on function public.get_order_by_action(uuid) to authenticated;
grant execute on function public.claim_order(uuid) to authenticated;
grant execute on function public.complete_order(uuid) to authenticated;
grant execute on function public.cancel_order(uuid, text) to authenticated;
grant execute on function public.expire_orders(timestamptz, integer) to service_role;
