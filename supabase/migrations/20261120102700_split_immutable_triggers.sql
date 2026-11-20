-- 0028 Found by tests/db/clinical.test.mjs before any use: clinical_immutable() referenced
-- NEW.rx_number in one expression, and PL/pgSQL does not short-circuit AND, so every
-- encounter update failed ("record new has no field rx_number"). One function per table.
create or replace function encounters_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'finalized' then raise exception 'ENCOUNTER_FINALIZED' using errcode = 'P0001'; end if;
  return new;
end $$;

create or replace function prescriptions_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' then return new; end if;
  -- issued → cancelled is the only change allowed, and it touches nothing else.
  if old.status = 'issued' and new.status = 'cancelled'
     and row(new.rx_number, new.notes, new.issued_at, new.patient_id, new.encounter_id, new.doctor_member_id)
         is not distinct from row(old.rx_number, old.notes, old.issued_at, old.patient_id, old.encounter_id, old.doctor_member_id) then
    return new;
  end if;
  raise exception 'PRESCRIPTION_LOCKED' using errcode = 'P0001';
end $$;

drop trigger encounters_immutable on encounters;
drop trigger prescriptions_immutable on prescriptions;
create trigger encounters_immutable before update on encounters for each row execute function encounters_immutable();
create trigger prescriptions_immutable before update on prescriptions for each row execute function prescriptions_immutable();
drop function clinical_immutable();
revoke all on function encounters_immutable() from public, anon, authenticated, service_role;
revoke all on function prescriptions_immutable() from public, anon, authenticated, service_role;
