-- =============================================================================
-- 0033 INVENTORY CORE (B5a): item master (categories, manufacturers, generics, medicine
-- details, units, barcodes, store levels), received lots (item_batches), the append-only
-- stock ledger (stock_movements) with a trigger-maintained, never-negative stock_balances,
-- opening stock posted to the journal, FEFO allocation, and store access.
-- database.md §8–§9; decisions D-38..D-46, D-58; P-24/P-25 defaults.
-- =============================================================================

-- ── master data ───────────────────────────────────────────────────────────────
create table item_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  parent_id   uuid,
  name        text not null check (length(btrim(name)) between 2 and 60),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references item_categories (tenant_id, id)
);
create unique index item_categories_name on item_categories (tenant_id, lower(btrim(name)));

create table manufacturers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  name        text not null check (length(btrim(name)) between 2 and 80),
  country     text,
  unique (tenant_id, id)
);
create unique index manufacturers_name on manufacturers (tenant_id, lower(btrim(name)));

create table generics (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  name        text not null check (length(btrim(name)) between 2 and 120),
  atc_code    text check (atc_code ~ '^[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$'),
  unique (tenant_id, id)
);
create unique index generics_name on generics (tenant_id, lower(btrim(name)));

create table item_code_counters (
  tenant_id  uuid primary key references tenants (id) on delete restrict,
  next_no    bigint not null default 1
);

create table inventory_items (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references tenants (id) on delete restrict,
  item_code                  text not null,
  item_type                  text not null check (item_type in ('medicine', 'consumable', 'surgical', 'lab_reagent', 'other')),
  name                       text not null check (length(btrim(name)) between 2 and 120),
  category_id                uuid,
  manufacturer_id            uuid,
  default_purchase_unit_id   uuid,
  default_sale_unit_id       uuid,
  sku                        text check (length(sku) <= 40),
  tax_category               text not null default 'exempt' check (tax_category in ('exempt', 'vat13')),
  min_stock_level            numeric(14,3) check (min_stock_level >= 0),
  reorder_level              numeric(14,3) check (reorder_level >= 0),
  reorder_qty                numeric(14,3) check (reorder_qty > 0),
  max_stock_level            numeric(14,3) check (max_stock_level > 0),
  allow_loose_sale           boolean not null default true,
  storage_condition          text not null default 'room' check (storage_condition in ('room', 'cool_2_8', 'frozen', 'protect_light')),
  is_returnable_to_vendor    boolean not null default true,
  is_active                  boolean not null default true,
  notes                      text check (length(notes) <= 1000),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, item_code),
  foreign key (tenant_id, category_id) references item_categories (tenant_id, id),
  foreign key (tenant_id, manufacturer_id) references manufacturers (tenant_id, id),
  check (min_stock_level is null or reorder_level is null or min_stock_level <= reorder_level),
  check (reorder_level is null or max_stock_level is null or reorder_level <= max_stock_level)
);
create unique index inventory_items_sku on inventory_items (tenant_id, lower(sku)) where sku is not null;
create index inventory_items_name on inventory_items (tenant_id, lower(name));
create trigger inventory_items_touch before update on inventory_items for each row execute function touch_updated_at();
comment on table inventory_items is 'Item master (D-40). All stock levels are in BASE units (the smallest unit ever sold or dispensed).';

create table medicine_details (
  item_id                uuid primary key,
  tenant_id              uuid not null,
  generic_id             uuid,
  strength_value         numeric(12,4) check (strength_value > 0),
  strength_unit          text check (strength_unit in ('mg', 'g', 'mcg', 'ml', 'IU', '%', 'mg/ml', 'mg/5ml', 'mcg/ml', 'units')),
  strength_text          text check (length(strength_text) <= 60),
  dosage_form            text not null check (dosage_form in ('tablet', 'capsule', 'syrup', 'suspension', 'injection', 'infusion', 'ointment', 'cream',
                                                               'gel', 'drops', 'inhaler', 'powder', 'sachet', 'suppository', 'lotion', 'other')),
  route                  text check (route in ('oral', 'IV', 'IM', 'SC', 'topical', 'ophthalmic', 'otic', 'nasal', 'inhalation', 'rectal', 'vaginal')),
  schedule_class         text not null default 'prescription_only' check (schedule_class in ('otc', 'prescription_only', 'controlled', 'narcotic')),
  requires_prescription  boolean not null default true,
  dda_registration_no    text check (length(dda_registration_no) <= 40),
  pack_description       text check (length(pack_description) <= 60),
  is_combination         boolean not null default false,
  unique (tenant_id, item_id),
  foreign key (tenant_id, item_id) references inventory_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, generic_id) references generics (tenant_id, id),
  check (schedule_class = 'otc' or requires_prescription)
);

create table item_units (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  item_id         uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 20),
  factor_to_base  numeric(14,4) not null check (factor_to_base > 0),
  is_base         boolean not null default false,
  can_purchase    boolean not null default true,
  can_sell        boolean not null default true,
  sort            smallint not null default 0,
  unique (tenant_id, id),
  unique (tenant_id, item_id, id),
  foreign key (tenant_id, item_id) references inventory_items (tenant_id, id) on delete cascade,
  check (not is_base or factor_to_base = 1)
);
create unique index item_units_one_base on item_units (item_id) where is_base;
create unique index item_units_name on item_units (item_id, lower(btrim(name)));

alter table inventory_items
  add constraint inventory_items_purchase_unit foreign key (tenant_id, id, default_purchase_unit_id)
      references item_units (tenant_id, item_id, id) deferrable initially deferred,
  add constraint inventory_items_sale_unit foreign key (tenant_id, id, default_sale_unit_id)
      references item_units (tenant_id, item_id, id) deferrable initially deferred;

create table item_barcodes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  item_id    uuid not null,
  unit_id    uuid not null,
  barcode    text not null check (barcode ~ '^[0-9A-Za-z-]{4,40}$'),
  unique (tenant_id, id),
  unique (tenant_id, barcode),
  foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id) on delete cascade
);

create table store_item_levels (
  tenant_id        uuid not null,
  store_id         uuid not null,
  item_id          uuid not null,
  min_stock_level  numeric(14,3) check (min_stock_level >= 0),
  reorder_level    numeric(14,3) check (reorder_level >= 0),
  max_stock_level  numeric(14,3) check (max_stock_level > 0),
  primary key (store_id, item_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, item_id) references inventory_items (tenant_id, id) on delete cascade
);

-- ── lots ──────────────────────────────────────────────────────────────────────
create table item_batches (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  item_id                   uuid not null,
  batch_no                  text not null check (batch_no ~ '^[A-Z0-9/._-]{1,30}$'),
  mfg_date                  date,
  expiry_date               date,
  source                    text not null check (source in ('purchase', 'opening', 'found')),
  purchase_invoice_line_id  uuid,        -- FK added with purchasing (B6)
  vendor_id                 uuid,        -- FK added with purchasing (B6)
  unit_cost_base            numeric(14,4) not null check (unit_cost_base >= 0),
  mrp_base                  numeric(14,4) check (mrp_base >= 0),
  sale_price_base           numeric(14,4) not null check (sale_price_base >= 0),
  status                    text not null default 'active' check (status in ('active', 'blocked', 'recalled')),
  block_reason              text,
  blocked_by                uuid,
  blocked_at                timestamptz,
  created_at                timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, id, item_id),
  foreign key (tenant_id, item_id) references inventory_items (tenant_id, id),
  foreign key (tenant_id, blocked_by) references tenant_members (tenant_id, id),
  check (mfg_date is null or expiry_date is null or expiry_date > mfg_date),
  check ((status = 'active') = (blocked_at is null))
);
create index item_batches_item on item_batches (tenant_id, item_id, expiry_date);
comment on table item_batches is 'One row per RECEIVED lot (D-41): exact cost per unit, never overwritten by a later purchase. Expired = expiry_date <= today (derived).';

create table batch_price_history (
  id          bigserial primary key,
  tenant_id   uuid not null,
  batch_id    uuid not null,
  old_price   numeric(14,4) not null,
  new_price   numeric(14,4) not null,
  reason      text,
  changed_by  uuid not null,
  changed_at  timestamptz not null default now(),
  foreign key (tenant_id, batch_id) references item_batches (tenant_id, id),
  foreign key (tenant_id, changed_by) references tenant_members (tenant_id, id)
);

-- Medicines need an expiry; batch numbers are normalised.
create or replace function item_batches_check()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.batch_no := upper(btrim(new.batch_no));
  if new.expiry_date is null and exists (select 1 from inventory_items where id = new.item_id and item_type = 'medicine') then
    raise exception 'EXPIRY_REQUIRED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger item_batches_check before insert or update of batch_no, expiry_date on item_batches for each row execute function item_batches_check();

-- A unit's factor can't change once the item has stock lots (lines were posted with it).
create or replace function item_units_factor_locked()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.factor_to_base is distinct from old.factor_to_base or new.is_base is distinct from old.is_base)
     and exists (select 1 from item_batches where item_id = old.item_id) then
    raise exception 'UNIT_IN_USE' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger item_units_factor_locked before update on item_units for each row execute function item_units_factor_locked();

-- ── stock ledger (D-38, D-39) ─────────────────────────────────────────────────
create table stock_movements (
  id              bigserial primary key,
  tenant_id       uuid not null,
  store_id        uuid not null,
  batch_id        uuid not null,
  item_id         uuid not null,
  qty_base        numeric(14,3) not null check (qty_base <> 0),
  kind            text not null check (kind in ('opening', 'purchase', 'purchase_return', 'sale', 'sale_return', 'transfer_out', 'transfer_in',
                                                 'adjustment_in', 'adjustment_out', 'count_variance', 'disposal')),
  unit_cost_base  numeric(14,4) not null check (unit_cost_base >= 0),
  posting_id      uuid not null,
  doc_type        text not null,
  doc_id          uuid,
  doc_line_id     uuid,
  reason_code     text,
  note            text,
  created_by      uuid,
  occurred_at     timestamptz not null default now(),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  foreign key (tenant_id, created_by) references tenant_members (tenant_id, id),
  check (case when kind in ('opening', 'purchase', 'sale_return', 'transfer_in', 'adjustment_in') then qty_base > 0
              when kind in ('purchase_return', 'sale', 'transfer_out', 'adjustment_out', 'disposal') then qty_base < 0
              else true end)
);
create index stock_movements_balance on stock_movements (tenant_id, store_id, batch_id, occurred_at);
create index stock_movements_item on stock_movements (tenant_id, item_id, occurred_at);
create trigger stock_movements_no_update before update or delete on stock_movements for each row execute function forbid_change();
create trigger stock_movements_no_truncate before truncate on stock_movements for each statement execute function forbid_mutation();
comment on table stock_movements is 'THE source of truth for quantities (D-39). Append-only; written only by ledger_writer posting functions.';

create table stock_balances (
  tenant_id     uuid not null,
  store_id      uuid not null,
  batch_id      uuid not null,
  item_id       uuid not null,
  qty_on_hand   numeric(14,3) not null default 0 check (qty_on_hand >= 0),
  qty_reserved  numeric(14,3) not null default 0 check (qty_reserved >= 0 and qty_reserved <= qty_on_hand),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, store_id, batch_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);
create index stock_balances_item on stock_balances (tenant_id, item_id, store_id);
comment on table stock_balances is 'Cache of Σ stock_movements per (store, lot), maintained ONLY by trigger. CHECK >= 0 makes negative stock impossible (D-38).';

create or replace function apply_stock_movement()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into stock_balances as b (tenant_id, store_id, batch_id, item_id, qty_on_hand)
  values (new.tenant_id, new.store_id, new.batch_id, new.item_id, new.qty_base)
  on conflict (tenant_id, store_id, batch_id)
  do update set qty_on_hand = b.qty_on_hand + excluded.qty_on_hand, updated_at = now();
  return new;
end $$;
create trigger stock_movements_apply after insert on stock_movements for each row execute function apply_stock_movement();

-- ── opening stock document ────────────────────────────────────────────────────
create table stock_openings (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete restrict,
  store_id    uuid not null,
  posting_id  uuid not null,
  note        text,
  posted_by   uuid not null,
  posted_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id),
  foreign key (tenant_id, posting_id) references postings (tenant_id, id),
  foreign key (tenant_id, posted_by) references tenant_members (tenant_id, id)
);
create table stock_opening_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  opening_id       uuid not null,
  line_no          smallint not null,
  item_id          uuid not null,
  unit_id          uuid not null,
  qty              numeric(14,3) not null check (qty > 0),
  factor_snapshot  numeric(14,4) not null check (factor_snapshot > 0),
  base_qty         numeric(14,3) generated always as (round(qty * factor_snapshot, 3)) stored,
  batch_id         uuid not null,
  unit_cost        numeric(14,4) not null check (unit_cost >= 0),
  unique (tenant_id, id),
  unique (opening_id, line_no),
  foreign key (tenant_id, opening_id) references stock_openings (tenant_id, id),
  foreign key (tenant_id, item_id, unit_id) references item_units (tenant_id, item_id, id),
  foreign key (tenant_id, batch_id, item_id) references item_batches (tenant_id, id, item_id)
);

-- ── access ────────────────────────────────────────────────────────────────────
alter table item_categories      enable row level security;
alter table manufacturers        enable row level security;
alter table generics             enable row level security;
alter table item_code_counters   enable row level security;
alter table inventory_items      enable row level security;
alter table medicine_details     enable row level security;
alter table item_units           enable row level security;
alter table item_barcodes        enable row level security;
alter table store_item_levels    enable row level security;
alter table item_batches         enable row level security;
alter table batch_price_history  enable row level security;
alter table stock_movements      enable row level security;
alter table stock_balances       enable row level security;
alter table stock_openings       enable row level security;
alter table stock_opening_lines  enable row level security;
-- Master data is edited through save_item (atomic, audited); lots, the ledger, balances and
-- stock documents only through ledger_writer posting functions. The app reads.
revoke insert, update, delete on item_categories, manufacturers, generics, inventory_items, medicine_details, item_units, item_barcodes,
                                 item_batches, batch_price_history, stock_movements, stock_balances, stock_openings, stock_opening_lines from service_role;
revoke all on item_code_counters from service_role;
revoke usage on sequence stock_movements_id_seq, batch_price_history_id_seq from service_role;
grant insert, update, delete on store_item_levels to service_role;

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Who may work in a store (permissions.md §5a): tenant admins and all_stores see every store;
-- everyone else by assignment.
create or replace function store_access(p_tenant uuid, p_member uuid, p_store uuid)
returns text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select case
    when not exists (select 1 from stores where id = p_store and tenant_id = p_tenant) then null
    when exists (select 1 from tenant_members where id = p_member and tenant_id = p_tenant and is_active and membership_role = 'tenant_admin') then 'manage'
    when 'all_stores' = any (effective_permissions(p_member)) then 'manage'
    else (select access from store_members where store_id = p_store and member_id = p_member and tenant_id = p_tenant)
  end;
$$;

-- Create or update an item with its medicine details, units and barcodes in ONE step.
-- p_d: { item_type, name, generic, strength_value, strength_unit, strength_text, dosage_form, route,
--        schedule_class, dda_registration_no, pack_description, category, manufacturer, sku, tax_category,
--        min_stock_level, reorder_level, reorder_qty, max_stock_level, allow_loose_sale, storage_condition,
--        is_returnable_to_vendor, is_active, notes, default_purchase_unit, default_sale_unit,
--        units: [{ id?, name, factor, is_base, can_purchase, can_sell }], barcodes: [{ barcode, unit }] }
create or replace function save_item(p_tenant uuid, p_item uuid, p_d jsonb, p_by uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := p_item; v_no bigint; v_type text := p_d->>'item_type'; v_cat uuid; v_man uuid; v_gen uuid; v_has_lots boolean := false;
  u jsonb; v_uid uuid; v_keep uuid[] := '{}'; v_old inventory_items; v_n numeric;
  num_or_null text;
begin
  perform assert_active_member(p_tenant, p_by);
  if coalesce(length(btrim(p_d->>'name')), 0) < 2 then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_d->'units') <> 'array' or (select count(*) from jsonb_array_elements(p_d->'units') x where coalesce((x->>'is_base')::boolean, false)) <> 1 then
    raise exception 'ONE_BASE_UNIT' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_d->'units') x where coalesce((x->>'is_base')::boolean, false) and (x->>'factor')::numeric <> 1) then
    raise exception 'BASE_FACTOR_ONE' using errcode = 'P0001';
  end if;

  if nullif(btrim(p_d->>'category'), '') is not null then
    insert into item_categories (tenant_id, name) values (p_tenant, btrim(p_d->>'category')) on conflict do nothing;
    select id into v_cat from item_categories where tenant_id = p_tenant and lower(btrim(name)) = lower(btrim(p_d->>'category'));
  end if;
  if nullif(btrim(p_d->>'manufacturer'), '') is not null then
    insert into manufacturers (tenant_id, name) values (p_tenant, btrim(p_d->>'manufacturer')) on conflict do nothing;
    select id into v_man from manufacturers where tenant_id = p_tenant and lower(btrim(name)) = lower(btrim(p_d->>'manufacturer'));
  end if;

  if v_id is null then
    insert into item_code_counters as c (tenant_id, next_no) values (p_tenant, 2)
    on conflict (tenant_id) do update set next_no = c.next_no + 1 returning next_no - 1 into v_no;
    insert into inventory_items (tenant_id, item_code, item_type, name) values (p_tenant, 'ITM-' || lpad(v_no::text, 5, '0'), v_type, btrim(p_d->>'name'))
    returning id into v_id;
  else
    select * into v_old from inventory_items where id = v_id and tenant_id = p_tenant for update;
    if v_old.id is null then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
    v_has_lots := exists (select 1 from item_batches where item_id = v_id);
    if v_has_lots and v_old.item_type <> v_type then raise exception 'TYPE_LOCKED' using errcode = 'P0001'; end if;
  end if;

  update inventory_items set
    item_type = v_type, name = btrim(p_d->>'name'), category_id = v_cat, manufacturer_id = v_man,
    sku = nullif(btrim(p_d->>'sku'), ''), tax_category = coalesce(nullif(p_d->>'tax_category', ''), 'exempt'),
    min_stock_level = nullif(p_d->>'min_stock_level', '')::numeric, reorder_level = nullif(p_d->>'reorder_level', '')::numeric,
    reorder_qty = nullif(p_d->>'reorder_qty', '')::numeric, max_stock_level = nullif(p_d->>'max_stock_level', '')::numeric,
    allow_loose_sale = coalesce((p_d->>'allow_loose_sale')::boolean, true),
    storage_condition = coalesce(nullif(p_d->>'storage_condition', ''), 'room'),
    is_returnable_to_vendor = coalesce((p_d->>'is_returnable_to_vendor')::boolean, true),
    is_active = coalesce((p_d->>'is_active')::boolean, true), notes = nullif(btrim(p_d->>'notes'), ''),
    default_purchase_unit_id = null, default_sale_unit_id = null
  where id = v_id;

  -- medicine details
  if v_type = 'medicine' then
    if nullif(btrim(p_d->>'generic'), '') is not null then
      insert into generics (tenant_id, name) values (p_tenant, btrim(p_d->>'generic')) on conflict do nothing;
      select id into v_gen from generics where tenant_id = p_tenant and lower(btrim(name)) = lower(btrim(p_d->>'generic'));
    end if;
    insert into medicine_details (item_id, tenant_id, generic_id, strength_value, strength_unit, strength_text, dosage_form, route,
                                  schedule_class, requires_prescription, dda_registration_no, pack_description, is_combination)
    values (v_id, p_tenant, v_gen, nullif(p_d->>'strength_value', '')::numeric, nullif(p_d->>'strength_unit', ''), nullif(btrim(p_d->>'strength_text'), ''),
            coalesce(nullif(p_d->>'dosage_form', ''), 'tablet'), nullif(p_d->>'route', ''),
            coalesce(nullif(p_d->>'schedule_class', ''), 'prescription_only'), coalesce(nullif(p_d->>'schedule_class', ''), 'prescription_only') <> 'otc',
            nullif(btrim(p_d->>'dda_registration_no'), ''), nullif(btrim(p_d->>'pack_description'), ''),
            coalesce((p_d->>'strength_text') like '%+%', false))
    on conflict (item_id) do update set generic_id = excluded.generic_id, strength_value = excluded.strength_value, strength_unit = excluded.strength_unit,
      strength_text = excluded.strength_text, dosage_form = excluded.dosage_form, route = excluded.route, schedule_class = excluded.schedule_class,
      requires_prescription = excluded.requires_prescription, dda_registration_no = excluded.dda_registration_no,
      pack_description = excluded.pack_description, is_combination = excluded.is_combination;
  else
    delete from medicine_details where item_id = v_id;
  end if;

  -- units: update listed ones (by id), add new ones, remove the rest (never the base once lots exist)
  delete from item_barcodes where item_id = v_id;
  for u in select * from jsonb_array_elements(p_d->'units') loop
    if coalesce(length(btrim(u->>'name')), 0) < 1 then raise exception 'UNIT_NAME_REQUIRED' using errcode = 'P0001'; end if;
    if nullif(u->>'id', '') is not null then
      update item_units set name = btrim(u->>'name'), factor_to_base = (u->>'factor')::numeric, is_base = coalesce((u->>'is_base')::boolean, false),
             can_purchase = coalesce((u->>'can_purchase')::boolean, true), can_sell = coalesce((u->>'can_sell')::boolean, true)
       where id = (u->>'id')::uuid and item_id = v_id
      returning id into v_uid;
      if v_uid is null then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0001'; end if;
    else
      insert into item_units (tenant_id, item_id, name, factor_to_base, is_base, can_purchase, can_sell)
      values (p_tenant, v_id, btrim(u->>'name'), (u->>'factor')::numeric, coalesce((u->>'is_base')::boolean, false),
              coalesce((u->>'can_purchase')::boolean, true), coalesce((u->>'can_sell')::boolean, true))
      returning id into v_uid;
    end if;
    v_keep := v_keep || v_uid;
  end loop;
  if v_has_lots and exists (select 1 from item_units where item_id = v_id and not (id = any (v_keep))
                             and exists (select 1 from stock_opening_lines l where l.unit_id = item_units.id)) then
    raise exception 'UNIT_IN_USE' using errcode = 'P0001';
  end if;
  delete from item_units where item_id = v_id and not (id = any (v_keep));

  insert into item_barcodes (tenant_id, item_id, unit_id, barcode)
  select p_tenant, v_id, iu.id, btrim(b->>'barcode')
    from jsonb_array_elements(coalesce(p_d->'barcodes', '[]')) b
    join item_units iu on iu.item_id = v_id and lower(iu.name) = lower(btrim(b->>'unit'))
   where coalesce(btrim(b->>'barcode'), '') <> '';

  update inventory_items set
    default_purchase_unit_id = (select id from item_units where item_id = v_id and lower(name) = lower(btrim(coalesce(p_d->>'default_purchase_unit', ''))) limit 1),
    default_sale_unit_id = (select id from item_units where item_id = v_id and lower(name) = lower(btrim(coalesce(p_d->>'default_sale_unit', ''))) limit 1)
   where id = v_id;

  insert into audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, case when p_item is null then 'item.create' else 'item.update' end, 'inventory_item', v_id::text, 'success',
          jsonb_build_object('name', btrim(p_d->>'name')));
  return v_id;
exception when unique_violation then
  if sqlerrm like '%item_barcodes%' then raise exception 'BARCODE_TAKEN' using errcode = 'P0001'; end if;
  if sqlerrm like '%inventory_items_sku%' then raise exception 'SKU_TAKEN' using errcode = 'P0001'; end if;
  if sqlerrm like '%item_units_name%' then raise exception 'DUPLICATE_UNIT' using errcode = 'P0001'; end if;
  raise;
end $$;

-- Opening stock (W-40): the lots on the shelf on day one. Each line creates a lot, writes an
-- 'opening' movement and, together, one journal entry Dr INVENTORY / Cr OPENING_EQUITY.
-- p_lines: [{ item_id, unit_id, qty, batch_no, expiry_date, mfg_date, unit_cost, mrp, sale_price, override_reason }]
create or replace function post_opening_stock(
  p_tenant uuid, p_idempotency_key uuid, p_store uuid, p_lines jsonb, p_note text,
  p_by uuid, p_session_level text, p_device uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_open uuid := gen_random_uuid(); v_post uuid; v_replayed boolean; l jsonb; v_n integer := 0; v_unit item_units; v_item inventory_items;
  v_batch uuid; v_cost_base numeric; v_mrp_base numeric; v_sale_base numeric; v_qty_base numeric; v_total numeric := 0; v_set tenant_settings;
  v_bno text; v_existing date; v_line uuid;
begin
  if p_session_level not in ('A2', 'A3') then raise exception 'PASSWORD_REQUIRED' using errcode = 'P0001'; end if;
  perform assert_active_member(p_tenant, p_by);
  if coalesce(store_access(p_tenant, p_by, p_store), '') <> 'manage' then raise exception 'NO_STORE_ACCESS' using errcode = 'P0001'; end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and is_active and is_receiving) then raise exception 'STORE_NOT_RECEIVING' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES' using errcode = 'P0001'; end if;
  select * into v_set from tenant_settings where tenant_id = p_tenant;

  select b.posting_id, b.replayed into v_post, v_replayed
    from begin_posting(p_tenant, p_idempotency_key, 'opening_stock', v_open, p_by, p_session_level, p_device) b;
  if v_replayed then return (select id from stock_openings where posting_id = v_post); end if;
  insert into stock_openings (id, tenant_id, store_id, posting_id, note, posted_by) values (v_open, p_tenant, p_store, v_post, nullif(btrim(p_note), ''), p_by);

  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select * into v_item from inventory_items where id = (l->>'item_id')::uuid and tenant_id = p_tenant and deleted_at is null;
    if v_item.id is null then raise exception 'ITEM_NOT_FOUND: line %', v_n using errcode = 'P0001'; end if;
    select * into v_unit from item_units where id = (l->>'unit_id')::uuid and item_id = v_item.id;
    if v_unit.id is null then raise exception 'UNIT_NOT_FOUND: line %', v_n using errcode = 'P0001'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'BAD_QTY: line %', v_n using errcode = 'P0001'; end if;
    v_qty_base := round((l->>'qty')::numeric * v_unit.factor_to_base, 3);
    v_cost_base := round(coalesce((l->>'unit_cost')::numeric, 0) / v_unit.factor_to_base, 4);
    v_mrp_base := round(nullif(l->>'mrp', '')::numeric / v_unit.factor_to_base, 4);
    v_sale_base := round(coalesce(nullif(l->>'sale_price', '')::numeric, nullif(l->>'mrp', '')::numeric, coalesce((l->>'unit_cost')::numeric, 0)) / v_unit.factor_to_base, 4);
    if v_mrp_base is not null and v_sale_base > v_mrp_base and not v_set.allow_price_above_mrp then
      raise exception 'PRICE_ABOVE_MRP: line %', v_n using errcode = 'P0001';
    end if;
    v_bno := upper(btrim(coalesce(nullif(l->>'batch_no', ''), case when v_item.item_type = 'medicine' then null else 'NA' end)));
    if v_bno is null then raise exception 'BATCH_REQUIRED: line %', v_n using errcode = 'P0001'; end if;
    -- Typo guard: the same printed batch with a different expiry needs a reason.
    select expiry_date into v_existing from item_batches where item_id = v_item.id and batch_no = v_bno and expiry_date is distinct from nullif(l->>'expiry_date', '')::date limit 1;
    if found and coalesce(btrim(l->>'override_reason'), '') = '' then raise exception 'BATCH_EXPIRY_MISMATCH: line %', v_n using errcode = 'P0001'; end if;

    insert into item_batches (tenant_id, item_id, batch_no, mfg_date, expiry_date, source, unit_cost_base, mrp_base, sale_price_base)
    values (p_tenant, v_item.id, v_bno, nullif(l->>'mfg_date', '')::date, nullif(l->>'expiry_date', '')::date, 'opening', v_cost_base, v_mrp_base, v_sale_base)
    returning id into v_batch;
    v_line := gen_random_uuid();
    insert into stock_opening_lines (id, tenant_id, opening_id, line_no, item_id, unit_id, qty, factor_snapshot, batch_id, unit_cost)
    values (v_line, p_tenant, v_open, v_n, v_item.id, v_unit.id, (l->>'qty')::numeric, v_unit.factor_to_base, v_batch, coalesce((l->>'unit_cost')::numeric, 0));
    insert into stock_movements (tenant_id, store_id, batch_id, item_id, qty_base, kind, unit_cost_base, posting_id, doc_type, doc_id, doc_line_id, created_by, reason_code)
    values (p_tenant, p_store, v_batch, v_item.id, v_qty_base, 'opening', v_cost_base, v_post, 'opening_stock', v_open, v_line, p_by,
            case when coalesce(btrim(l->>'override_reason'), '') <> '' then 'expiry_override' end);
    v_total := v_total + round(v_qty_base * v_cost_base, 2);
  end loop;

  if v_total > 0 then
    perform post_journal(p_tenant, v_post, jsonb_build_array(
      jsonb_build_object('account', 'INVENTORY', 'debit', v_total, 'store_id', p_store, 'memo', 'Opening stock'),
      jsonb_build_object('account', 'OPENING_EQUITY', 'credit', v_total, 'memo', 'Opening stock')));
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_by, p_session_level, 'stock.opening', 'stock_opening', v_open::text, 'success',
          jsonb_build_object('store', p_store, 'lines', v_n, 'value', v_total));
  return v_open;
end $$;

-- FEFO allocation (D-42): which lots a sale/dispense/transfer takes, earliest expiry first,
-- never expired, blocked or recalled lots, never below the shelf-life margin. Locks the
-- balance rows it returns. Called only inside ledger_writer posting functions (B5b, B7).
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

-- What's on the shelf, per lot, with the flags the screens and alerts need.
create or replace function stock_by_batch(p_tenant uuid, p_store uuid default null)
returns table (store_id uuid, item_id uuid, batch_id uuid, batch_no text, expiry_date date, status text, qty_on_hand numeric,
               unit_cost_base numeric, mrp_base numeric, sale_price_base numeric, expired boolean, near_expiry boolean, critical_expiry boolean)
language sql stable
set search_path = pg_catalog, public
as $$
  select b.store_id, b.item_id, b.batch_id, ib.batch_no, ib.expiry_date, ib.status, b.qty_on_hand, ib.unit_cost_base, ib.mrp_base, ib.sale_price_base,
         ib.expiry_date is not null and ib.expiry_date <= today.d,
         ib.expiry_date is not null and ib.expiry_date > today.d and ib.expiry_date <= today.d + s.near_expiry_days,
         ib.expiry_date is not null and ib.expiry_date > today.d and ib.expiry_date <= today.d + s.critical_expiry_days
    from stock_balances b
    join item_batches ib on ib.id = b.batch_id
    join tenant_settings s on s.tenant_id = b.tenant_id
    cross join lateral (select (now() at time zone timezone)::date d from tenants where id = p_tenant) today
   where b.tenant_id = p_tenant and (p_store is null or b.store_id = p_store) and b.qty_on_hand > 0;
$$;

-- ── ownership and privileges ──────────────────────────────────────────────────
grant select on inventory_items, item_units, item_batches, stores, store_members, tenant_settings, tenants to ledger_writer;
grant insert on item_batches, stock_movements, stock_openings, stock_opening_lines to ledger_writer;
grant usage, select on sequence stock_movements_id_seq to ledger_writer;
grant select, insert, update on stock_balances to ledger_writer;
grant execute on function store_access(uuid, uuid, uuid) to ledger_writer;
grant execute on function effective_permissions(uuid) to ledger_writer;
grant create on schema public to ledger_writer;
alter function post_opening_stock(uuid, uuid, uuid, jsonb, text, uuid, text, uuid) owner to ledger_writer;
alter function allocate_stock(uuid, uuid, uuid, numeric, text) owner to ledger_writer;
alter function apply_stock_movement() owner to ledger_writer;
revoke create on schema public from ledger_writer;

revoke all on function item_batches_check() from public, anon, authenticated, service_role;
revoke all on function item_units_factor_locked() from public, anon, authenticated, service_role;
revoke all on function apply_stock_movement() from public, anon, authenticated, service_role;
revoke all on function allocate_stock(uuid, uuid, uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function store_access(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function save_item(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function post_opening_stock(uuid, uuid, uuid, jsonb, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function stock_by_batch(uuid, uuid) from public, anon, authenticated;
grant execute on function store_access(uuid, uuid, uuid) to service_role;
grant execute on function save_item(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function post_opening_stock(uuid, uuid, uuid, jsonb, text, uuid, text, uuid) to service_role;
grant execute on function stock_by_batch(uuid, uuid) to service_role;
