-- 0016 "Paid until" follows the chain of back-to-back periods.
-- Found by the B2 end-to-end test: a renewal added in advance (starting the day after the
-- current period ends) did not show until it began, so the platform admin saw "paid until"
-- the OLD end date right after adding a year. Now: start from the latest end among periods
-- that have begun, then keep extending while a period starts on or before the day after
-- the current end. A gap breaks the chain (the clinic is unpaid during the gap).
create or replace function tenant_paid_until(p_tenant uuid)
returns date
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kathmandu')::date;
  v_until date;
  v_next  date;
begin
  select max(ends_on) into v_until from tenant_subscriptions where tenant_id = p_tenant and starts_on <= v_today;
  if v_until is null then return null; end if;
  loop
    select max(ends_on) into v_next from tenant_subscriptions
     where tenant_id = p_tenant and starts_on <= v_until + 1 and ends_on > v_until;
    exit when v_next is null;
    v_until := v_next;
  end loop;
  return v_until;
end $$;
