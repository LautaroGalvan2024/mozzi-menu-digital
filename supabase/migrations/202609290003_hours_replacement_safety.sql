-- Replace schedule rows atomically so moving or swapping their unique
-- day/date + slot coordinates cannot collide with the rows being replaced.
-- A closed special date is represented by exactly one row and cannot coexist
-- with open slots for the same date.
create or replace function public.save_restaurant_hours(
  p_restaurant_id uuid,
  p_regular jsonb,
  p_special jsonb,
  p_delete_regular_ids uuid[] default '{}'::uuid[],
  p_delete_special_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row jsonb;
  v_regular_count integer := 0;
  v_special_count integer := 0;
begin
  if v_uid is null or not private.can_manage_restaurant(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'HOURS_MANAGEMENT_FORBIDDEN';
  end if;
  if jsonb_typeof(p_regular) <> 'array' or jsonb_array_length(p_regular) > 147
     or jsonb_typeof(p_special) <> 'array' or jsonb_array_length(p_special) > 1000
     or pg_column_size(p_regular) + pg_column_size(p_special) > 1048576 then
    raise exception using errcode = '22023', message = 'HOURS_PAYLOAD_INVALID';
  end if;

  -- Validate every caller-controlled identifier before deleting any row. This
  -- keeps replacement atomic and prevents a foreign-tenant UUID from being
  -- hidden by the delete/reinsert sequence below.
  if exists (
    select 1 from public.business_hours bh
    where bh.id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]))
      and bh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1 from public.special_hours sh
    where sh.id = any(coalesce(p_delete_special_ids, '{}'::uuid[]))
      and sh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1
    from jsonb_array_elements(p_regular) item(value)
    join public.business_hours bh on bh.id = (item.value ->> 'id')::uuid
    where bh.restaurant_id <> p_restaurant_id
  ) or exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    join public.special_hours sh on sh.id = (item.value ->> 'id')::uuid
    where sh.restaurant_id <> p_restaurant_id
  ) then
    raise exception using errcode = '42501', message = 'TENANT_ID_IMMUTABLE';
  end if;

  -- A date-level closure is a single override, never one slot among others.
  if exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    group by (item.value ->> 'date')::date
    having bool_or(coalesce((item.value ->> 'isClosed')::boolean, false))
       and count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'HOURS_CLOSED_DATE_MIXED';
  end if;

  -- Explicit removals and every existing payload row are deleted before any
  -- insert. All statements remain in the caller's RPC transaction, so a later
  -- validation or constraint failure restores the original schedule.
  delete from public.business_hours
  where restaurant_id = p_restaurant_id
    and (
      id = any(coalesce(p_delete_regular_ids, '{}'::uuid[]))
      or id in (
        select (item.value ->> 'id')::uuid
        from jsonb_array_elements(p_regular) item(value)
      )
    );
  delete from public.special_hours
  where restaurant_id = p_restaurant_id
    and (
      id = any(coalesce(p_delete_special_ids, '{}'::uuid[]))
      or id in (
        select (item.value ->> 'id')::uuid
        from jsonb_array_elements(p_special) item(value)
      )
    );

  -- Include special rows not replaced by this payload when checking the
  -- resulting dates. This rejects both adding a closure beside an existing
  -- open slot and adding an open slot beside an existing closure.
  if exists (
    select 1
    from jsonb_array_elements(p_special) item(value)
    join public.special_hours sh
      on sh.restaurant_id = p_restaurant_id
     and sh.date = (item.value ->> 'date')::date
    where coalesce((item.value ->> 'isClosed')::boolean, false)
       or sh.is_closed
  ) then
    raise exception using errcode = '22023', message = 'HOURS_CLOSED_DATE_MIXED';
  end if;

  for v_row in select value from jsonb_array_elements(p_regular) loop
    insert into public.business_hours (
      id, restaurant_id, day_of_week, slot_index, opens_at, closes_at, spans_next_day, active
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'dayOfWeek')::smallint,
      (v_row ->> 'slotIndex')::smallint, (v_row ->> 'opensAt')::time,
      (v_row ->> 'closesAt')::time, coalesce((v_row ->> 'spansNextDay')::boolean, false),
      coalesce((v_row ->> 'active')::boolean, true)
    ) on conflict (id) do update set
      day_of_week = excluded.day_of_week,
      slot_index = excluded.slot_index,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      active = excluded.active,
      updated_at = now()
    where public.business_hours.restaurant_id = p_restaurant_id;
    v_regular_count := v_regular_count + 1;
  end loop;

  for v_row in select value from jsonb_array_elements(p_special) loop
    insert into public.special_hours (
      id, restaurant_id, date, slot_index, is_closed, opens_at, closes_at, spans_next_day, reason
    ) values (
      (v_row ->> 'id')::uuid, p_restaurant_id, (v_row ->> 'date')::date,
      (v_row ->> 'slotIndex')::smallint, coalesce((v_row ->> 'isClosed')::boolean, false),
      nullif(v_row ->> 'opensAt', '')::time, nullif(v_row ->> 'closesAt', '')::time,
      coalesce((v_row ->> 'spansNextDay')::boolean, false), nullif(btrim(v_row ->> 'reason'), '')
    ) on conflict (id) do update set
      date = excluded.date,
      slot_index = excluded.slot_index,
      is_closed = excluded.is_closed,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      spans_next_day = excluded.spans_next_day,
      reason = excluded.reason,
      updated_at = now()
    where public.special_hours.restaurant_id = p_restaurant_id;
    v_special_count := v_special_count + 1;
  end loop;

  insert into public.audit_logs (restaurant_id, actor_user_id, action, entity_type, metadata)
  values (
    p_restaurant_id, v_uid, 'update', 'restaurant_hours',
    jsonb_build_object('regular', v_regular_count, 'special', v_special_count,
      'deletedRegular', cardinality(coalesce(p_delete_regular_ids, '{}'::uuid[])),
      'deletedSpecial', cardinality(coalesce(p_delete_special_ids, '{}'::uuid[])))
  );
  return jsonb_build_object('regular', v_regular_count, 'special', v_special_count);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or unique_violation then
  raise exception using errcode = '22023', message = 'HOURS_VALUE_INVALID';
end;
$$;

revoke all on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[])
  to authenticated;

comment on function public.save_restaurant_hours(uuid, jsonb, jsonb, uuid[], uuid[]) is
  'Atomically replaces authorized schedule rows, supports coordinate swaps, and enforces exclusive date-level closures.';
