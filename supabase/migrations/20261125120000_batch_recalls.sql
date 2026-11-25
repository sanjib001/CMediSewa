-- =============================================================================
-- 0059 BULK RECALL (M-51, Phase 2): when a maker or the regulator recalls a batch, mark
-- every lot of that medicine with that batch number as recalled in every store at once,
-- tell the staff who sell and manage stock, and list who bought it so they can be
-- contacted. Recalled lots are never sold (allocate_stock already skips them).
-- Decision D-140.
-- =============================================================================

create table batch_recalls (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  item_id       uuid not null,
  batch_no      text not null check (batch_no ~ '^[A-Z0-9/._-]{1,30}$'),
  reason        text not null check (length(btrim(reason)) between 3 and 300),
  reference     text check (length(reference) <= 80),
  recalled_by   uuid not null,
  recalled_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references inventory_items (tenant_id, id),
  foreign key (tenant_id, recalled_by) references tenant_members (tenant_id, id)
);
create index batch_recalls_tenant on batch_recalls (tenant_id, recalled_at desc);

-- The lots a recall covered and their status before it.
create table batch_recall_lots (
  tenant_id   uuid not null,
  recall_id   uuid not null,
  batch_id    uuid not null,
  old_status  text not null check (old_status in ('active', 'blocked', 'recalled')),
  primary key (recall_id, batch_id),
  foreign key (tenant_id, recall_id) references batch_recalls (tenant_id, id) on delete cascade,
  foreign key (tenant_id, batch_id) references item_batches (tenant_id, id)
);
alter table batch_recalls enable row level security;
alter table batch_recall_lots enable row level security;
revoke insert, update, delete on batch_recalls, batch_recall_lots from service_role;

-- Batch numbers are stored upper-case (item_batches check); compare the same way.
create or replace function norm_batch_no(p text)
returns text
language sql immutable
set search_path = pg_catalog, public
as $$ select upper(regexp_replace(btrim(coalesce(p, '')), '\s+', '', 'g')); $$;

-- Recall a batch of a medicine everywhere. Password session (A2) and block_batches, like a
-- single block. Lots already recalled are listed too; nothing found → BATCH_NOT_FOUND.
create or replace function recall_batch(p_tenant uuid, p_by uuid, p_item uuid, p_batch_no text, p_reason text, p_reference text, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_no text := norm_batch_no(p_batch_no); v_item inventory_items; b record; v_lots integer := 0; v_on_hand numeric;
        v_sold integer; v_body text;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'block_batches') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if v_no !~ '^[A-Z0-9/._-]{1,30}$' then raise exception 'BAD_BATCH_NO' using errcode = 'P0001'; end if;
  select * into v_item from inventory_items where id = p_item and tenant_id = p_tenant;
  if v_item.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from item_batches where tenant_id = p_tenant and item_id = p_item and batch_no = v_no) then
    raise exception 'BATCH_NOT_FOUND' using errcode = 'P0001';
  end if;

  insert into batch_recalls (id, tenant_id, item_id, batch_no, reason, reference, recalled_by)
  values (v_id, p_tenant, p_item, v_no, btrim(left(p_reason, 300)), nullif(btrim(left(coalesce(p_reference, ''), 80)), ''), p_by);
  for b in select * from item_batches where tenant_id = p_tenant and item_id = p_item and batch_no = v_no order by created_at for update loop
    insert into batch_recall_lots (tenant_id, recall_id, batch_id, old_status) values (p_tenant, v_id, b.id, b.status);
    if b.status <> 'recalled' then
      update item_batches set status = 'recalled', block_reason = 'Recall: ' || btrim(left(p_reason, 290)), blocked_by = p_by, blocked_at = now() where id = b.id;
      insert into batch_status_history (tenant_id, batch_id, old_status, new_status, reason, changed_by) values (p_tenant, b.id, b.status, 'recalled', 'Recall: ' || btrim(p_reason), p_by);
    end if;
    v_lots := v_lots + 1;
  end loop;
  select coalesce(sum(sb.qty_on_hand), 0) into v_on_hand from stock_balances sb join batch_recall_lots l on l.batch_id = sb.batch_id where l.recall_id = v_id;
  select count(distinct il.invoice_id) into v_sold
    from invoice_line_allocations a join invoice_lines il on il.id = a.invoice_line_id join invoices iv on iv.id = il.invoice_id and iv.status = 'issued'
    join batch_recall_lots l on l.batch_id = a.batch_id where l.recall_id = v_id;

  v_body := left(v_item.name || ' batch ' || v_no || ': stop selling, set it aside. ' || btrim(p_reason), 300);
  perform notify_members(p_tenant, 'block_batches', 'batch_recall', 'Recall: ' || left(v_item.name, 100), v_body, '/admin/stock/recalls/' || v_id::text, 'batch_recall', v_id::text);
  perform notify_members(p_tenant, 'pharmacy_sell', 'batch_recall', 'Recall: ' || left(v_item.name, 100), v_body, '/employee/pharmacy?tab=stock', 'batch_recall', v_id::text);
  perform emit_event(p_tenant, 'stock', null);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'batch.bulk_recall', 'batch_recall', v_id::text, 'success', btrim(p_reason),
          jsonb_build_object('item', p_item, 'batch_no', v_no, 'lots', v_lots, 'on_hand_base', v_on_hand, 'bills', v_sold, 'reference', nullif(btrim(coalesce(p_reference, '')), '')));
  return jsonb_build_object('recall_id', v_id, 'lots', v_lots, 'on_hand_base', v_on_hand, 'bills', v_sold);
end $$;

-- Who bought it: every issued bill with a recalled lot, net of what came back, with the
-- patient (or walk-in name and phone) to contact. block_batches; the read is audited.
create or replace function recall_affected_sales(p_tenant uuid, p_by uuid, p_recall uuid, p_session_level text)
returns table (invoice_id uuid, invoice_no text, issued_at timestamptz, store_name text, batch_no text, patient_id uuid, patient_name text, mrn text,
               phone text, customer_name text, qty_sold_base numeric, qty_returned_base numeric)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'block_batches') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from batch_recalls where id = p_recall and tenant_id = p_tenant) then raise exception 'RECALL_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, p_session_level, 'batch.recall_sales_read', 'batch_recall', p_recall::text, 'success');
  return query
    select iv.id, iv.invoice_no, iv.issued_at, st.name, ib.batch_no, iv.patient_id, p.full_name, p.mrn,
           coalesce(p.phone, iv.customer_phone), iv.customer_name,
           sum(a.base_qty), coalesce(sum((select sum(r.qty_base) from sale_return_lines r where r.allocation_id = a.id)), 0)
      from batch_recall_lots l
      join invoice_line_allocations a on a.batch_id = l.batch_id and a.tenant_id = p_tenant
      join invoice_lines il on il.id = a.invoice_line_id
      join invoices iv on iv.id = il.invoice_id and iv.status = 'issued'
      join item_batches ib on ib.id = a.batch_id
      left join stores st on st.id = a.store_id
      left join patients p on p.id = iv.patient_id
     where l.recall_id = p_recall and l.tenant_id = p_tenant
     group by iv.id, iv.invoice_no, iv.issued_at, st.name, ib.batch_no, iv.patient_id, p.full_name, p.mrn, p.phone, iv.customer_phone, iv.customer_name
     order by iv.issued_at desc;
end $$;

revoke all on function recall_batch(uuid, uuid, uuid, text, text, text, text), recall_affected_sales(uuid, uuid, uuid, text), norm_batch_no(text)
  from public, anon, authenticated;
grant execute on function recall_batch(uuid, uuid, uuid, text, text, text, text), recall_affected_sales(uuid, uuid, uuid, text), norm_batch_no(text) to service_role;
