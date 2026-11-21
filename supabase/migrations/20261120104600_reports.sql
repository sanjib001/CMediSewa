-- =============================================================================
-- 0047 REPORTS (B8b): read-only report functions, all derived from the stock ledger, the
-- documents and the journal (database.md §12.3). Periods are business days (finance_range).
-- stock_report · batch_history · expiry_report · sales_register · item_sales ·
-- purchase_register · cash_book. Decisions D-112, D-113.
-- =============================================================================

-- Stock movement per item over a period: opening + received − sold (net of returns) − other out
-- = closing, in base units and at lot cost. One store or all.
create or replace function stock_report(p_tenant uuid, p_store uuid, p_from date, p_to date)
returns table (item_id uuid, item_code text, item text, unit text, opening_qty numeric, received_qty numeric, sold_qty numeric, other_out_qty numeric,
               closing_qty numeric, opening_value numeric, closing_value numeric, sold_cost numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  with r as (select * from finance_range(p_tenant, p_from, p_to)),
  m as (
    select sm.item_id,
           sum(case when sm.occurred_at < r.t0 then sm.qty_base else 0 end) o_q,
           sum(case when sm.occurred_at < r.t0 then sm.qty_base * sm.unit_cost_base else 0 end) o_v,
           sum(case when sm.occurred_at >= r.t0 and sm.occurred_at < r.t1 and sm.qty_base > 0 and sm.kind <> 'sale_return' then sm.qty_base else 0 end) in_q,
           sum(case when sm.occurred_at >= r.t0 and sm.occurred_at < r.t1 and sm.kind in ('sale', 'sale_return') then -sm.qty_base else 0 end) sold_q,
           sum(case when sm.occurred_at >= r.t0 and sm.occurred_at < r.t1 and sm.kind in ('sale', 'sale_return') then -sm.qty_base * sm.unit_cost_base else 0 end) sold_v,
           sum(case when sm.occurred_at >= r.t0 and sm.occurred_at < r.t1 and sm.qty_base < 0 and sm.kind <> 'sale' then -sm.qty_base else 0 end) out_q,
           sum(case when sm.occurred_at < r.t1 then sm.qty_base else 0 end) c_q,
           sum(case when sm.occurred_at < r.t1 then sm.qty_base * sm.unit_cost_base else 0 end) c_v
      from stock_movements sm cross join r
     where sm.tenant_id = p_tenant and (p_store is null or sm.store_id = p_store) and sm.occurred_at < r.t1
     group by sm.item_id)
  select i.id, i.item_code, i.name, (select u.name from item_units u where u.item_id = i.id and u.is_base),
         round(m.o_q, 3), round(m.in_q, 3), round(m.sold_q, 3), round(m.out_q, 3), round(m.c_q, 3), round(m.o_v, 2), round(m.c_v, 2), round(m.sold_v, 2)
    from m join inventory_items i on i.id = m.item_id
   where m.o_q <> 0 or m.in_q <> 0 or m.sold_q <> 0 or m.out_q <> 0 or m.c_q <> 0
   order by i.name;
$$;

-- Every movement of one lot, oldest first, with the running balance overall and in its store.
create or replace function batch_history(p_tenant uuid, p_batch uuid)
returns table (occurred_at timestamptz, store text, kind text, qty numeric, store_balance numeric, balance numeric, doc_type text, reason text, by_name text, unit_cost numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  select sm.occurred_at, s.name, sm.kind, sm.qty_base,
         sum(sm.qty_base) over (partition by sm.store_id order by sm.occurred_at, sm.id),
         sum(sm.qty_base) over (order by sm.occurred_at, sm.id),
         sm.doc_type, sm.reason_code, (select display_name from tenant_members where id = sm.created_by), sm.unit_cost_base
    from stock_movements sm join stores s on s.id = sm.store_id
   where sm.tenant_id = p_tenant and sm.batch_id = p_batch
   order by sm.occurred_at, sm.id;
$$;

-- Lots on hand that are expired or expire within p_days, soonest first.
create or replace function expiry_report(p_tenant uuid, p_store uuid, p_days integer)
returns table (store_id uuid, store text, item_id uuid, item text, batch_id uuid, batch_no text, expiry_date date, days_left integer, qty numeric, unit text, value numeric, status text)
language sql stable
set search_path = pg_catalog, public
as $$
  select b.store_id, s.name, ib.item_id, i.name, ib.id, ib.batch_no, ib.expiry_date, (ib.expiry_date - stock_today(p_tenant))::integer,
         b.qty_on_hand, (select u.name from item_units u where u.item_id = i.id and u.is_base), round(b.qty_on_hand * ib.unit_cost_base, 2), ib.status
    from stock_balances b
    join item_batches ib on ib.id = b.batch_id
    join inventory_items i on i.id = ib.item_id
    join stores s on s.id = b.store_id
   where b.tenant_id = p_tenant and b.qty_on_hand > 0 and (p_store is null or b.store_id = p_store)
     and ib.expiry_date is not null and ib.expiry_date <= stock_today(p_tenant) + greatest(0, least(coalesce(p_days, 90), 730))
   order by ib.expiry_date, i.name;
$$;

-- Bills of a period with what came back, what was paid and what is still owed.
create or replace function sales_register(p_tenant uuid, p_store uuid, p_from date, p_to date)
returns table (invoice_id uuid, invoice_no text, issued_at timestamptz, customer text, store text, source text, total numeric, returned numeric, paid numeric, outstanding numeric, status text, issued_by text)
language sql stable
set search_path = pg_catalog, public
as $$
  select iv.id, iv.invoice_no, iv.issued_at,
         coalesce((select p.full_name || ' (' || p.mrn || ')' from patients p where p.id = iv.patient_id), iv.customer_name, 'Walk-in'),
         (select name from stores where id = iv.store_id), iv.source, iv.total,
         coalesce((select sum(r.total) from sale_returns r where r.invoice_id = iv.id), 0), invoice_paid(iv.id), invoice_outstanding(iv.id), iv.status,
         (select display_name from tenant_members where id = iv.issued_by)
    from invoices iv, finance_range(p_tenant, p_from, p_to) r
   where iv.tenant_id = p_tenant and iv.issued_at >= r.t0 and iv.issued_at < r.t1 and (p_store is null or iv.store_id = p_store)
   order by iv.issued_at desc, iv.invoice_no desc;
$$;

-- What sold, per item, on the period's bills (void bills excluded, returns subtracted):
-- quantity, revenue (after discount, before VAT), cost at the lots' cost, margin.
create or replace function item_sales(p_tenant uuid, p_store uuid, p_from date, p_to date)
returns table (item_id uuid, item text, unit text, qty numeric, revenue numeric, cost numeric, margin numeric, bills integer)
language sql stable
set search_path = pg_catalog, public
as $$
  with r as (select * from finance_range(p_tenant, p_from, p_to)),
  lines as (
    select il.item_id, il.id line_id, iv.id invoice_id, il.line_total - il.tax_amount net, il.cost_total cost, il.base_qty qty
      from invoice_lines il join invoices iv on iv.id = il.invoice_id cross join r
     where iv.tenant_id = p_tenant and iv.status = 'issued' and il.line_type = 'item'
       and iv.issued_at >= r.t0 and iv.issued_at < r.t1 and (p_store is null or iv.store_id = p_store)),
  back as (
    select a.invoice_line_id line_id, sum(rl.qty_base) qty, sum(rl.net_amount) net, sum(case when rl.restock <> 'none' then rl.cost else 0 end) cost
      from sale_return_lines rl join invoice_line_allocations a on a.id = rl.allocation_id
     where rl.tenant_id = p_tenant and a.invoice_line_id in (select line_id from lines)
     group by 1)
  select i.id, i.name, (select u.name from item_units u where u.item_id = i.id and u.is_base),
         round(sum(l.qty - coalesce(b.qty, 0)), 3), round(sum(l.net - coalesce(b.net, 0)), 2), round(sum(l.cost - coalesce(b.cost, 0)), 2),
         round(sum(l.net - coalesce(b.net, 0)) - sum(l.cost - coalesce(b.cost, 0)), 2), count(distinct l.invoice_id)::integer
    from lines l left join back b on b.line_id = l.line_id join inventory_items i on i.id = l.item_id
   group by i.id, i.name
   order by 5 desc;
$$;

-- Purchase bills entered in a period (by our posting date), with paid, on credit and still owed.
create or replace function purchase_register(p_tenant uuid, p_from date, p_to date)
returns table (purchase_id uuid, purchase_no text, posted_at timestamptz, vendor text, vendor_invoice_no text, vendor_invoice_date date, store text,
               total numeric, tax numeric, paid numeric, credit numeric, outstanding numeric, status text)
language sql stable
set search_path = pg_catalog, public
as $$
  select pi.id, pi.purchase_no, pi.posted_at, v.name, pi.vendor_invoice_no, pi.vendor_invoice_date, (select name from stores where id = pi.received_store_id),
         pi.total, pi.tax_amount, pi.paid_cash + pi.paid_online, pi.credit_amount,
         case when pi.status = 'posted' then purchase_outstanding(pi.id) else 0 end, pi.status
    from purchase_invoices pi join vendors v on v.id = pi.vendor_id, finance_range(p_tenant, p_from, p_to) r
   where pi.tenant_id = p_tenant and pi.kind = 'purchase' and pi.posted_at >= r.t0 and pi.posted_at < r.t1
   order by pi.posted_at desc;
$$;

-- The cash book for one business day: every cash entry with its cause and a running balance.
create or replace function cash_book(p_tenant uuid, p_day date)
returns table (occurred_at timestamptz, kind text, memo text, cash_in numeric, cash_out numeric, balance numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  with r as (select * from finance_range(p_tenant, p_day, p_day))
  select e.occurred_at, coalesce(o.doc_type, p.doc_type), e.memo, e.debit, e.credit,
         account_balance(p_tenant, 'CASH', r.t0) + sum(e.debit - e.credit) over (order by e.occurred_at, e.id)
    from ledger_entries e join postings p on p.id = e.posting_id left join postings o on o.id = p.reverses_posting_id cross join r
   where e.tenant_id = p_tenant and e.account_code = 'CASH' and e.occurred_at >= r.t0 and e.occurred_at < r.t1
   order by e.occurred_at, e.id;
$$;

revoke all on function stock_report(uuid, uuid, date, date), batch_history(uuid, uuid), expiry_report(uuid, uuid, integer), sales_register(uuid, uuid, date, date),
                       item_sales(uuid, uuid, date, date), purchase_register(uuid, date, date), cash_book(uuid, date)
  from public, anon, authenticated;
grant execute on function stock_report(uuid, uuid, date, date), batch_history(uuid, uuid), expiry_report(uuid, uuid, integer), sales_register(uuid, uuid, date, date),
                          item_sales(uuid, uuid, date, date), purchase_register(uuid, date, date), cash_book(uuid, date)
  to service_role;

-- The clinic's "today" is needed by the app too (expiry windows, the return page's resale rule).
-- Found by the B8b tests: without this the return page silently fell back to the UTC date.
revoke all on function stock_today(uuid) from public, anon, authenticated;
grant execute on function stock_today(uuid) to service_role;
