-- =============================================================================
-- 0035 STOCK OPERATIONS (B5b): transfers (request → approve → dispatch → receive), adjustments,
-- stock counts (variance as of the counting moment), block / recall / unblock, disposal from
-- quarantine. Every quantity change is a stock_movements row + its journal lines, written by a
-- ledger_writer function in ONE transaction. database.md §9.3–§9.4; D-38, D-39, D-43.
-- =============================================================================

-- ── helpers ───────────────────────────────────────────────────────────────────
create or replace function has_key(p_member uuid, p_key text)
returns boolean
language sql stable
set search_path = pg_catalog, public
as $$ select p_key = any (effective_permissions(p_member)); $$;

create or replace function stock_today(p_tenant uuid)
returns date
language sql stable
set search_path = pg_catalog, public
as $$ select (now() at time zone timezone)::date from tenants where id = p_tenant; $$;

-- ── transfers ────────────────────────────────────────────────────────────────
create table stock_transfers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete restrict,
  transfer_no      text not null,
  fiscal_year      text not null,
  from_store_id    uuid not null,
  to_store_id      uuid not null,
  status           text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'dispatched', 'received', 'cancelled')),
  note             text check (length(note) <= 300),
  requested_by     uuid not null,
  requested_at     timestamptz not null default now(),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_reason  text,
  dispatched_by    uuid,
  dispatched_at    timestamptz,
  received_by      uuid,
  received_at      timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, transfer_no),
  foreign key (tenant_id, from_store_id) references stores (tenant_id, id),
  foreign key (tenant_id, to_store_id) references stores (tenant_id, id),
  foreign key (tenant_id, requested_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, decided_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, dispatched_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, received_by) references tenant_members (tenant_id, id),
  check (from_store_id <> to_store_id)
);
create table stock_transfer_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  transfer_id         uuid not null,
  item_id             uuid not null,
  unit_id             uuid not null,
  requested_qty       numeric(14,3) not null check (requested_qty > 0),
  factor_snapshot     numeric(14,4) not null check (factor_snapshot > 0),
  requested_base_qty  numeric(14,3) generated always as (round(requested_qty * factor_snapshot, 3)) stored,
  batch_id            uuid,   -- a specific lot (e.g. moving an expired lot to quarantine); null = FEFO at dispatch
  unique (tenant_id, id),
  foreign key (tenant_id, transfer_id) references stock_transfers (tenant_id, id),
  foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);
create table stock_transfer_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  transfer_id          uuid not null,
  item_id              uuid not null,
  batch_id             uuid not null,
  unit_cost_base       numeric(14,4) not null,
  dispatched_base_qty  numeric(14,3) not null check (dispatched_base_qty > 0),
  received_base_qty    numeric(14,3) check (received_base_qty >= 0),
  loss_base_qty        numeric(14,3) check (loss_base_qty >= 0),
  loss_reason          text,
  unique (tenant_id, id),
  foreign key (tenant_id, transfer_id) references stock_transfers (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  check (coalesce(received_base_qty, 0) + coalesce(loss_base_qty, 0) <= dispatched_base_qty),
  check (coalesce(loss_base_qty, 0) = 0 or loss_reason is not null)
);

-- ── adjustments ──────────────────────────────────────────────────────────────
create table stock_adjustments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete restrict,
  adj_no       text not null,
  fiscal_year  text not null,
  store_id     uuid not null,
  reason_code  text not null check (reason_code in ('damaged', 'expired', 'lost', 'theft', 'found', 'correction', 'internal_use', 'sample')),
  note         text check (length(note) <= 300),
  posted_by    uuid not null,
  posted_at    timestamptz not null default now(),
  posting_id   uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, adj_no),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id)
);
create table stock_adjustment_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  adjustment_id   uuid not null,
  item_id         uuid not null,
  batch_id        uuid not null,
  qty_base        numeric(14,3) not null check (qty_base <> 0),
  unit_cost_base  numeric(14,4) not null,
  unique (tenant_id, id),
  foreign key (tenant_id, adjustment_id) references stock_adjustments (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);

-- ── counts ───────────────────────────────────────────────────────────────────
create table stock_counts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete restrict,
  count_no      text not null,
  fiscal_year   text not null,
  store_id      uuid not null,
  blind         boolean not null default true,
  status        text not null default 'counting' check (status in ('counting', 'posted', 'cancelled')),
  note          text check (length(note) <= 300),
  started_by    uuid not null,
  started_at    timestamptz not null default now(),
  posted_by     uuid,
  posted_at     timestamptz,
  posting_id    uuid,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, count_no),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, started_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id)
);
create unique index stock_counts_one_open on stock_counts (tenant_id, store_id) where status = 'counting';
create table stock_count_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  count_id             uuid not null,
  item_id              uuid not null,
  batch_id             uuid not null,
  counted_qty_base     numeric(14,3) not null check (counted_qty_base >= 0),
  system_qty_at_count  numeric(14,3) not null,
  variance             numeric(14,3) generated always as (counted_qty_base - system_qty_at_count) stored,
  counted_by           uuid not null,
  counted_at           timestamptz not null default now(),
  reason               text,
  unique (tenant_id, id),
  unique (count_id, batch_id),
  foreign key (tenant_id, count_id) references stock_counts (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, counted_by) references tenant_members (tenant_id, id)
);

-- ── disposal & batch status ──────────────────────────────────────────────────
create table stock_disposals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete restrict,
  disposal_no   text not null,
  fiscal_year   text not null,
  store_id      uuid not null,
  method        text not null check (method in ('vendor_return', 'incineration', 'authorised_contractor', 'other')),
  contractor    text,
  witness_name  text not null check (length(btrim(witness_name)) >= 2),
  note          text,
  posted_by     uuid not null,
  posted_at     timestamptz not null default now(),
  posting_id    uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, disposal_no),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id)
);
create table stock_disposal_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  disposal_id     uuid not null,
  item_id         uuid not null,
  batch_id        uuid not null,
  qty_base        numeric(14,3) not null check (qty_base > 0),
  unit_cost_base  numeric(14,4) not null,
  unique (tenant_id, id),
  foreign key (tenant_id, disposal_id) references stock_disposals (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);
create table batch_status_history (
  id          bigserial primary key,
  tenant_id   uuid not null,
  batch_id    uuid not null,
  old_status  text not null,
  new_status  text not null,
  reason      text not null,
  changed_by  uuid not null,
  changed_at  timestamptz not null default now(),
  foreign key (tenant_id, batch_id) references item_batches (tenant_id, id),
  foreign key (tenant_id, changed_by) references tenant_members (tenant_id, id)
);

alter table stock_transfers        enable row level security;
alter table stock_transfer_items   enable row level security;
alter table stock_transfer_lines   enable row level security;
alter table stock_adjustments      enable row level security;
alter table stock_adjustment_lines enable row level security;
alter table stock_counts           enable row level security;
alter table stock_count_lines      enable row level security;
alter table stock_disposals        enable row level security;
alter table stock_disposal_lines   enable row level security;
alter table batch_status_history   enable row level security;
revoke insert, update, delete on stock_transfers, stock_transfer_items, stock_transfer_lines, stock_adjustments, stock_adjustment_lines,
                                 stock_counts, stock_count_lines, stock_disposals, stock_disposal_lines, batch_status_history from service_role;
revoke usage on sequence batch_status_history_id_seq from service_role;

-- =============================================================================
-- FUNCTIONS (all owned by ledger_writer below)
-- =============================================================================

-- Write one movement; translate a would-be-negative balance into INSUFFICIENT_STOCK.
create or replace function write_movement(p_tenant uuid, p_store uuid, p_batch uuid, p_item uuid, p_qty numeric, p_kind text, p_cost numeric,
                                          p_posting uuid, p_doc_type text, p_doc uuid, p_line uuid, p_reason text, p_by uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into stock_movements (tenant_id, store_id, batch_id, item_id, qty_base, kind, unit_cost_base, posting_id, doc_type, doc_id, doc_line_id, reason_code, created_by)
  values (p_tenant, p_store, p_batch, p_item, p_qty, p_kind, p_cost, p_posting, p_doc_type, p_doc, p_line, p_reason, p_by);
exception when check_violation then
  if sqlerrm like '%qty_on_hand%' then raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001'; end if;
  raise;
end $$;

create or replace function doc_number(p_tenant uuid, p_type text, p_prefix text, out fiscal_year text, out doc_no text)
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_n bigint;
begin
  select d.fiscal_year, d.doc_no into fiscal_year, v_n from next_document_no(p_tenant, p_type, p_tenant) d;
  doc_no := p_prefix || '-' || lpad(v_n::text, 5, '0');
end $$;

-- ── transfers ────────────────────────────────────────────────────────────────
-- p_items: [{ item_id, unit_id, qty, batch_id? }]. Approved at once unless the clinic requires approval.
create or replace function request_transfer(p_tenant uuid, p_by uuid, p_from uuid, p_to uuid, p_items jsonb, p_note text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_fy text; v_no text; i jsonb; v_unit item_units; v_need_approval boolean;
begin
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'transfer_stock') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_from), 'view') = 'view' and coalesce(store_access(p_tenant, p_by, p_to), 'view') = 'view' then
    raise exception 'NO_STORE_ACCESS' using errcode = 'P0001';
  end if;
  if not exists (select 1 from stores where id = p_to and tenant_id = p_tenant and is_active and is_receiving) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_from and tenant_id = p_tenant and is_active) then raise exception 'STORE_NOT_FOUND' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select transfer_approval_required into v_need_approval from tenant_settings where tenant_id = p_tenant;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'transfer', 'TR') d;
  insert into stock_transfers (id, tenant_id, transfer_no, fiscal_year, from_store_id, to_store_id, status, note, requested_by, decided_by, decided_at)
  values (v_id, p_tenant, v_no, v_fy, p_from, p_to, case when v_need_approval then 'requested' else 'approved' end, nullif(btrim(p_note), ''), p_by,
          case when v_need_approval then null else p_by end, case when v_need_approval then null else now() end);
  for i in select * from jsonb_array_elements(p_items) loop
    select u.* into v_unit from item_units u join inventory_items it on it.id = u.item_id and it.tenant_id = p_tenant
     where u.id = (i->>'unit_id')::uuid and u.item_id = (i->>'item_id')::uuid;
    if v_unit.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
    if coalesce((i->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    insert into stock_transfer_items (tenant_id, transfer_id, item_id, unit_id, requested_qty, factor_snapshot, batch_id)
    values (p_tenant, v_id, v_unit.item_id, v_unit.id, (i->>'qty')::numeric, v_unit.factor_to_base, nullif(i->>'batch_id', '')::uuid);
  end loop;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, 'transfer.request', 'stock_transfer', v_id::text, 'success', jsonb_build_object('no', v_no, 'from', p_from, 'to', p_to));
  return v_id;
end $$;

create or replace function decide_transfer(p_tenant uuid, p_by uuid, p_transfer uuid, p_action text, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t stock_transfers;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into t from stock_transfers where id = p_transfer and tenant_id = p_tenant for update;
  if t.id is null then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_action in ('approve', 'reject') then
    if t.status <> 'requested' then raise exception 'TRANSFER_NOT_OPEN' using errcode = 'P0001'; end if;
    if not has_key(p_by, 'approve_transfers') or coalesce(store_access(p_tenant, p_by, t.from_store_id), '') <> 'manage' then
      raise exception 'NO_PERMISSION' using errcode = 'P0001';
    end if;
    if p_action = 'reject' and coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
    update stock_transfers set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
           decided_by = p_by, decided_at = now(), decision_reason = nullif(btrim(p_reason), '') where id = p_transfer;
  elsif p_action = 'cancel' then
    if t.status not in ('requested', 'approved') then raise exception 'TRANSFER_NOT_OPEN' using errcode = 'P0001'; end if;
    if t.requested_by <> p_by and coalesce(store_access(p_tenant, p_by, t.from_store_id), '') <> 'manage' then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
    update stock_transfers set status = 'cancelled', decision_reason = coalesce(nullif(btrim(p_reason), ''), 'Cancelled') where id = p_transfer;
  else
    raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, 'transfer.' || p_action, 'stock_transfer', p_transfer::text, 'success', nullif(btrim(p_reason), ''));
end $$;

-- Dispatch: take the lots out of the source (FEFO, or the named lot), into transit.
-- Into a SELLABLE store only sellable lots may go; expired/blocked lots may go to quarantine.
create or replace function dispatch_transfer(p_tenant uuid, p_idempotency_key uuid, p_transfer uuid, p_by uuid, p_session_level text, p_device uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t stock_transfers; v_to stores; i stock_transfer_items; a record; v_post uuid; v_replayed boolean; v_line uuid; v_value numeric := 0; v_b item_batches; v_today date;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  select * into t from stock_transfers where id = p_transfer and tenant_id = p_tenant for update;
  if t.id is null then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'transfer_dispatch', p_transfer, p_by, p_session_level, p_device) b;
  if v_replayed then return; end if;
  if t.status <> 'approved' then raise exception 'TRANSFER_NOT_APPROVED' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, t.from_store_id), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  select * into v_to from stores where id = t.to_store_id;
  v_today := stock_today(p_tenant);
  for i in select * from stock_transfer_items where transfer_id = p_transfer loop
    if i.batch_id is not null then
      select * into v_b from item_batches where id = i.batch_id;
      if v_to.is_sellable and (v_b.status <> 'active' or (v_b.expiry_date is not null and v_b.expiry_date <= v_today)) then
        raise exception 'LOT_NOT_SELLABLE' using errcode = 'P0001';
      end if;
      perform 1 from stock_balances where tenant_id = p_tenant and store_id = t.from_store_id and batch_id = i.batch_id for update;
      for a in select i.batch_id bid, i.requested_base_qty q, v_b.unit_cost_base cost loop
        v_line := gen_random_uuid();
        insert into stock_transfer_lines (id, tenant_id, transfer_id, item_id, batch_id, unit_cost_base, dispatched_base_qty)
        values (v_line, p_tenant, p_transfer, i.item_id, a.bid, a.cost, a.q);
        perform write_movement(p_tenant, t.from_store_id, a.bid, i.item_id, -a.q, 'transfer_out', a.cost, v_post, 'stock_transfer', p_transfer, v_line, null, p_by);
        v_value := v_value + round(a.q * a.cost, 2);
      end loop;
    else
      for a in select al.batch_id bid, al.qty_base q, al.unit_cost_base cost from allocate_stock(p_tenant, t.from_store_id, i.item_id, i.requested_base_qty, 'transfer') al loop
        v_line := gen_random_uuid();
        insert into stock_transfer_lines (id, tenant_id, transfer_id, item_id, batch_id, unit_cost_base, dispatched_base_qty)
        values (v_line, p_tenant, p_transfer, i.item_id, a.bid, a.cost, a.q);
        perform write_movement(p_tenant, t.from_store_id, a.bid, i.item_id, -a.q, 'transfer_out', a.cost, v_post, 'stock_transfer', p_transfer, v_line, null, p_by);
        v_value := v_value + round(a.q * a.cost, 2);
      end loop;
    end if;
  end loop;
  if v_value > 0 then
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'INVENTORY_IN_TRANSIT', 'debit', v_value, 'store_id', t.to_store_id, 'memo', t.transfer_no),
      jsonb_build_object('account', 'INVENTORY', 'credit', v_value, 'store_id', t.from_store_id, 'memo', t.transfer_no)));
  end if;
  update stock_transfers set status = 'dispatched', dispatched_by = p_by, dispatched_at = now() where id = p_transfer;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'transfer.dispatch', 'stock_transfer', p_transfer::text, 'success', jsonb_build_object('value', v_value));
end $$;

-- Receive: everything dispatched is accounted for, as received or lost (with a reason).
-- p_lines: [{ line_id, received_base_qty, loss_base_qty, loss_reason }] (omitted lines = fully received)
create or replace function receive_transfer(p_tenant uuid, p_idempotency_key uuid, p_transfer uuid, p_lines jsonb, p_by uuid, p_session_level text, p_device uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare t stock_transfers; l stock_transfer_lines; x jsonb; v_rec numeric; v_loss numeric; v_post uuid; v_replayed boolean;
        v_in numeric := 0; v_lost numeric := 0; v_entries jsonb := '[]';
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  select * into t from stock_transfers where id = p_transfer and tenant_id = p_tenant for update;
  if t.id is null then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'transfer_receive', p_transfer, p_by, p_session_level, p_device) b;
  if v_replayed then return; end if;
  if t.status <> 'dispatched' then raise exception 'TRANSFER_NOT_DISPATCHED' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, t.to_store_id), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  for l in select * from stock_transfer_lines where transfer_id = p_transfer loop
    select e into x from jsonb_array_elements(coalesce(p_lines, '[]')) e where (e->>'line_id')::uuid = l.id;
    v_loss := coalesce((x->>'loss_base_qty')::numeric, 0);
    v_rec := coalesce((x->>'received_base_qty')::numeric, l.dispatched_base_qty - v_loss);
    if v_rec < 0 or v_loss < 0 or v_rec + v_loss <> l.dispatched_base_qty then raise exception 'RECEIVE_MUST_MATCH' using errcode = 'P0001'; end if;
    if v_loss > 0 and coalesce(btrim(x->>'loss_reason'), '') = '' then raise exception 'LOSS_REASON_REQUIRED' using errcode = 'P0001'; end if;
    update stock_transfer_lines set received_base_qty = v_rec, loss_base_qty = v_loss, loss_reason = nullif(btrim(x->>'loss_reason'), '') where id = l.id;
    if v_rec > 0 then
      perform write_movement(p_tenant, t.to_store_id, l.batch_id, l.item_id, v_rec, 'transfer_in', l.unit_cost_base, v_post, 'stock_transfer', p_transfer, l.id, null, p_by);
    end if;
    -- Keep transit exact: the loss is what was dispatched minus what arrived, at the same rounding.
    v_in := v_in + round(v_rec * l.unit_cost_base, 2);
    v_lost := v_lost + round(l.dispatched_base_qty * l.unit_cost_base, 2) - round(v_rec * l.unit_cost_base, 2);
  end loop;
  if v_in > 0 then v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'debit', v_in, 'store_id', t.to_store_id, 'memo', t.transfer_no); end if;
  if v_lost > 0 then v_entries := v_entries || jsonb_build_object('account', 'INV_LOSS', 'debit', v_lost, 'store_id', t.to_store_id, 'memo', t.transfer_no || ' transit loss'); end if;
  if v_in + v_lost > 0 then
    v_entries := v_entries || jsonb_build_object('account', 'INVENTORY_IN_TRANSIT', 'credit', v_in + v_lost, 'store_id', t.to_store_id, 'memo', t.transfer_no);
    perform post_journal(p_tenant, v_post, v_entries);
  end if;
  update stock_transfers set status = 'received', received_by = p_by, received_at = now() where id = p_transfer;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'transfer.receive', 'stock_transfer', p_transfer::text, 'success', jsonb_build_object('lost_value', v_lost));
end $$;

-- ── adjustments ──────────────────────────────────────────────────────────────
-- p_lines: [{ batch_id, qty_base (signed) }] or, for 'found' stock with no lot yet:
--          [{ item_id, unit_id, qty, batch_no, expiry_date, unit_cost }]
create or replace function post_stock_adjustment(p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_reason text, p_note text, p_lines jsonb,
                                                 p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; x jsonb; v_b item_batches; v_unit item_units;
        v_qty numeric; v_line uuid; v_loss numeric := 0; v_gain numeric := 0; v_entries jsonb := '[]';
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_stock') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), '') <> 'manage' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if p_reason not in ('damaged', 'expired', 'lost', 'theft', 'found', 'correction', 'internal_use', 'sample') then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'stock_adjustment', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from stock_adjustments where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'adjustment', 'ADJ') d;
  insert into stock_adjustments (id, tenant_id, adj_no, fiscal_year, store_id, reason_code, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_store, p_reason, nullif(btrim(p_note), ''), p_by, v_post);

  for x in select * from jsonb_array_elements(p_lines) loop
    if nullif(x->>'batch_id', '') is not null then
      select * into v_b from item_batches where id = (x->>'batch_id')::uuid and tenant_id = p_tenant;
      if v_b.id is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
      v_qty := round((x->>'qty_base')::numeric, 3);
    else
      if p_reason <> 'found' then raise exception 'LOT_REQUIRED' using errcode = 'P0001'; end if;
      select u.* into v_unit from item_units u join inventory_items it on it.id = u.item_id and it.tenant_id = p_tenant
       where u.id = (x->>'unit_id')::uuid and u.item_id = (x->>'item_id')::uuid;
      if v_unit.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
      insert into item_batches (tenant_id, item_id, batch_no, expiry_date, source, unit_cost_base, sale_price_base)
      values (p_tenant, v_unit.item_id, coalesce(nullif(btrim(x->>'batch_no'), ''), 'NA'), nullif(x->>'expiry_date', '')::date, 'found',
              round(coalesce((x->>'unit_cost')::numeric, 0) / v_unit.factor_to_base, 4), round(coalesce((x->>'unit_cost')::numeric, 0) / v_unit.factor_to_base, 4))
      returning * into v_b;
      v_qty := round((x->>'qty')::numeric * v_unit.factor_to_base, 3);
    end if;
    if v_qty is null or v_qty = 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    if p_reason = 'found' and v_qty < 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    if p_reason in ('damaged', 'expired', 'lost', 'theft', 'internal_use', 'sample') and v_qty > 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    v_line := gen_random_uuid();
    insert into stock_adjustment_lines (id, tenant_id, adjustment_id, item_id, batch_id, qty_base, unit_cost_base)
    values (v_line, p_tenant, v_id, v_b.item_id, v_b.id, v_qty, v_b.unit_cost_base);
    perform write_movement(p_tenant, p_store, v_b.id, v_b.item_id, v_qty, case when v_qty > 0 then 'adjustment_in' else 'adjustment_out' end,
                           v_b.unit_cost_base, v_post, 'stock_adjustment', v_id, v_line, p_reason, p_by);
    if v_qty > 0 then v_gain := v_gain + round(v_qty * v_b.unit_cost_base, 2); else v_loss := v_loss + round(-v_qty * v_b.unit_cost_base, 2); end if;
  end loop;
  if v_loss > 0 then v_entries := v_entries || jsonb_build_object('account', 'INV_LOSS', 'debit', v_loss, 'store_id', p_store, 'memo', v_no || ' ' || p_reason)
                                            || jsonb_build_object('account', 'INVENTORY', 'credit', v_loss, 'store_id', p_store, 'memo', v_no); end if;
  if v_gain > 0 then v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'debit', v_gain, 'store_id', p_store, 'memo', v_no)
                                            || jsonb_build_object('account', 'INV_GAIN', 'credit', v_gain, 'store_id', p_store, 'memo', v_no || ' ' || p_reason); end if;
  if jsonb_array_length(v_entries) > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'stock.adjust', 'stock_adjustment', v_id::text, 'success', jsonb_build_object('no', v_no, 'reason', p_reason, 'loss', v_loss, 'gain', v_gain));
  return v_id;
end $$;

-- ── counts ───────────────────────────────────────────────────────────────────
create or replace function start_stock_count(p_tenant uuid, p_by uuid, p_store uuid, p_blind boolean, p_note text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid; v_fy text; v_no text;
begin
  perform assert_active_member(p_tenant, p_by);
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'stock_count', 'CNT') d;
  insert into stock_counts (tenant_id, count_no, fiscal_year, store_id, blind, note, started_by)
  values (p_tenant, v_no, v_fy, p_store, coalesce(p_blind, true), nullif(btrim(p_note), ''), p_by) returning id into v_id;
  return v_id;
exception when unique_violation then
  if sqlerrm like '%stock_counts_one_open%' then raise exception 'COUNT_ALREADY_OPEN' using errcode = 'P0001'; end if;
  raise;
end $$;

-- Record (or re-record) what is on the shelf for one lot. The system quantity is taken from the
-- ledger AS OF THIS MOMENT, so sales during a long count don't create false variances.
create or replace function record_count(p_tenant uuid, p_by uuid, p_count uuid, p_batch uuid, p_counted numeric, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare k stock_counts; v_item uuid; v_sys numeric;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into k from stock_counts where id = p_count and tenant_id = p_tenant;
  if k.id is null or k.status <> 'counting' then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, k.store_id), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
  select item_id into v_item from item_batches where id = p_batch and tenant_id = p_tenant;
  if v_item is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
  select coalesce(sum(qty_base), 0) into v_sys from stock_movements where tenant_id = p_tenant and store_id = k.store_id and batch_id = p_batch and occurred_at <= now();
  insert into stock_count_lines (tenant_id, count_id, item_id, batch_id, counted_qty_base, system_qty_at_count, counted_by, reason)
  values (p_tenant, p_count, v_item, p_batch, round(p_counted, 3), v_sys, p_by, nullif(btrim(p_reason), ''))
  on conflict (count_id, batch_id) do update set counted_qty_base = excluded.counted_qty_base, system_qty_at_count = excluded.system_qty_at_count,
     counted_by = excluded.counted_by, counted_at = now(), reason = excluded.reason;
end $$;

create or replace function post_stock_count(p_tenant uuid, p_idempotency_key uuid, p_count uuid, p_by uuid, p_session_level text, p_device uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare k stock_counts; l stock_count_lines; v_post uuid; v_replayed boolean; v_cost numeric; v_loss numeric := 0; v_gain numeric := 0; v_entries jsonb := '[]';
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  select * into k from stock_counts where id = p_count and tenant_id = p_tenant for update;
  if k.id is null then raise exception 'COUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'stock_count', p_count, p_by, p_session_level, p_device) b;
  if v_replayed then return; end if;
  if k.status <> 'counting' then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
  if not has_key(p_by, 'manage_stock') or coalesce(store_access(p_tenant, p_by, k.store_id), '') <> 'manage' then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if (select count_post_requires_other_member from tenant_settings where tenant_id = p_tenant)
     and exists (select 1 from stock_count_lines where count_id = p_count and counted_by = p_by) then
    raise exception 'OTHER_MEMBER_MUST_POST' using errcode = 'P0001';
  end if;
  if not exists (select 1 from stock_count_lines where count_id = p_count) then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  for l in select * from stock_count_lines where count_id = p_count and variance <> 0 order by batch_id loop
    select unit_cost_base into v_cost from item_batches where id = l.batch_id;
    begin
      perform write_movement(p_tenant, k.store_id, l.batch_id, l.item_id, l.variance, 'count_variance', v_cost, v_post, 'stock_count', p_count, l.id, l.reason, p_by);
    exception when others then
      if sqlerrm like '%INSUFFICIENT_STOCK%' then raise exception 'COUNT_OUTDATED' using errcode = 'P0001'; end if;
      raise;
    end;
    if l.variance > 0 then v_gain := v_gain + round(l.variance * v_cost, 2); else v_loss := v_loss + round(-l.variance * v_cost, 2); end if;
  end loop;
  if v_loss > 0 then v_entries := v_entries || jsonb_build_object('account', 'INV_LOSS', 'debit', v_loss, 'store_id', k.store_id, 'memo', k.count_no || ' shortage')
                                            || jsonb_build_object('account', 'INVENTORY', 'credit', v_loss, 'store_id', k.store_id, 'memo', k.count_no); end if;
  if v_gain > 0 then v_entries := v_entries || jsonb_build_object('account', 'INVENTORY', 'debit', v_gain, 'store_id', k.store_id, 'memo', k.count_no)
                                            || jsonb_build_object('account', 'INV_GAIN', 'credit', v_gain, 'store_id', k.store_id, 'memo', k.count_no || ' surplus'); end if;
  if jsonb_array_length(v_entries) > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;
  update stock_counts set status = 'posted', posted_by = p_by, posted_at = now(), posting_id = v_post where id = p_count;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'stock.count_post', 'stock_count', p_count::text, 'success', jsonb_build_object('loss', v_loss, 'gain', v_gain));
end $$;

create or replace function cancel_stock_count(p_tenant uuid, p_by uuid, p_count uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare k stock_counts;
begin
  perform assert_active_member(p_tenant, p_by);
  select * into k from stock_counts where id = p_count and tenant_id = p_tenant for update;
  if k.id is null or k.status <> 'counting' then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, k.store_id), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  update stock_counts set status = 'cancelled' where id = p_count;
end $$;

-- ── block / recall / unblock (every store) ───────────────────────────────────
create or replace function set_batch_status(p_tenant uuid, p_by uuid, p_batch uuid, p_status text, p_reason text, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare b item_batches;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'block_batches') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if p_status not in ('active', 'blocked', 'recalled') then raise exception 'BAD_STATUS' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into b from item_batches where id = p_batch and tenant_id = p_tenant for update;
  if b.id is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
  if b.status = p_status then return; end if;
  update item_batches set status = p_status,
         block_reason = case when p_status = 'active' then null else btrim(p_reason) end,
         blocked_by = case when p_status = 'active' then null else p_by end,
         blocked_at = case when p_status = 'active' then null else now() end
   where id = p_batch;
  insert into batch_status_history (tenant_id, batch_id, old_status, new_status, reason, changed_by) values (p_tenant, p_batch, b.status, p_status, btrim(p_reason), p_by);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, p_session_level, 'batch.' || p_status, 'item_batch', p_batch::text, 'success', btrim(p_reason));
end $$;

-- ── disposal (from quarantine only) ──────────────────────────────────────────
create or replace function post_disposal(p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_method text, p_contractor text, p_witness text,
                                         p_note text, p_lines jsonb, p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; x jsonb; b item_batches; v_qty numeric; v_line uuid; v_value numeric := 0;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'dispose_stock') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), '') <> 'manage' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and kind = 'quarantine') then raise exception 'DISPOSE_FROM_QUARANTINE' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select bp.posting_id, bp.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'stock_disposal', v_id, p_by, p_session_level, p_device) bp;
  if v_replayed then return (select id from stock_disposals where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'disposal', 'DSP') d;
  insert into stock_disposals (id, tenant_id, disposal_no, fiscal_year, store_id, method, contractor, witness_name, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_store, p_method, nullif(btrim(p_contractor), ''), btrim(p_witness), nullif(btrim(p_note), ''), p_by, v_post);
  for x in select * from jsonb_array_elements(p_lines) loop
    select * into b from item_batches where id = (x->>'batch_id')::uuid and tenant_id = p_tenant;
    if b.id is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0001'; end if;
    v_qty := round((x->>'qty_base')::numeric, 3);
    if v_qty is null or v_qty <= 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
    v_line := gen_random_uuid();
    insert into stock_disposal_lines (id, tenant_id, disposal_id, item_id, batch_id, qty_base, unit_cost_base) values (v_line, p_tenant, v_id, b.item_id, b.id, v_qty, b.unit_cost_base);
    perform write_movement(p_tenant, p_store, b.id, b.item_id, -v_qty, 'disposal', b.unit_cost_base, v_post, 'stock_disposal', v_id, v_line, p_method, p_by);
    v_value := v_value + round(v_qty * b.unit_cost_base, 2);
  end loop;
  if v_value > 0 then
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'INV_LOSS', 'debit', v_value, 'store_id', p_store, 'memo', v_no || ' disposal'),
      jsonb_build_object('account', 'INVENTORY', 'credit', v_value, 'store_id', p_store, 'memo', v_no)));
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'stock.dispose', 'stock_disposal', v_id::text, 'success', jsonb_build_object('no', v_no, 'value', v_value, 'witness', btrim(p_witness)));
  return v_id;
end $$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on stock_movements to ledger_writer;
grant select, insert, update on stock_transfers, stock_transfer_lines, stock_counts, stock_count_lines to ledger_writer;
grant select, insert on stock_transfer_items, stock_adjustments, stock_adjustment_lines, stock_disposals, stock_disposal_lines, batch_status_history to ledger_writer;
grant usage, select on sequence batch_status_history_id_seq to ledger_writer;
grant update (status, block_reason, blocked_by, blocked_at) on item_batches to ledger_writer;
grant insert on audit_log to ledger_writer;
grant execute on function has_key(uuid, text), stock_today(uuid) to ledger_writer;
grant execute on function assert_active_member(uuid, uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function write_movement(uuid, uuid, uuid, uuid, numeric, text, numeric, uuid, text, uuid, uuid, text, uuid) owner to ledger_writer;
alter function doc_number(uuid, text, text) owner to ledger_writer;
alter function request_transfer(uuid, uuid, uuid, uuid, jsonb, text) owner to ledger_writer;
alter function decide_transfer(uuid, uuid, uuid, text, text) owner to ledger_writer;
alter function dispatch_transfer(uuid, uuid, uuid, uuid, text, uuid) owner to ledger_writer;
alter function receive_transfer(uuid, uuid, uuid, jsonb, uuid, text, uuid) owner to ledger_writer;
alter function post_stock_adjustment(uuid, uuid, uuid, text, text, jsonb, uuid, text, uuid) owner to ledger_writer;
alter function start_stock_count(uuid, uuid, uuid, boolean, text) owner to ledger_writer;
alter function record_count(uuid, uuid, uuid, uuid, numeric, text) owner to ledger_writer;
alter function post_stock_count(uuid, uuid, uuid, uuid, text, uuid) owner to ledger_writer;
alter function cancel_stock_count(uuid, uuid, uuid) owner to ledger_writer;
alter function set_batch_status(uuid, uuid, uuid, text, text, text) owner to ledger_writer;
alter function post_disposal(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function has_key(uuid, text) from public, anon, authenticated, service_role;
revoke all on function stock_today(uuid) from public, anon, authenticated, service_role;
revoke all on function write_movement(uuid, uuid, uuid, uuid, numeric, text, numeric, uuid, text, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function doc_number(uuid, text, text) from public, anon, authenticated, service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'request_transfer(uuid, uuid, uuid, uuid, jsonb, text)', 'decide_transfer(uuid, uuid, uuid, text, text)',
    'dispatch_transfer(uuid, uuid, uuid, uuid, text, uuid)', 'receive_transfer(uuid, uuid, uuid, jsonb, uuid, text, uuid)',
    'post_stock_adjustment(uuid, uuid, uuid, text, text, jsonb, uuid, text, uuid)', 'start_stock_count(uuid, uuid, uuid, boolean, text)',
    'record_count(uuid, uuid, uuid, uuid, numeric, text)', 'post_stock_count(uuid, uuid, uuid, uuid, text, uuid)', 'cancel_stock_count(uuid, uuid, uuid)',
    'set_batch_status(uuid, uuid, uuid, text, text, text)', 'post_disposal(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
