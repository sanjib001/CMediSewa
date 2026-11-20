-- 0026 Two bugs found by the B4a end-to-end test:
-- 1. available_slots stepped with `time + interval`, which wraps at midnight: a window
--    ending at 23:45 also offered 23:45–00:00. Slots are now stepped in whole minutes and
--    never pass the window's end.
-- 2. A doctor sending a patient back to the queue ("not here") moves the appointment from
--    in_consultation back to checked_in, which the status guard refused.

create or replace function available_slots(p_tenant uuid, p_doctor uuid, p_from date, p_to date)
returns table (slot_start timestamptz, slot_end timestamptz, mode text, capacity integer, room text)
language plpgsql stable
set search_path = pg_catalog, public
as $$
#variable_conflict use_variable
declare
  v_tz text; v_d date; w record; v_m integer; v_st integer; v_et integer; v_has_mod boolean; v_full_leave boolean;
begin
  select timezone into v_tz from tenants where id = p_tenant;
  if v_tz is null or p_to < p_from or p_to - p_from > 92 then return; end if;
  for v_d in select generate_series(p_from, p_to, interval '1 day')::date loop
    select exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor
                    and e.on_date = v_d and e.kind = 'leave' and e.start_time is null) into v_full_leave;
    continue when v_full_leave;
    select exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor
                    and e.on_date = v_d and e.kind = 'modified') into v_has_mod;
    for w in
      select s.start_time st, s.end_time et, s.slot_minutes sm, s.max_tokens mt, s.room rm
        from doctor_schedules s
       where not v_has_mod and s.tenant_id = p_tenant and s.member_id = p_doctor
         and s.weekday = extract(dow from v_d) and s.effective_from <= v_d and (s.effective_to is null or s.effective_to >= v_d)
      union all
      select e.start_time, e.end_time, e.slot_minutes, e.max_tokens, null
        from schedule_exceptions e
       where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d and e.kind in ('extra', 'modified')
      order by 1
    loop
      v_st := (extract(epoch from w.st) / 60)::integer;
      v_et := (extract(epoch from w.et) / 60)::integer;
      if w.sm is null then
        if not exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d
                        and e.kind = 'leave' and e.start_time < w.et and e.end_time > w.st) then
          slot_start := (v_d + w.st) at time zone v_tz; slot_end := (v_d + w.et) at time zone v_tz;
          mode := 'token'; capacity := w.mt; room := w.rm; return next;
        end if;
      else
        v_m := v_st;
        while v_m + w.sm <= v_et loop
          if not exists (select 1 from schedule_exceptions e where e.tenant_id = p_tenant and e.member_id = p_doctor and e.on_date = v_d
                          and e.kind = 'leave'
                          and (extract(epoch from e.start_time) / 60)::integer < v_m + w.sm
                          and (extract(epoch from e.end_time) / 60)::integer > v_m) then
            slot_start := (v_d + make_interval(mins => v_m)) at time zone v_tz;
            slot_end := (v_d + make_interval(mins => v_m + w.sm)) at time zone v_tz;
            mode := 'slot'; capacity := 1; room := w.rm; return next;
          end if;
          v_m := v_m + w.sm;
        end loop;
      end if;
    end loop;
  end loop;
end $$;

create or replace function appointments_status_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = old.status then return new; end if;
  if not ((old.status = 'requested'       and new.status in ('confirmed', 'cancelled'))
       or (old.status = 'confirmed'       and new.status in ('checked_in', 'cancelled', 'no_show'))
       or (old.status = 'checked_in'      and new.status in ('in_consultation', 'completed', 'cancelled'))
       or (old.status = 'in_consultation' and new.status in ('completed', 'checked_in'))) then
    raise exception 'ILLEGAL_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
