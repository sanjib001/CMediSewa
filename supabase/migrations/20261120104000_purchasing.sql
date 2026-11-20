-- =============================================================================
-- 0041 PURCHASING (B6a): vendors (+ opening payable), purchase invoices received into new
-- lots, vendor payments allocated FIFO (remainder = advance), void while untouched.
-- The payable is NEVER stored: it is the AP_VENDORS journal balance per vendor (§10, §12).
-- database.md §10; D-41, D-43, D-44. P-08 default: input VAT is recoverable (TAX_RECEIVABLE).
-- =============================================================================

create table vendor_code_counters (tenant_id uuid primary key references tenants (id) on delete restrict, next_no bigint not null default 1);

create table vendors (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  vendor_code         text not null,
  name                text not null check (length(btrim(name)) between 2 and 120),
  pan_vat_no          text check (pan_vat_no ~ '^\d{9}$'),
  contact_person      text check (length(contact_person) <= 80),
  phone               text check (phone ~ '^[0-9+() -]{7,20}$'),
  email               text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address             text check (length(address) <= 200),
  payment_terms_days  smallint check (payment_terms_days between 0 and 365),
  is_active           boolean not null default true,
  notes               text check (length(notes) <= 500),
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, vendor_code)
);
create unique index vendors_name on vendors (tenant_id, lower(btrim(name)));

-- The journal can now point at vendors; lots at their purchase line and vendor.
alter table ledger_entries add constraint ledger_entries_vendor_fk foreign key (tenant_id, vendor_id) references vendors (tenant_id, id);

create table purchase_invoices (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete restrict,
  purchase_no           text not null,
  fiscal_year           text not null,
  kind                  text not null default 'purchase' check (kind in ('purchase', 'opening')),
  vendor_id             uuid not null,
  vendor_invoice_no     text not null check (length(btrim(vendor_invoice_no)) between 1 and 40),
  vendor_invoice_date   date not null,
  received_store_id     uuid,
  status                text not null default 'posted' check (status in ('posted', 'void')),
  subtotal              numeric(14,2) not null default 0,
  line_discount_total   numeric(14,2) not null default 0,
  bill_discount         numeric(14,2) not null default 0 check (bill_discount >= 0),
  taxable_amount        numeric(14,2) not null default 0,
  tax_amount            numeric(14,2) not null default 0,
  round_off             numeric(6,2) not null default 0 check (round_off between -1 and 1),
  total                 numeric(14,2) not null check (total >= 0),
  paid_cash             numeric(14,2) not null default 0 check (paid_cash >= 0),
  paid_online           numeric(14,2) not null default 0 check (paid_online >= 0),
  online_channel        text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  credit_amount         numeric(14,2) not null default 0 check (credit_amount >= 0),
  note                  text check (length(note) <= 300),
  posted_by             uuid not null,
  posted_at             timestamptz not null default now(),
  posting_id            uuid not null,
  void_reason           text,
  voided_by             uuid,
  voided_at             timestamptz,
  void_posting_id       uuid,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, purchase_no),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id),
  foreign key (tenant_id, received_store_id) references stores (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, voided_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  foreign key (tenant_id, void_posting_id) references postings (tenant_id, id),
  check (paid_cash + paid_online + credit_amount = total),          -- HRestroSewa purchases_amounts_balance
  check ((paid_online = 0) = (online_channel is null)),
  check (kind = 'opening' or received_store_id is not null),
  check ((status = 'void') = (voided_at is not null))
);
-- Duplicate bill prevention (§10): the same vendor bill number can be entered once.
create unique index purchase_invoices_no_duplicate on purchase_invoices (tenant_id, vendor_id, lower(btrim(vendor_invoice_no))) where status <> 'void';
create index purchase_invoices_vendor on purchase_invoices (tenant_id, vendor_id, vendor_invoice_date);

create table purchase_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  purchase_id       uuid not null,
  line_no           smallint not null,
  item_id           uuid not null,
  unit_id           uuid not null,
  qty               numeric(14,3) not null check (qty > 0),
  free_qty          numeric(14,3) not null default 0 check (free_qty >= 0),
  factor_snapshot   numeric(14,4) not null check (factor_snapshot > 0),
  base_qty          numeric(14,3) generated always as (round(qty * factor_snapshot, 3)) stored,
  free_base_qty     numeric(14,3) generated always as (round(free_qty * factor_snapshot, 3)) stored,
  unit_cost         numeric(14,4) not null check (unit_cost >= 0),
  discount_pct      numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  discount_amount   numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_rate          numeric(5,2) not null default 0 check (tax_rate in (0, 13)),
  tax_amount        numeric(14,2) not null default 0,
  line_net          numeric(14,2) not null check (line_net >= 0),
  batch_no          text not null,
  mfg_date          date,
  expiry_date       date,
  mrp               numeric(14,4) check (mrp >= 0),
  sale_price        numeric(14,4) check (sale_price >= 0),
  batch_id          uuid not null,
  unique (tenant_id, id),
  unique (purchase_id, line_no),
  foreign key (tenant_id, purchase_id) references purchase_invoices (tenant_id, id),
  foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);
alter table item_batches
  add constraint item_batches_purchase_line_fk foreign key (tenant_id, purchase_invoice_line_id) references purchase_invoice_lines (tenant_id, id),
  add constraint item_batches_vendor_fk foreign key (tenant_id, vendor_id) references vendors (tenant_id, id);
create unique index item_batches_purchase_line on item_batches (purchase_invoice_line_id) where purchase_invoice_line_id is not null;

create table vendor_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete restrict,
  payment_no      text not null,
  fiscal_year     text not null,
  vendor_id       uuid not null,
  amount          numeric(14,2) not null check (amount > 0),
  cash_amount     numeric(14,2) not null default 0 check (cash_amount >= 0),
  online_amount   numeric(14,2) not null default 0 check (online_amount >= 0),
  online_channel  text check (online_channel in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')),
  reference       text check (length(reference) <= 80),
  note            text check (length(note) <= 300),
  paid_by         uuid not null,
  paid_at         timestamptz not null default now(),
  posting_id      uuid not null,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_year, payment_no),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id),
  foreign key (tenant_id, paid_by) references tenant_members (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  check (cash_amount + online_amount = amount),
  check ((online_amount = 0) = (online_channel is null))
);
create table vendor_payment_allocations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  vendor_payment_id    uuid not null,
  purchase_invoice_id  uuid not null,
  amount               numeric(14,2) not null check (amount > 0),
  unique (tenant_id, id),
  foreign key (tenant_id, vendor_payment_id) references vendor_payments (tenant_id, id),
  foreign key (tenant_id, purchase_invoice_id) references purchase_invoices (tenant_id, id)
);
create index vendor_payment_allocations_invoice on vendor_payment_allocations (purchase_invoice_id);

alter table vendor_code_counters        enable row level security;
alter table vendors                     enable row level security;
alter table purchase_invoices           enable row level security;
alter table purchase_invoice_lines      enable row level security;
alter table vendor_payments             enable row level security;
alter table vendor_payment_allocations  enable row level security;
revoke all on vendor_code_counters from service_role;
revoke insert, delete on vendors from service_role;   -- created via save_vendor; never deleted (deactivate)
revoke update (vendor_code, tenant_id) on vendors from service_role;
revoke insert, update, delete on purchase_invoices, purchase_invoice_lines, vendor_payments, vendor_payment_allocations from service_role;

-- What a vendor bill still owes: credit part − payments allocated to it (credit notes in B6b).
create or replace function purchase_outstanding(p_invoice uuid)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select case when pi.status = 'void' then 0 else pi.credit_amount - coalesce((select sum(a.amount) from vendor_payment_allocations a where a.purchase_invoice_id = pi.id), 0) end
    from purchase_invoices pi where pi.id = p_invoice;
$$;

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

create or replace function save_vendor(p_tenant uuid, p_vendor uuid, p_d jsonb, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := p_vendor; v_no bigint;
begin
  perform assert_active_member(p_tenant, p_by);
  if coalesce(length(btrim(p_d->>'name')), 0) < 2 then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into vendor_code_counters as c (tenant_id, next_no) values (p_tenant, 2)
    on conflict (tenant_id) do update set next_no = c.next_no + 1 returning next_no - 1 into v_no;
    insert into vendors (tenant_id, vendor_code, name) values (p_tenant, 'VEN-' || lpad(v_no::text, 4, '0'), btrim(p_d->>'name')) returning id into v_id;
  elsif not exists (select 1 from vendors where id = v_id and tenant_id = p_tenant) then
    raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001';
  end if;
  update vendors set name = btrim(p_d->>'name'), pan_vat_no = nullif(btrim(p_d->>'pan_vat_no'), ''), contact_person = nullif(btrim(p_d->>'contact_person'), ''),
         phone = nullif(btrim(p_d->>'phone'), ''), email = nullif(lower(btrim(p_d->>'email')), ''), address = nullif(btrim(p_d->>'address'), ''),
         payment_terms_days = nullif(p_d->>'payment_terms_days', '')::smallint, is_active = coalesce((p_d->>'is_active')::boolean, true),
         notes = nullif(btrim(p_d->>'notes'), '')
   where id = v_id;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome)
  values (p_tenant, 'member', p_by, case when p_vendor is null then 'vendor.create' else 'vendor.update' end, 'vendor', v_id::text, 'success');
  return v_id;
exception when unique_violation then
  if sqlerrm like '%vendors_name%' then raise exception 'VENDOR_NAME_TAKEN' using errcode = 'P0001'; end if;
  raise;
end $$;

-- Opening payable (what the clinic already owed this vendor on day one): an 'opening' bill
-- with no lines, posted Dr OPENING_EQUITY / Cr AP_VENDORS, so payments settle it FIFO like any bill.
create or replace function post_vendor_opening(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_amount numeric, p_as_of date,
                                               p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_vendors') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if exists (select 1 from purchase_invoices where tenant_id = p_tenant and vendor_id = p_vendor and kind = 'opening' and status = 'posted') then
    raise exception 'OPENING_EXISTS' using errcode = 'P0001';
  end if;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'vendor_opening', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from purchase_invoices where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'purchase', 'PUR') d;
  insert into purchase_invoices (id, tenant_id, purchase_no, fiscal_year, kind, vendor_id, vendor_invoice_no, vendor_invoice_date, subtotal, taxable_amount, total,
                                 credit_amount, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, 'opening', p_vendor, 'OPENING', coalesce(p_as_of, stock_today(p_tenant)), round(p_amount, 2), round(p_amount, 2), round(p_amount, 2),
          round(p_amount, 2), 'Opening balance owed', p_by, v_post);
  perform post_journal(p_tenant, v_post, jsonb_build_array(
    jsonb_build_object('account', 'OPENING_EQUITY', 'debit', round(p_amount, 2), 'memo', 'Vendor opening ' || v_no),
    jsonb_build_object('account', 'AP_VENDORS', 'credit', round(p_amount, 2), 'vendor_id', p_vendor, 'memo', 'Opening balance')));
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'vendor.opening', 'vendor', p_vendor::text, 'success', jsonb_build_object('amount', p_amount));
  return v_id;
end $$;

-- Receive a vendor bill (W-41): each line becomes a NEW lot in the receiving store (never
-- overwriting an existing lot's cost, expiry or price), stock 'purchase' movements, and one
-- journal entry: Dr INVENTORY (net cost) + Dr TAX_RECEIVABLE; Cr CASH / BANK / AP_VENDORS.
-- Totals come from the lines; the client's totals are ignored.
-- p_lines: [{ item_id, unit_id, qty, free_qty, unit_cost, discount_pct, tax_rate, batch_no, mfg_date, expiry_date, mrp, sale_price, short_expiry_reason }]
create or replace function post_purchase_invoice(
  p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_vendor_invoice_no text, p_vendor_invoice_date date, p_store uuid,
  p_lines jsonb, p_bill_discount numeric, p_round_off numeric, p_paid_cash numeric, p_paid_online numeric, p_online_channel text, p_note text,
  p_by uuid, p_session_level text, p_device uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_set tenant_settings; l jsonb; n integer := 0;
  v_unit item_units; v_item inventory_items; v_gross numeric; v_disc numeric; v_net numeric; v_tax numeric;
  v_sub numeric := 0; v_ldisc numeric := 0; v_taxable numeric := 0; v_taxsum numeric := 0; v_total numeric; v_bill numeric := round(coalesce(p_bill_discount, 0), 2);
  v_round numeric := round(coalesce(p_round_off, 0), 2); v_cash numeric := round(coalesce(p_paid_cash, 0), 2); v_online numeric := round(coalesce(p_paid_online, 0), 2);
  v_credit numeric; v_line uuid; v_batch uuid; v_qb numeric; v_fb numeric; v_cost_base numeric; v_inv_value numeric := 0; v_entries jsonb := '[]';
  r record; v_share numeric; v_today date;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(store_access(p_tenant, p_by, p_store), 'view') = 'view' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_active and is_receiving) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant and is_active) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_vendor_invoice_no), '') = '' then raise exception 'BILL_NO_REQUIRED' using errcode = 'P0001'; end if;
  v_today := stock_today(p_tenant);
  if p_vendor_invoice_date is null or p_vendor_invoice_date > v_today then raise exception 'BAD_BILL_DATE' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 then raise exception 'BAD_PAYMENT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_online_channel is null or p_online_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then
    raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;

  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'purchase_invoice', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from purchase_invoices where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'purchase', 'PUR') d;
  -- header first (totals filled after the lines); placeholder total satisfies the CHECKs
  insert into purchase_invoices (id, tenant_id, purchase_no, fiscal_year, vendor_id, vendor_invoice_no, vendor_invoice_date, received_store_id,
                                 total, credit_amount, note, posted_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_vendor, btrim(p_vendor_invoice_no), p_vendor_invoice_date, p_store, 0, 0, nullif(btrim(p_note), ''), p_by, v_post);

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and deleted_at is null;
    if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id;
    if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', n using errcode = 'P0001'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', n using errcode = 'P0001'; end if;
    if v_item.item_type = 'medicine' then
      if nullif(l->>'expiry_date', '') is null then raise exception 'EXPIRY_REQUIRED: line %', n using errcode = 'P0001'; end if;
      if (l->>'expiry_date')::date <= p_vendor_invoice_date then raise exception 'EXPIRED_ON_ARRIVAL: line %', n using errcode = 'P0001'; end if;
      if (l->>'expiry_date')::date < v_today + v_set.min_receive_shelf_days and coalesce(btrim(l->>'short_expiry_reason'), '') = '' then
        raise exception 'SHORT_SHELF_LIFE: line %', n using errcode = 'P0001';
      end if;
    end if;
    v_gross := round((l->>'qty')::numeric * coalesce((l->>'unit_cost')::numeric, 0), 2);
    v_disc := round(v_gross * coalesce((l->>'discount_pct')::numeric, 0) / 100, 2);
    v_net := v_gross - v_disc;
    v_tax := round(v_net * coalesce((l->>'tax_rate')::numeric, 0) / 100, 2);
    if nullif(l->>'mrp', '') is not null and coalesce(nullif(l->>'sale_price', '')::numeric, (l->>'mrp')::numeric) > (l->>'mrp')::numeric and not v_set.allow_price_above_mrp then
      raise exception 'PRICE_ABOVE_MRP: line %', n using errcode = 'P0001';
    end if;
    v_line := gen_random_uuid();
    v_qb := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
    v_fb := round(coalesce((l->>'free_qty')::numeric, 0) * v_unit.factor_to_base, 3);
    -- the lot is created now; its cost is finalised below once the bill discount is spread
    insert into item_batches (tenant_id, item_id, batch_no, mfg_date, expiry_date, source, vendor_id, unit_cost_base, mrp_base, sale_price_base)
    values (p_tenant, v_item.id, upper(btrim(coalesce(nullif(l->>'batch_no', ''), case when v_item.item_type = 'medicine' then null else 'NA' end))),
            nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date, 'purchase', p_vendor, 0,
            round(nullif(l->>'mrp', '')::numeric / v_unit.factor_to_base, 4),
            round(coalesce(nullif(l->>'sale_price', '')::numeric, nullif(l->>'mrp', '')::numeric, coalesce((l->>'unit_cost')::numeric, 0)) / v_unit.factor_to_base, 4))
    returning id into v_batch;
    insert into purchase_invoice_lines (id, tenant_id, purchase_id, line_no, item_id, unit_id, qty, free_qty, factor_snapshot, unit_cost, discount_pct, discount_amount,
                                        tax_rate, tax_amount, line_net, batch_no, mfg_date, expiry_date, mrp, sale_price, batch_id)
    values (v_line, p_tenant, v_id, n, v_item.id, v_unit.id, (l->>'qty')::numeric, coalesce((l->>'free_qty')::numeric, 0), v_unit.factor_to_base,
            coalesce((l->>'unit_cost')::numeric, 0), coalesce((l->>'discount_pct')::numeric, 0), v_disc, coalesce((l->>'tax_rate')::numeric, 0), v_tax, v_net,
            upper(btrim(coalesce(nullif(l->>'batch_no', ''), 'NA'))), nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date,
            nullif(l->>'mrp', '')::numeric, nullif(l->>'sale_price', '')::numeric, v_batch);
    update item_batches set purchase_invoice_line_id = v_line where id = v_batch;
    v_sub := v_sub + v_gross; v_ldisc := v_ldisc + v_disc; v_taxable := v_taxable + v_net; v_taxsum := v_taxsum + v_tax;
  end loop;

  if v_bill > v_taxable then raise exception 'BAD_DISCOUNT' using errcode = 'P0001'; end if;
  -- Bill discount reduces tax pro rata as well (tax was on the pre-bill-discount net).
  if v_bill > 0 and v_taxable > 0 then v_taxsum := round(v_taxsum * (v_taxable - v_bill) / v_taxable, 2); end if;
  v_total := v_taxable - v_bill + v_taxsum + v_round;
  if v_cash + v_online > v_total then raise exception 'OVERPAYMENT' using errcode = 'P0001'; end if;
  v_credit := v_total - v_cash - v_online;

  -- Lot cost = (line net − its share of the bill discount) ÷ (paid + free base qty): free goods dilute cost.
  for r in select * from purchase_invoice_lines where purchase_id = v_id order by line_no loop
    v_share := case when v_taxable > 0 then round(v_bill * r.line_net / v_taxable, 2) else 0 end;
    v_cost_base := round((r.line_net - v_share) / (r.base_qty + r.free_base_qty), 4);
    update item_batches set unit_cost_base = v_cost_base where id = r.batch_id;
    perform write_movement(p_tenant, p_store, r.batch_id, r.item_id, r.base_qty + r.free_base_qty, 'purchase', v_cost_base, v_post, 'purchase_invoice', v_id, r.id, null, p_by);
    v_inv_value := v_inv_value + (r.line_net - v_share);
  end loop;

  update purchase_invoices set subtotal = v_sub, line_discount_total = v_ldisc, bill_discount = v_bill, taxable_amount = v_taxable - v_bill,
         tax_amount = v_taxsum, round_off = v_round, total = v_total, paid_cash = v_cash, paid_online = v_online,
         online_channel = case when v_online > 0 then p_online_channel end, credit_amount = v_credit
   where id = v_id;

  v_entries := jsonb_build_array(jsonb_build_object('account', 'INVENTORY', 'debit', v_inv_value, 'store_id', p_store, 'vendor_id', p_vendor, 'memo', v_no));
  if v_taxsum > 0 then v_entries := v_entries || jsonb_build_object('account', 'TAX_RECEIVABLE', 'debit', v_taxsum, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_round > 0 then v_entries := v_entries || jsonb_build_object('account', 'ROUNDING', 'debit', v_round, 'memo', v_no); end if;
  if v_round < 0 then v_entries := v_entries || jsonb_build_object('account', 'ROUNDING', 'credit', -v_round, 'memo', v_no); end if;
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p_online_channel, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_credit > 0 then v_entries := v_entries || jsonb_build_object('account', 'AP_VENDORS', 'credit', v_credit, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_total > 0 then perform post_journal(p_tenant, v_post, v_entries); end if;

  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'purchase.post', 'purchase_invoice', v_id::text, 'success',
          jsonb_build_object('no', v_no, 'vendor', p_vendor, 'bill', btrim(p_vendor_invoice_no), 'total', v_total, 'credit', v_credit));
  return v_id;
exception when unique_violation then
  if sqlerrm like '%purchase_invoices_no_duplicate%' then raise exception 'DUPLICATE_BILL' using errcode = 'P0001'; end if;
  raise;
end $$;

-- Void a vendor bill entered by mistake: only while none of its lots has moved since receipt
-- and nothing was paid against it later. Reverses the journal and takes the stock back out.
create or replace function void_purchase_invoice(p_tenant uuid, p_idempotency_key uuid, p_invoice uuid, p_reason text, p_by uuid, p_session_level text,
                                                 p_reauth_at timestamptz, p_device uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare pi purchase_invoices; v_rev uuid; r record;
begin
  if p_session_level not in ('A2', 'A3') or p_reauth_at is null or p_reauth_at < now() - interval '5 minutes' then raise exception 'REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'manage_purchases') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into pi from purchase_invoices where id = p_invoice and tenant_id = p_tenant for update;
  if pi.id is null then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0001'; end if;
  if pi.status = 'void' then raise exception 'ALREADY_VOID' using errcode = 'P0001'; end if;
  if exists (select 1 from vendor_payment_allocations where purchase_invoice_id = p_invoice) then raise exception 'HAS_PAYMENTS' using errcode = 'P0001'; end if;
  if exists (select 1 from stock_movements m join purchase_invoice_lines l on l.batch_id = m.batch_id
              where l.purchase_id = p_invoice and not (m.doc_type = 'purchase_invoice' and m.doc_id = p_invoice)) then
    raise exception 'LOTS_ALREADY_USED' using errcode = 'P0001';
  end if;
  v_rev := reverse_posting(p_tenant, pi.posting_id, p_idempotency_key, p_by, p_session_level, p_device, 'void ' || pi.purchase_no || ': ' || btrim(p_reason));
  for r in select l.*, ib.unit_cost_base from purchase_invoice_lines l join item_batches ib on ib.id = l.batch_id where l.purchase_id = p_invoice loop
    perform write_movement(p_tenant, pi.received_store_id, r.batch_id, r.item_id, -(r.base_qty + r.free_base_qty), 'purchase_return', r.unit_cost_base,
                           v_rev, 'purchase_invoice', p_invoice, r.id, 'void', p_by);
  end loop;
  update purchase_invoices set status = 'void', void_reason = btrim(p_reason), voided_by = p_by, voided_at = now(), void_posting_id = v_rev where id = p_invoice;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
  values (p_tenant, 'member', p_by, p_session_level, 'purchase.void', 'purchase_invoice', p_invoice::text, 'success', btrim(p_reason));
end $$;

-- Pay a vendor (W-43): allocate to open bills (oldest first unless chosen), remainder = advance.
-- Dr AP_VENDORS (allocated) + Dr VENDOR_ADVANCES (unallocated) / Cr CASH, BANK.
-- p_allocations: [{ purchase_invoice_id, amount }] or null for FIFO.
create or replace function post_vendor_payment(p_tenant uuid, p_idempotency_key uuid, p_vendor uuid, p_cash numeric, p_online numeric, p_channel text,
                                               p_reference text, p_note text, p_allocations jsonb, p_by uuid, p_session_level text, p_device uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; v_fy text; v_no text; v_cash numeric := round(coalesce(p_cash, 0), 2);
        v_online numeric := round(coalesce(p_online, 0), 2); v_amount numeric; v_left numeric; v_alloc numeric := 0; r record; x jsonb; v_out numeric; v_take numeric;
        v_entries jsonb;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if not has_key(p_by, 'pay_vendors') then raise exception 'NO_PERMISSION' using errcode = 'P0001'; end if;
  if not exists (select 1 from vendors where id = p_vendor and tenant_id = p_tenant) then raise exception 'VENDOR_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_cash < 0 or v_online < 0 or v_cash + v_online <= 0 then raise exception 'BAD_AMOUNT' using errcode = 'P0001'; end if;
  if v_online > 0 and (p_channel is null or p_channel not in ('esewa', 'khalti', 'fonepay', 'bank_transfer', 'card', 'other')) then raise exception 'CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  v_amount := v_cash + v_online; v_left := v_amount;
  select b.posting_id, b.replayed into v_post, v_replayed from begin_posting(p_tenant, p_idempotency_key, 'vendor_payment', v_id, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from vendor_payments where posting_id = v_post); end if;
  select d.fiscal_year, d.doc_no into v_fy, v_no from doc_number(p_tenant, 'vendor_payment', 'VP') d;
  insert into vendor_payments (id, tenant_id, payment_no, fiscal_year, vendor_id, amount, cash_amount, online_amount, online_channel, reference, note, paid_by, posting_id)
  values (v_id, p_tenant, v_no, v_fy, p_vendor, v_amount, v_cash, v_online, case when v_online > 0 then p_channel end, nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''), p_by, v_post);

  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then
    for x in select * from jsonb_array_elements(p_allocations) loop
      select * into r from purchase_invoices where id = (x->>'purchase_invoice_id')::uuid and tenant_id = p_tenant and vendor_id = p_vendor and status = 'posted' for update;
      if r.id is null then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0001'; end if;
      v_take := round((x->>'amount')::numeric, 2);
      v_out := purchase_outstanding(r.id);
      if v_take <= 0 or v_take > v_out or v_take > v_left then raise exception 'ALLOCATION_TOO_LARGE' using errcode = 'P0001'; end if;
      insert into vendor_payment_allocations (tenant_id, vendor_payment_id, purchase_invoice_id, amount) values (p_tenant, v_id, r.id, v_take);
      v_left := v_left - v_take; v_alloc := v_alloc + v_take;
    end loop;
  else
    for r in select * from purchase_invoices where tenant_id = p_tenant and vendor_id = p_vendor and status = 'posted' and credit_amount > 0
              order by vendor_invoice_date, posted_at for update loop
      exit when v_left <= 0;
      v_out := purchase_outstanding(r.id);
      continue when v_out <= 0;
      v_take := least(v_out, v_left);
      insert into vendor_payment_allocations (tenant_id, vendor_payment_id, purchase_invoice_id, amount) values (p_tenant, v_id, r.id, v_take);
      v_left := v_left - v_take; v_alloc := v_alloc + v_take;
    end loop;
  end if;

  v_entries := '[]';
  if v_alloc > 0 then v_entries := v_entries || jsonb_build_object('account', 'AP_VENDORS', 'debit', v_alloc, 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_left > 0 then v_entries := v_entries || jsonb_build_object('account', 'VENDOR_ADVANCES', 'debit', v_left, 'vendor_id', p_vendor, 'memo', v_no || ' advance'); end if;
  if v_cash > 0 then v_entries := v_entries || jsonb_build_object('account', 'CASH', 'credit', v_cash, 'channel', 'cash', 'vendor_id', p_vendor, 'memo', v_no); end if;
  if v_online > 0 then v_entries := v_entries || jsonb_build_object('account', 'BANK', 'credit', v_online, 'channel', p_channel, 'vendor_id', p_vendor, 'memo', v_no); end if;
  perform post_journal(p_tenant, v_post, v_entries);
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'vendor.pay', 'vendor_payment', v_id::text, 'success', jsonb_build_object('no', v_no, 'amount', v_amount, 'allocated', v_alloc, 'advance', v_left));
  return v_id;
end $$;

-- A vendor's balance straight from the journal: owed (AP) and advances held.
create or replace function vendor_balances(p_tenant uuid)
returns table (vendor_id uuid, payable numeric, advance numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  select v.id,
         coalesce((select sum(credit - debit) from ledger_entries e where e.tenant_id = p_tenant and e.vendor_id = v.id and e.account_code = 'AP_VENDORS'), 0),
         coalesce((select sum(debit - credit) from ledger_entries e where e.tenant_id = p_tenant and e.vendor_id = v.id and e.account_code = 'VENDOR_ADVANCES'), 0)
    from vendors v where v.tenant_id = p_tenant;
$$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on vendors, purchase_invoices, purchase_invoice_lines, vendor_payments, vendor_payment_allocations to ledger_writer;
grant insert, update on purchase_invoices to ledger_writer;
grant insert on purchase_invoice_lines, vendor_payments, vendor_payment_allocations to ledger_writer;
grant update (unit_cost_base, purchase_invoice_line_id) on item_batches to ledger_writer;
grant execute on function purchase_outstanding(uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function post_vendor_opening(uuid, uuid, uuid, numeric, date, uuid, text, uuid) owner to ledger_writer;
alter function post_purchase_invoice(uuid, uuid, uuid, text, date, uuid, jsonb, numeric, numeric, numeric, numeric, text, text, uuid, text, uuid) owner to ledger_writer;
alter function void_purchase_invoice(uuid, uuid, uuid, text, uuid, text, timestamptz, uuid) owner to ledger_writer;
alter function post_vendor_payment(uuid, uuid, uuid, numeric, numeric, text, text, text, jsonb, uuid, text, uuid) owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function purchase_outstanding(uuid) from public, anon, authenticated;
grant execute on function purchase_outstanding(uuid) to service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'save_vendor(uuid, uuid, jsonb, uuid)', 'vendor_balances(uuid)',
    'post_vendor_opening(uuid, uuid, uuid, numeric, date, uuid, text, uuid)',
    'post_purchase_invoice(uuid, uuid, uuid, text, date, uuid, jsonb, numeric, numeric, numeric, numeric, text, text, uuid, text, uuid)',
    'void_purchase_invoice(uuid, uuid, uuid, text, uuid, text, timestamptz, uuid)',
    'post_vendor_payment(uuid, uuid, uuid, numeric, numeric, text, text, text, jsonb, uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
