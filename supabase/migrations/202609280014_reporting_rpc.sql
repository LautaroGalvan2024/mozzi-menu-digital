create or replace function public.get_order_metrics(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not private.can_manage_orders(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'ORDER_METRICS_FORBIDDEN';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception using errcode = '22023', message = 'METRICS_RANGE_INVALID';
  end if;

  select jsonb_build_object(
    'generated', count(*),
    'whatsappOpened', count(*) filter (where o.whatsapp_opened_at is not null),
    'accepted', count(*) filter (where o.accepted_at is not null),
    'completed', count(*) filter (where o.status = 'completed'),
    'cancelled', count(*) filter (where o.status = 'cancelled'),
    'expired', count(*) filter (where o.status = 'expired'),
    'acceptedAmountCents', coalesce(sum(o.total_cents) filter (
      where o.status in ('accepted', 'completed')
    ), 0)::text,
    'completedAmountCents', coalesce(sum(o.total_cents) filter (
      where o.status = 'completed'
    ), 0)::text,
    'byFulfillment', coalesce((
      select jsonb_object_agg(x.fulfillment_type, x.quantity)
      from (
        select o2.fulfillment_type::text as fulfillment_type, count(*) as quantity
        from public.orders o2
        where o2.restaurant_id = p_restaurant_id
          and o2.created_at >= p_from and o2.created_at < p_to
        group by o2.fulfillment_type
      ) x
    ), '{}'::jsonb),
    'byPaymentMethod', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', x.payment_method_name_snapshot,
        'count', x.quantity,
        'amountCents', x.amount_cents::text
      ) order by x.payment_method_name_snapshot)
      from (
        select o3.payment_method_name_snapshot, count(*) as quantity,
               sum(o3.total_cents) as amount_cents
        from public.orders o3
        where o3.restaurant_id = p_restaurant_id
          and o3.created_at >= p_from and o3.created_at < p_to
        group by o3.payment_method_name_snapshot
      ) x
    ), '[]'::jsonb)
  ) into v_result
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and o.created_at >= p_from and o.created_at < p_to;

  return v_result;
end;
$$;

revoke all on function public.get_order_metrics(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_order_metrics(uuid, timestamptz, timestamptz) to authenticated;
