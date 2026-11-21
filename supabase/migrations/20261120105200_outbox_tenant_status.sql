-- =============================================================================
-- 0053 OUTBOX × CLINIC STATUS (found during U5): the dispatcher claimed due messages of every
-- clinic, including closed ones, so a closed clinic's patients could still get its emails and
-- its staff its pushes. Now only active or pending clinics' messages are claimed; a suspended
-- clinic's wait (sent if it is reactivated in time); a closed clinic's are cancelled.
-- Decision D-125.
-- =============================================================================

create or replace function claim_outbox(p_limit integer)
returns setof notification_outbox
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update notification_outbox o set status = 'cancelled', last_error = 'clinic closed'
    from tenants t where t.id = o.tenant_id and t.status = 'closed' and o.status in ('pending', 'sending');
  return query
  update notification_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
   where o.id in (select x.id from notification_outbox x join tenants t on t.id = x.tenant_id and t.status in ('active', 'pending')
                   where (x.status = 'pending' and x.next_attempt_at <= now()) or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes')
                   order by x.next_attempt_at limit greatest(1, least(coalesce(p_limit, 50), 200)) for update of x skip locked)
  returning o.*;
end $$;
