-- =============================================================================
-- 0063 STOCK HOLDS (M-45 reservations, pharmacy track step 4). D-145.
--  A hold keeps specific lots aside for a patient or a named customer who will collect
--  later (the rest of a prescription, a phone order). While held, the quantity is reserved:
--  stock_balances.qty_reserved rises, allocate_stock (FEFO) already takes only on hand −
--  reserved, and the CHECK qty_reserved <= qty_on_hand stops any chosen-lot movement
--  (sale, transfer, disposal, return, count) from taking held stock.
--  Collection is an ordinary counter sale whose lines name the hold lines: they sell from
--  the held lots, and the hold ends as collected (anything not taken is released).
--  A hold ends early when released by hand (with a reason), when its time runs out (on the
--  next allocation in that store, at the next counter sale, and in the nightly job), or when
--  one of its lots stops being sellable (recalled, blocked, quarantined).
-- =============================================================================

create table stock_holds (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  hold_no         text not null,
  fiscal_year     text not null,
  store_id        uuid not null,
  patient_id      uuid,
  customer_name   text check (length(customer_name) <= 120),
  customer_phone  text check (length(customer_phone) <= 20),
  note            text check (length(note) <= 300),
  expires_at      timestamptz not null,
  status          text not null default 'held' check (status in ('held', 'collected', 'released', 'expired')),
  client_key      uuid not null,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  ended_at        timestamptz,
  ended_by        uuid,
  end_reason      text check (length(end_reason) <= 300),
  invoice_id      uuid,
  unique (tenant_id, id),
  unique (tenant_id, hold_no),
  unique (tenant_id, client_key),
  check (patient_id is not null or customer_name is not null),
  check ((status = 'held') = (ended_at is null)),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, patient_id) references patients (tenant_id, id),
  foreign key (tenant_id, created_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, ended_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id)
);
create index stock_holds_open on stock_holds (tenant_id, status, expires_at);
create index stock_holds_store on stock_holds (tenant_id, store_id, created_at desc);

-- One row per lot held. collected_base is what the collecting sale took.
create table stock_hold_lines (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  hold_id               uuid not null,
  line_no               smallint not null,
  store_id              uuid not null,
  item_id               uuid not null,
  batch_id              uuid not null,
  unit_id               uuid not null,
  qty_base              numeric(14,3) not null check (qty_base > 0),
  collected_base        numeric(14,3) not null default 0 check (collected_base >= 0 and collected_base <= qty_base),
  prescription_item_id  uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, hold_id) references stock_holds (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, unit_id) references item_units (tenant_id, id),
  foreign key (tenant_id, prescription_item_id) references prescription_items (tenant_id, id)
);
create index stock_hold_lines_hold on stock_hold_lines (hold_id);
create index stock_hold_lines_lot on stock_hold_lines (tenant_id, store_id, batch_id);
alter table stock_holds enable row level security;
alter table stock_hold_lines enable row level security;
revoke insert, update, delete on stock_holds, stock_hold_lines from service_role;
grant select, insert, update on stock_holds, stock_hold_lines to ledger_writer;
comment on table stock_holds is 'M-45 reservations: lots kept aside for a patient or customer. Raises stock_balances.qty_reserved while held (sync_reserved).';

-- What is reserved on one lot in one store = Σ (held − collected) over holds still held.
create or replace function sync_reserved(p_tenant uuid, p_store uuid, p_batch uuid)
returns void
language sql
set search_path = pg_catalog, public
as $$
  update stock_balances b
     set qty_reserved = coalesce((select sum(l.qty_base - l.collected_base) from stock_hold_lines l join stock_holds h on h.id = l.hold_id
                                   where h.status = 'held' and l.tenant_id = p_tenant and l.store_id = p_store and l.batch_id = p_batch), 0),
         updated_at = now()
   where b.tenant_id = p_tenant and b.store_id = p_store and b.batch_id = p_batch;
$$;

-- Ends holds whose time ran out (one store, or the whole clinic) and frees their stock. With
-- no store (the nightly job) it also rebuilds every reserved quantity from the holds.
create or replace function release_expired_holds(p_tenant uuid, p_store uuid default null)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_ids uuid[]; r record;
begin
  with x as (
    update stock_holds set status = 'expired', ended_at = now(), end_reason = 'Not collected in time'
     where tenant_id = p_tenant and status = 'held' and expires_at <= now() and (p_store is null or store_id = p_store)
    returning id)
  select array_agg(id) into v_ids from x;
  if p_store is null then
    update stock_balances b
       set qty_reserved = coalesce((select sum(l.qty_base - l.collected_base) from stock_hold_lines l join stock_holds h on h.id = l.hold_id
                                     where h.status = 'held' and l.tenant_id = p_tenant and l.store_id = b.store_id and l.batch_id = b.batch_id), 0),
           updated_at = now()
     where b.tenant_id = p_tenant
       and (b.qty_reserved > 0 or exists (select 1 from stock_hold_lines l join stock_holds h on h.id = l.hold_id
                                           where h.status = 'held' and l.tenant_id = p_tenant and l.store_id = b.store_id and l.batch_id = b.batch_id));
  elsif v_ids is not null then
    for r in select distinct store_id, batch_id from stock_hold_lines where hold_id = any(v_ids) loop
      perform sync_reserved(p_tenant, r.store_id, r.batch_id);
    end loop;
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end $$;

-- Hold medicines for a patient or a named customer. p_lines: [{ item_id, unit_id, qty,
-- batch_id?, prescription_item_id? }]. Lots are taken earliest expiry first unless a lot is
-- chosen (override_batch). A retry with the same key returns the same hold.
create or replace function create_stock_hold(p_tenant uuid, p_key uuid, p_store uuid, p_patient uuid, p_name text, p_phone text,
                                             p_hours integer, p_note text, p_lines jsonb, p_by uuid, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := gen_random_uuid(); v_fy text; v_no text; l jsonb; n integer := 0; k integer := 0; v_item inventory_items; v_unit item_units;
  v_md medicine_details; v_rxi prescription_items; v_rx prescriptions; v_qb numeric; v_lot item_batches; v_avail numeric; a record;
  v_set tenant_settings; v_today date; v_old stock_holds; v_exp timestamptz;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pharmacy_sell') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_active and is_sellable) then raise exception 'STORE_NOT_SELLABLE' using errcode = 'P0001'; end if;
  select * into v_old from stock_holds where tenant_id = p_tenant and client_key = p_key;
  if v_old.id is not null then
    return jsonb_build_object('hold_id', v_old.id, 'hold_no', v_old.hold_no, 'expires_at', v_old.expires_at, 'replayed', true);
  end if;
  if p_patient is not null and not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null and merged_into is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_patient is null and length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if coalesce(p_hours, 0) not between 1 and 168 then raise exception 'BAD_HOURS' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  v_today := stock_today(p_tenant);
  perform release_expired_holds(p_tenant, p_store);

  v_exp := now() + make_interval(hours => p_hours);
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'stock_hold', 'HD') d;
  insert into stock_holds (id, tenant_id, hold_no, fiscal_year, store_id, patient_id, customer_name, customer_phone, note, expires_at, client_key, created_by)
  values (v_id, p_tenant, v_no, v_fy, p_store, p_patient, nullif(btrim(p_name), ''), nullif(btrim(p_phone), ''), nullif(btrim(p_note), ''), v_exp, p_key, p_by);

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and is_active and deleted_at is null;
    if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id and can_sell;
    if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    select * into v_md from medicine_details where item_id = v_item.id;
    if v_md.schedule_class in ('controlled', 'narcotic') then raise exception 'CONTROLLED_BLOCKED: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    v_rxi := null;
    if nullif(l->>'prescription_item_id', '') is not null then
      if not has_key(p_by, 'dispense_prescription') then raise exception 'NO_DISPENSING_RIGHT' using errcode = 'P0001'; end if;
      select * into v_rxi from prescription_items where id = (l->>'prescription_item_id')::uuid and tenant_id = p_tenant;
      select * into v_rx from prescriptions where id = v_rxi.prescription_id;
      if v_rxi.id is null or v_rx.status <> 'issued' or v_rx.patient_id is distinct from p_patient then raise exception 'RX_NOT_VALID: line %', n using errcode = 'P0001'; end if;
    end if;
    v_qb := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
    if v_qb <> trunc(v_qb) and not v_item.allow_loose_sale then raise exception 'NO_LOOSE_SALE: line %', n using errcode = 'P0001'; end if;
    if nullif(l->>'batch_id', '') is not null then
      if not has_key(p_by, 'override_batch') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
      select * into v_lot from item_batches where id = (l->>'batch_id')::uuid and tenant_id = p_tenant and item_id = v_item.id;
      if v_lot.id is null or v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today + v_set.min_sale_shelf_days) then
        raise exception 'LOT_NOT_SELLABLE: line %', n using errcode = 'P0001';
      end if;
      select qty_on_hand - qty_reserved into v_avail from stock_balances where tenant_id = p_tenant and store_id = p_store and batch_id = v_lot.id for update;
      if coalesce(v_avail, 0) < v_qb then raise exception 'INSUFFICIENT_STOCK: line %', n using errcode = 'P0001'; end if;
      k := k + 1;
      insert into stock_hold_lines (tenant_id, hold_id, line_no, store_id, item_id, batch_id, unit_id, qty_base, prescription_item_id)
      values (p_tenant, v_id, k, p_store, v_item.id, v_lot.id, v_unit.id, v_qb, v_rxi.id);
      perform sync_reserved(p_tenant, p_store, v_lot.id);
    else
      for a in select * from allocate_stock(p_tenant, p_store, v_item.id, v_qb, 'sale') loop
        k := k + 1;
        insert into stock_hold_lines (tenant_id, hold_id, line_no, store_id, item_id, batch_id, unit_id, qty_base, prescription_item_id)
        values (p_tenant, v_id, k, p_store, v_item.id, a.batch_id, v_unit.id, a.qty_base, v_rxi.id);
        perform sync_reserved(p_tenant, p_store, a.batch_id);
      end loop;
    end if;
  end loop;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'hold.create', 'stock_hold', v_id::text, 'success',
          jsonb_build_object('no', v_no, 'store', p_store, 'patient', p_patient, 'lines', n, 'hours', p_hours));
  return jsonb_build_object('hold_id', v_id, 'hold_no', v_no, 'expires_at', v_exp, 'replayed', false);
end $$;

-- Give held stock back to the shelf (the customer isn't coming, changed their mind).
create or replace function release_stock_hold(p_tenant uuid, p_hold uuid, p_reason text, p_by uuid, p_session_level text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare h stock_holds; r record;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pharmacy_sell') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  select * into h from stock_holds where id = p_hold and tenant_id = p_tenant for update;
  if h.id is null then raise exception 'HOLD_NOT_FOUND' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, h.store_id), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if h.status <> 'held' then raise exception 'HOLD_NOT_HELD' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update stock_holds set status = 'released', ended_at = now(), ended_by = p_by, end_reason = btrim(p_reason) where id = p_hold;
  for r in select distinct store_id, batch_id from stock_hold_lines where hold_id = p_hold loop
    perform sync_reserved(p_tenant, r.store_id, r.batch_id);
  end loop;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'hold.release', 'stock_hold', p_hold::text, 'success', btrim(p_reason), jsonb_build_object('no', h.hold_no));
end $$;

-- A lot that stops being sellable (recalled, blocked, quarantined) can't be handed over:
-- every hold on it ends, and its stock is freed for the recall or disposal.
create or replace function release_holds_on_lot()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare r record; v_ids uuid[];
begin
  with x as (
    update stock_holds h set status = 'released', ended_at = now(),
           end_reason = 'Batch ' || new.batch_no || ' was ' || new.status || ', so the hold was released'
     where h.tenant_id = new.tenant_id and h.status = 'held'
       and exists (select 1 from stock_hold_lines l where l.hold_id = h.id and l.batch_id = new.id)
    returning h.id)
  select array_agg(id) into v_ids from x;
  if v_ids is not null then
    for r in select distinct store_id, batch_id from stock_hold_lines where hold_id = any(v_ids) loop
      perform sync_reserved(new.tenant_id, r.store_id, r.batch_id);
    end loop;
  end if;
  return new;
end $$;
create trigger item_batches_release_holds after update of status on item_batches
  for each row when (old.status = 'active' and new.status <> 'active') execute function release_holds_on_lot();

-- ── allocate_stock: as in 0020, first ending this store's holds whose time ran out ─────
create or replace function allocate_stock(p_tenant uuid, p_store uuid, p_item uuid, p_base_qty numeric, p_purpose text)
returns table (batch_id uuid, qty_base numeric, unit_cost_base numeric, sale_price_base numeric, expiry_date date)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_left numeric := p_base_qty; v_today date; v_margin integer; r record; v_take numeric;
begin
  if p_base_qty is null or p_base_qty <= 0 then raise exception 'BAD_QTY' using errcode = 'P0001'; end if;
  if p_purpose = 'sale' and not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_sellable and is_active) then
    raise exception 'STORE_NOT_SELLABLE' using errcode = 'P0001';
  end if;
  perform release_expired_holds(p_tenant, p_store);
  select (now() at time zone t.timezone)::date, s.min_sale_shelf_days into v_today, v_margin
    from tenants t join tenant_settings s on s.tenant_id = t.id where t.id = p_tenant;
  for r in
    select b.batch_id bid, b.qty_on_hand - b.qty_reserved avail, ib.unit_cost_base cost, ib.sale_price_base price, ib.expiry_date exp
      from stock_balances b join item_batches ib on ib.id = b.batch_id
     where b.tenant_id = p_tenant and b.store_id = p_store and b.item_id = p_item
       and ib.status = 'active' and (ib.expiry_date is null or ib.expiry_date > v_today + case when p_purpose = 'sale' then v_margin else 0 end)
       and b.qty_on_hand - b.qty_reserved > 0
     order by ib.expiry_date nulls last, ib.created_at, b.batch_id
       for update of b
  loop
    exit when v_left <= 0;
    v_take := least(v_left, r.avail);
    batch_id := r.bid; qty_base := v_take; unit_cost_base := r.cost; sale_price_base := r.price; expiry_date := r.exp;
    return next;
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001'; end if;
end $$;

-- ── nightly: as in 0048, plus expired holds (and a rebuild of what is reserved) ───────
create or replace function run_daily_jobs(p_tenant uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_req integer := 0; v_holds integer := 0; t uuid;
begin
  for t in select id from tenants where status = 'active' and (p_tenant is null or id = p_tenant) loop
    v_req := v_req + expire_booking_requests(t);
    v_holds := v_holds + release_expired_holds(t, null);
  end loop;
  return jsonb_build_object(
    'suspended', case when p_tenant is null then suspend_expired_tenants() else 0 end,
    'requests_expired', v_req,
    'holds_expired', v_holds,
    'no_shows', mark_no_shows(p_tenant),
    'stock_notified', daily_stock_scan(p_tenant),
    'subscription_warned', warn_subscriptions_ending(p_tenant),
    'pruned', case when p_tenant is null then prune_sign_in_records() else '{}'::jsonb end);
end $$;

-- ── issue_counter_sale: as in 0060 (body from the live database), with hold collection ──
create or replace function issue_counter_sale(p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_patient uuid, p_customer_name text, p_customer_phone text, p_lines jsonb, p_external_rx jsonb, p_cash numeric, p_online numeric, p_channel text, p_reference text, p_by uuid, p_session_level text, p_device uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_set tenant_settings; v_store stores; v_bp billing_profiles; v_inv uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_n bigint;
  v_no text; l jsonb; n integer := 0; v_item inventory_items; v_unit item_units; v_md medicine_details; v_svc services; v_qb numeric; v_line uuid;
  v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric; v_cost numeric; a record; v_rxi prescription_items; v_rx prescriptions;
  v_sub numeric := 0; v_dsum numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_rev_items numeric := 0; v_rev_svc numeric := 0; v_cogs numeric := 0;
  v_total numeric; v_cash numeric := round(coalesce(p_cash, 0), 2); v_online numeric := round(coalesce(p_online, 0), 2); v_paid numeric; v_due numeric;
  v_ext uuid; v_needs_ext boolean := false; v_entries jsonb; v_pay uuid; v_rcpt text; v_lot item_batches; v_today date; v_pct numeric; v_adv numeric := 0;
  v_hl stock_hold_lines; v_holds uuid[]; hr record;
begin
  if p_session_level not in ('A1', 'A2', 'A3') then raise exception 'SESSION_LEVEL_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pharmacy_sell') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  select * into v_store from stores where id = p_store and tenant_id = p_tenant and is_active and is_sellable;
  if v_store.id is null then raise exception 'STORE_NOT_SELLABLE' using errcode = 'P0001'; end if;
  if not exists (select 1 from tenants where id = p_tenant and status = 'active') then raise exception 'TENANT_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if p_patient is not null and not exists (select 1 from patients where id = p_patient and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'PATIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;
  v_today := stock_today(p_tenant);
  perform release_expired_holds(p_tenant, p_store);   -- M-45: holds whose time ran out free their stock first

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'invoice', v_inv, p_by, p_session_level, p_device) b;
  if v_replayed then
    return (select jsonb_build_object('invoice_id', i.id, 'invoice_no', i.invoice_no, 'total', i.total, 'replayed', true) from invoices i where i.posting_id = v_post);
  end if;
  select * into v_bp from billing_profiles where tenant_id = p_tenant and is_active
   order by (id = v_store.billing_profile_id) desc, (id = v_set.default_billing_profile_id) desc, is_default desc limit 1;
  if v_bp.id is null then raise exception 'NO_BILLING_PROFILE' using errcode = 'P0001'; end if;
  select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'invoice', v_bp.id) d;
  v_no := case when v_bp.invoice_prefix = '' then '' else v_bp.invoice_prefix || '-' end || lpad(v_n::text, v_bp.invoice_pad, '0');
  insert into invoices (id, tenant_id, billing_profile_id, invoice_no, fiscal_year, patient_id, customer_name, customer_phone, source, store_id,
                        subtotal, discount_total, taxable_amount, tax_total, total, issued_by, posting_id)
  values (v_inv, p_tenant, v_bp.id, v_no, v_fy, p_patient, nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), 'counter', p_store,
          0, 0, 0, 0, 0, p_by, v_post);

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_line := gen_random_uuid();
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'discount_pct')::numeric, 0) not between 0 and 100 then raise exception 'BAD_DISCOUNT: line %', n using errcode = 'P0001'; end if;

    if l->>'kind' = 'service' then
      select * into v_svc from services where id = (l->>'service_id')::uuid and tenant_id = p_tenant and is_active;
      if v_svc.id is null then raise exception 'SERVICE_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      v_gross := round((l->>'qty')::numeric * v_svc.price_npr, 2);
      v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
      v_net := v_gross - v_disc;
      v_tax := case when v_svc.tax_category = 'vat13' then round(v_net * 0.13, 2) else 0 end;
      insert into invoice_lines (id, tenant_id, invoice_id, line_no, line_type, service_id, description, qty, unit_price, discount_amount, tax_rate, tax_amount, line_total)
      values (v_line, p_tenant, v_inv, n, 'service', v_svc.id, v_svc.name, (l->>'qty')::numeric, v_svc.price_npr, v_disc, case when v_tax > 0 then 13 else 0 end, v_tax, v_net + v_tax);
      v_rev_svc := v_rev_svc + v_net;
    else
      select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and is_active and deleted_at is null;
      if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id and can_sell;
      if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
      select * into v_md from medicine_details where item_id = v_item.id;
      if v_md.schedule_class in ('controlled', 'narcotic') then raise exception 'CONTROLLED_BLOCKED: line %', n using errcode = 'P0001'; end if;
      v_rxi := null;
      if nullif(l->>'prescription_item_id', '') is not null then
        if not has_key(p_by, 'dispense_prescription') then raise exception 'NO_DISPENSING_RIGHT' using errcode = 'P0001'; end if;
        select * into v_rxi from prescription_items where id = (l->>'prescription_item_id')::uuid and tenant_id = p_tenant;
        select * into v_rx from prescriptions where id = v_rxi.prescription_id;
        if v_rxi.id is null or v_rx.status <> 'issued' or v_rx.patient_id is distinct from p_patient then raise exception 'RX_NOT_VALID: line %', n using errcode = 'P0001'; end if;
      elsif v_md.requires_prescription then
        if not has_key(p_by, 'sell_prescription_only') then raise exception 'NO_DISPENSING_RIGHT' using errcode = 'P0001'; end if;
        if p_external_rx is null or coalesce(btrim(p_external_rx->>'prescriber_name'), '') = '' then raise exception 'RX_REQUIRED: line %', n using errcode = 'P0001'; end if;
        v_needs_ext := true;
      end if;
      v_qb := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
      if v_qb <> trunc(v_qb) and not v_item.allow_loose_sale then raise exception 'NO_LOOSE_SALE: line %', n using errcode = 'P0001'; end if;
      insert into invoice_lines (id, tenant_id, invoice_id, line_no, line_type, item_id, unit_id, factor_snapshot, description, qty, unit_price, discount_amount,
                                 tax_rate, tax_amount, line_total, prescription_item_id, substitution_reason)
      values (v_line, p_tenant, v_inv, n, 'item', v_item.id, v_unit.id, v_unit.factor_to_base, v_item.name, (l->>'qty')::numeric, 0, 0, 0, 0, 0,
              v_rxi.id, nullif(btrim(l->>'substitution_reason'), ''));
      v_gross := 0; v_cost := 0;
      if nullif(l->>'hold_line_id', '') is not null then
        -- M-45: collecting a hold. The line sells from the held lot, up to what was held; the
        -- reservation drops first so the held stock is free for this sale only.
        select hl.* into v_hl from stock_hold_lines hl join stock_holds h on h.id = hl.hold_id
         where hl.id = (l->>'hold_line_id')::uuid and hl.tenant_id = p_tenant and h.status = 'held' and h.store_id = p_store
           and hl.item_id = v_item.id and hl.collected_base = 0
           and (h.patient_id is null or h.patient_id = p_patient or exists (select 1 from patients x where x.id = h.patient_id and x.merged_into = p_patient))
           for update of h, hl;
        if v_hl.id is null then raise exception 'HOLD_NOT_VALID: line %', n using errcode = 'P0001'; end if;
        if v_qb > v_hl.qty_base then raise exception 'MORE_THAN_HELD: line %', n using errcode = 'P0001'; end if;
        select * into v_lot from item_batches where id = v_hl.batch_id;
        if v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today) then raise exception 'LOT_NOT_SELLABLE: line %', n using errcode = 'P0001'; end if;
        update stock_hold_lines set collected_base = v_qb where id = v_hl.id;
        perform sync_reserved(p_tenant, p_store, v_lot.id);
        if not (v_hl.hold_id = any(coalesce(v_holds, '{}'))) then v_holds := array_append(v_holds, v_hl.hold_id); end if;
        perform 1 from stock_balances where tenant_id = p_tenant and store_id = p_store and batch_id = v_lot.id for update;
        insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
        values (p_tenant, v_line, v_item.id, v_lot.id, p_store, v_qb, v_lot.sale_price_base, v_lot.unit_cost_base);
        perform write_movement(p_tenant, p_store, v_lot.id, v_item.id, -v_qb, 'sale', v_lot.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
        v_gross := v_qb * v_lot.sale_price_base; v_cost := v_qb * v_lot.unit_cost_base;
      elsif nullif(l->>'batch_id', '') is not null then
        -- A chosen lot (override_batch): it must be sellable here, never expired or blocked.
        if not has_key(p_by, 'override_batch') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
        select * into v_lot from item_batches where id = (l->>'batch_id')::uuid and tenant_id = p_tenant and item_id = v_item.id;
        if v_lot.id is null or v_lot.status <> 'active' or (v_lot.expiry_date is not null and v_lot.expiry_date <= v_today + v_set.min_sale_shelf_days) then
          raise exception 'LOT_NOT_SELLABLE: line %', n using errcode = 'P0001';
        end if;
        perform 1 from stock_balances where tenant_id = p_tenant and store_id = p_store and batch_id = v_lot.id for update;
        insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
        values (p_tenant, v_line, v_item.id, v_lot.id, p_store, v_qb, v_lot.sale_price_base, v_lot.unit_cost_base);
        perform write_movement(p_tenant, p_store, v_lot.id, v_item.id, -v_qb, 'sale', v_lot.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
        v_gross := v_qb * v_lot.sale_price_base; v_cost := v_qb * v_lot.unit_cost_base;
      else
        for a in select * from allocate_stock(p_tenant, p_store, v_item.id, v_qb, 'sale') loop
          insert into invoice_line_allocations (tenant_id, invoice_line_id, item_id, batch_id, store_id, base_qty, unit_price_base, unit_cost_base)
          values (p_tenant, v_line, v_item.id, a.batch_id, p_store, a.qty_base, a.sale_price_base, a.unit_cost_base);
          perform write_movement(p_tenant, p_store, a.batch_id, v_item.id, -a.qty_base, 'sale', a.unit_cost_base, v_post, 'invoice', v_inv, v_line, null, p_by);
          v_gross := v_gross + a.qty_base * a.sale_price_base; v_cost := v_cost + a.qty_base * a.unit_cost_base;
        end loop;
      end if;
      v_gross := round(v_gross, 2); v_cost := round(v_cost, 2);
      v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
      v_net := v_gross - v_disc;
      v_tax := case when v_item.tax_category = 'vat13' then round(v_net * 0.13, 2) else 0 end;
      update invoice_lines set unit_price = round(v_gross / (l->>'qty')::numeric, 2), discount_amount = v_disc, tax_rate = case when v_tax > 0 then 13 else 0 end,
             tax_amount = v_tax, line_total = v_net + v_tax, cost_total = v_cost
       where id = v_line;
      v_rev_items := v_rev_items + v_net; v_cogs := v_cogs + v_cost;
    end if;
    v_sub := v_sub + v_gross; v_dsum := v_dsum + v_disc; v_taxsum := v_taxsum + v_tax;
    if v_tax > 0 then v_taxable := v_taxable + v_net; end if;
  end loop;

  -- M-45: each hold collected here ends; whatever it held that this bill didn't take goes back.
  if v_holds is not null then
    update stock_holds set status = 'collected', invoice_id = v_inv, ended_at = now(), ended_by = p_by,
           end_reason = case when exists (select 1 from stock_hold_lines x where x.hold_id = stock_holds.id and x.collected_base < x.qty_base)
                             then 'Collected in part; the rest went back to the shelf' end
     where id = any(v_holds);
    for hr in select distinct store_id, batch_id from stock_hold_lines where hold_id = any(v_holds) loop
      perform sync_reserved(p_tenant, hr.store_id, hr.batch_id);
    end loop;
  end if;

  v_pct := case when v_sub > 0 then v_dsum * 100 / v_sub else 0 end;
  if v_pct > v_set.max_discount_pct_without_reauth and not has_key(p_by, 'apply_discounts') then raise exception 'DISCOUNT_NEEDS_APPROVAL' using errcode = 'P0001'; end if;
  v_total := v_sub - v_dsum + v_taxsum;
  v_paid := v_cash + v_online;
  if v_paid > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  v_due := v_total - v_paid;
  -- M-52: what the patient's advance covers needs no credit.
  if v_due > 0 and p_patient is not null then v_adv := least(v_due, patient_advance_locked(p_tenant, p_patient)); end if;
  if v_due - v_adv > 0 then
    if p_patient is null then raise exception 'PATIENT_REQUIRED_FOR_DUE' using errcode = 'P0001'; end if;
    if not v_set.allow_credit or not has_key(p_by, 'allow_credit') then raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001'; end if;
    if v_due - v_adv + coalesce((select sum(invoice_outstanding(i.id)) from invoices i where i.tenant_id = p_tenant and i.patient_id = p_patient and i.status = 'issued' and i.id <> v_inv), 0)
       > v_set.credit_limit_per_patient then
      raise exception 'CREDIT_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  if v_needs_ext then
    insert into external_prescriptions (tenant_id, patient_id, prescriber_name, prescriber_reg_no, facility, rx_date, recorded_by)
    values (p_tenant, p_patient, btrim(p_external_rx->>'prescriber_name'), nullif(btrim(p_external_rx->>'prescriber_reg_no'), ''),
            nullif(btrim(p_external_rx->>'facility'), ''), coalesce(nullif(p_external_rx->>'rx_date', '')::date, v_today), p_by)
    returning id into v_ext;
  end if;
  update invoices set subtotal = v_sub, discount_total = v_dsum, taxable_amount = v_taxable, tax_total = v_taxsum, total = v_total, external_prescription_id = v_ext
   where id = v_inv;

  v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'debit', v_total, 'patient_id', p_patient, 'store_id', p_store, 'memo', v_no));
  if v_rev_items > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_PHARMACY', 'credit', v_rev_items, 'store_id', p_store, 'memo', v_no); end if;
  if v_rev_svc > 0 then v_entries := v_entries || jsonb_build_object('account', 'REV_SERVICES', 'credit', v_rev_svc, 'store_id', p_store, 'memo', v_no); end if;
  if v_taxsum > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_PAYABLE', 'credit', v_taxsum, 'memo', v_no); end if;
  if v_cogs > 0 then
    v_entries := v_entries || jsonb_build_object('account', 'COGS', 'debit', v_cogs, 'store_id', p_store, 'memo', v_no)
                           || jsonb_build_object('account', 'INVENTORY', 'credit', v_cogs, 'store_id', p_store, 'memo', v_no);
  end if;
  if v_total > 0 or v_cogs > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;

  if v_paid > 0 then
    v_pay := gen_random_uuid();
    select b.posting_id, b.replayed into v_post, v_replayed
      from begin_posting(p_tenant, md5(p_idempotency_key::text || ':payment')::uuid, 'payment', v_pay, p_by, p_session_level, p_device) b;
    select d.fiscal_year, d.doc_no into v_fy, v_n from next_document_no(p_tenant, 'receipt', v_bp.id) d;
    v_rcpt := 'R-' || lpad(v_n::text, v_bp.invoice_pad, '0');
    insert into payments (id, tenant_id, billing_profile_id, receipt_no, fiscal_year, patient_id, amount, cash_amount, online_amount, online_channel, reference, received_by, posting_id)
    values (v_pay, p_tenant, v_bp.id, v_rcpt, v_fy, p_patient, v_paid, v_cash, v_online, case when v_online > 0 then p_channel end, nullif(btrim(p_reference), ''), p_by, v_post);
    insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values (p_tenant, v_pay, v_inv, v_paid);
    v_entries := jsonb_build_array(jsonb_build_object('account', 'AR_PATIENTS', 'credit', v_paid, 'patient_id', p_patient, 'memo', v_rcpt));
    if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'debit', v_cash, 'channel', 'cash', 'store_id', p_store); end if;
    if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'debit', v_online, 'channel', p_channel, 'store_id', p_store); end if;
    perform post_journal(p_tenant, v_post, v_entries);
  end if;

  if v_adv > 0 then v_adv := apply_patient_advance(p_tenant, p_idempotency_key, p_patient, v_inv, v_adv, p_by, p_session_level, p_device); end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'invoice.issue', 'invoice', v_inv::text, 'success',
          jsonb_build_object('no', v_no, 'store', p_store, 'total', v_total, 'paid', v_paid, 'from_advance', v_adv, 'lines', n, 'external_rx', v_ext is not null, 'holds', to_jsonb(v_holds)));
  return jsonb_build_object('invoice_id', v_inv, 'invoice_no', v_no, 'receipt_no', v_rcpt, 'total', v_total, 'paid', v_paid, 'due', v_due - v_adv, 'from_advance', v_adv, 'replayed', false);
end $function$;

-- ── ownership and access ──────────────────────────────────────────────────────
grant create on schema public to ledger_writer;
alter function sync_reserved(uuid, uuid, uuid) owner to ledger_writer;
alter function release_expired_holds(uuid, uuid) owner to ledger_writer;
alter function create_stock_hold(uuid, uuid, uuid, uuid, text, text, integer, text, jsonb, uuid, text) owner to ledger_writer;
alter function release_stock_hold(uuid, uuid, text, uuid, text) owner to ledger_writer;
revoke create on schema public from ledger_writer;
revoke all on function sync_reserved(uuid, uuid, uuid), release_expired_holds(uuid, uuid), release_holds_on_lot(),
                       create_stock_hold(uuid, uuid, uuid, uuid, text, text, integer, text, jsonb, uuid, text), release_stock_hold(uuid, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function create_stock_hold(uuid, uuid, uuid, uuid, text, text, integer, text, jsonb, uuid, text), release_stock_hold(uuid, uuid, text, uuid, text) to service_role;
-- The nightly job and the lot-status trigger (recall_batch runs as postgres) end holds too.
grant execute on function sync_reserved(uuid, uuid, uuid), release_expired_holds(uuid, uuid) to postgres;
