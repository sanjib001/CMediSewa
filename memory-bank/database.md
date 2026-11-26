# Database (proposed)

Status: **Recommendation. Not final** (Revision 4 audit: visits/token_counters completed,
billing_profiles, tenant_modules, reversal rule, relationship index in §16. Revision 2: `clinics`/`clinic_id` renamed to
`tenants`/`tenant_id`; identity, roles and website added. **Revision 3:** full inventory,
pharmacy, purchasing, sales and finance design in §8–§12). Exact DDL is written in milestone migrations (Phase 0, B0 onward) after the workflows are
reviewed. Open items are marked **[OPEN]**.

## 1. Principles
1. **Postgres on self-hosted Supabase. Shared schema. `tenant_id` on every tenant-owned row**
   (D-03, D-26).
2. **Composite tenant keys.** Every tenant table has `unique (tenant_id, id)`, and every
   reference to it is `foreign key (tenant_id, x_id) references x (tenant_id, id)`.
3. **Access posture in migration 0001** (D-18): RLS on every table, no grants to
   `anon`/`authenticated` (including default privileges for both grantor roles), explicit
   `service_role` grants. A CI check fails on any table with RLS disabled or any grant to
   those roles.
4. **Clinical tables are reached only through RPCs** that check the care relationship in SQL
   and write `audit_log` in the same transaction (D-04, D-23).
5. **No hard deletes of clinical, financial or stock rows.** Use soft delete for
   demographics and catalogue entries, immutability after finalize/issue (D-12), voids for
   invoices, and reversing movements for stock.
6. **Derived over stored** (HRestroSewa rule): payables, receivables, availability,
   subscription state and invoice outstanding are all computed. Two **controlled
   exceptions**, both written only inside the posting transaction and reconciled nightly
   against their source: `stock_balances` (from `stock_movements`, D-38) and
   `ledger_entries` (from posted documents, D-43).
7. UUID PKs (bigserial for high-volume append-only ledgers), `timestamptz` UTC, `created_by`
   member references, `comment on` for *why*.
8. **Money** is `numeric(12,2)` NPR. **Per-base-unit cost/price** is `numeric(14,4)`.
   **Quantities** are `numeric(14,3)` in the item's **base unit**. Prices and costs are
   snapshotted on every document line.
9. RPCs raise bare error codes, which actions map to friendly text.
10. **Every stock or money change is a posting** (D-44): one RPC, one transaction, one
    `postings` row with an idempotency key, the document, its stock movements and its
    journal entries, or nothing at all.

## 2. Entity map
```
PLATFORM   platform_admins   plans ──< tenant_subscriptions >── tenants ──< platform_invoices ──< platform_payments
           tenant_applications ──(approve)──► tenants          platform_settings   support_tickets (P2)

IDENTITY   auth.users ──< tenant_members >── tenants
                              ├──< member_roles >── tenant_roles
                              ├──< member_permission_overrides
                              ├──< member_credentials
                              ├── member_pins (1:1)      pin_attempts
                              └── session_assurance (by JWT session_id)   trusted_devices (per tenant)

TENANT     tenant_settings (1:1)   site_settings (1:1) ──< site_announcements, site_media, site_faqs
           tenant_modules   billing_profiles ──< invoices, stores (opt), services (opt), document_sequences
SETUP      departments ──< services        doctor_profiles (1:1 member) ──< doctor_schedules, schedule_exceptions
                                            doctor_departments, doctor_services

CLINICAL   patients ──< appointments >── doctor_profiles
              │            └── visits ──< encounters ──< vitals, diagnoses, encounter_addenda
              │                                     └──< prescriptions ──< prescription_items
              ├──< patient_allergies, patient_conditions, consents, care_access_grants
              └──< patient_account_links >── patient_accounts ──< patient_sessions, patient_otps

ITEMS      item_categories ─┐   manufacturers ─┐   generics ─┐
                            ▼                   ▼             ▼
           inventory_items (1:1 medicine_details) ──< item_units ──< item_barcodes
                 │    └──< store_item_levels >── stores
                 └──< item_batches (one per received lot: batch_no, mfg, expiry, cost, MRP, price, status)
                           └──< batch_price_history, batch_status_history

STOCK      stores ──< store_members >── tenant_members
           postings ──< stock_movements >── (store, item_batch)   [append-only source of truth]
                              │ trigger
                              ▼
                        stock_balances (store × batch: on_hand ≥ 0, reserved)   [cache, reconciled]
           stock_transfers ──< stock_transfer_items ──< stock_transfer_lines (per lot)
           stock_adjustments ──< lines   stock_counts ──< lines   stock_disposals ──< lines
           stock_reservations (P2)

PURCHASING vendors ──< purchase_orders ──< purchase_order_lines
                   ──< purchase_invoices ──< purchase_invoice_lines ──► item_batches (creates lots)
                   ──< purchase_returns ──< purchase_return_lines (per lot)
                   ──< vendor_payments ──< vendor_payment_allocations >── purchase_invoices

SALES      invoices ──< invoice_lines (service | item+unit) ──< invoice_line_allocations (lot, store, qty, price, cost)
              │               └── prescription_item | external_prescription ──< dispensations
              ├──< payment_allocations >── payments (receipts/refunds; cash+online legs)
              └──< sale_returns ──< sale_return_lines ──► invoice_line_allocations

FINANCE    postings ──< ledger_entries >── ledger_accounts   [double-entry; store / party / channel dimensions]
           expenses   other_income   document_sequences (tenant, doc_type, fiscal_year)

CROSS      audit_log   notifications   push_subscriptions   notification_outbox   token_counters
```

## 3. Platform
- **tenants**: `id, slug (unique [a-z0-9-]), name, legal_name, business_type (clinic |
  clinic_pharmacy | pharmacy; `clinic_pharmacy` at launch, D-58), pan_number, registration_no, phone, email, address
  (province, district, municipality, ward, street), logo_path, timezone default
  'Asia/Kathmandu', status (pending|active|suspended|closed), created_from_application_id`.
- **tenant_applications**: marketing registration requests: `business_name,
  business_type, owner_name, email, email_verified_at, phone, address, pan (opt),
  plan_interest, status (submitted|verified|approved|rejected), reviewed_by, reviewed_at,
  reject_reason, tenant_id (after approval), ip, user_agent`. Rate-limited, CAPTCHA'd.
- **plans**: `code, name, price_npr, billing_cycle_days, max_doctors, max_members,
  max_stores, features text[]` (e.g. `pharmacy`, `lab`, `sms`, `multi_store`), `is_public`,
  `sort_order`. The pricing page reads public plans.
- **tenant_subscriptions**: append-only periods `(tenant_id, plan_id, starts_on, ends_on,
  status, source (trial|paid|extension))`. The current subscription is derived. A daily
  cron suspends tenants with no covering period (HRestroSewa `subscription-expiry`
  pattern).
- **platform_invoices** / **platform_payments**: what the platform bills each tenant
  (`invoice_no` per platform fiscal year, amount, period covered) and payments recorded
  manually (method, reference, recorded_by). An online gateway comes later (P-12).
- **platform_admins**: `auth_user_id`. MFA mandatory. Separate from tenant members.
- **platform_settings**: key/value typed settings (sender identity, feature flags).
  Changes are audited.

## 4. Identity, roles, access
- **tenant_members**: `id, tenant_id, auth_user_id, membership_role (tenant_admin |
  tenant_member), display_name, title, phone, email, is_active, deleted_at,
  last_active_at`; `unique (tenant_id, auth_user_id)`.
  **[OPEN] P-18:** employees without a personal email get a tenant-scoped **username** that
  maps to an internal Auth email (`u-<member_id>@<tenant-slug>.cmedisewa.internal`), which
  is HRestroSewa's synthetic-email idea but used for *password* accounts. Their recovery is
  admin-only.
- **tenant_roles**: `tenant_id, name, description, permissions text[], home_route,
  template_key (null for custom), is_active`; unique `(tenant_id, lower(name))`. Templates
  are seeded at provisioning (`permissions.md` §9).
- **member_roles**: M2M `(member_id, role_id)`.
- **member_permission_overrides**: `(member_id, permission, effect grant|revoke)`.
- **member_credentials**: `(member_id, profession doctor|nurse|pharmacist|lab_technician,
  council, registration_no, verified_by, verified_at, expires_on)`; unique `(tenant_id,
  profession, registration_no)`.
- **Effective permissions** = SQL function `effective_permissions(member_id)`: the union of
  role keys, plus grants, minus revokes, then filtered by business type, plan features and
  credentials. The TS twin lives in `lib/permissions.ts`, and a test asserts that both agree.
- **member_pins**: `(member_id PK, pin_hash (argon2id/bcrypt), set_at, failed_count,
  locked_until, must_change)`. A PIN is 6 digits (P-19). It is **never** an Auth password.
- **pin_attempts**: `(member_id, device_id, ip, success, at)`. Lockout: 5 consecutive
  failures → 15-minute lock per member (HRestroSewa uses 30). Per device, 20 failures per
  hour across all members → the device needs a password sign-in. The DB clock is
  authoritative, as in HRestroSewa's `pin_lockout_status`.
- **trusted_devices**: `(id, tenant_id, name, token_hash, enrolled_by, enrolled_at,
  last_used_at, last_ip, revoked_at, revoked_by, allowed_member_ids uuid[] null = all
  PIN-enabled members)`.
- **session_assurance**: `(session_id PK, auth_user_id, tenant_id, level A1|A2|A3, method
  pin|password|mfa, device_id, password_auth_at, reauth_at, created_at, expires_at)`.
  Written at every sign-in, PIN, unlock and step-up. It is read by `resolve_request_context`.
  Expired rows are pruned by cron.

## 5. Tenant setup & website
- **tenant_settings** (PK tenant_id), typed columns: booking (`booking_window_days`,
  `min_notice_minutes`, `cancellation_cutoff_hours`, `auto_confirm_online`,
  `scheduling_mode` P-03, `max_active_online_bookings_per_phone`), billing
  (`consultation_billing_point` check_in|checkout|none, default `check_in` (D-58), `default_services_profile_id`,
  `default_pharmacy_profile_id`, `print_paper_width`, `max_discount_pct_without_reauth`,
  `allow_credit`), operations (`day_closing_hour` default 0, `pin_policy`,
  `idle_lock_minutes`, `shift_window_hours`), privacy (`push_shows_patient_name` default
  false), inventory (`near_expiry_days` default 90, `critical_expiry_days` default 30,
  `min_sale_shelf_days` default 0, `min_receive_shelf_days` default 90 (warn below),
  `allocation_policy` default `fefo` (D-40), `transfer_approval_required`,
  `count_post_requires_other_member`, `allow_price_above_mrp` default false (P-25),
  `credit_limit_per_patient`, `default_receiving_store_id`, `default_counter_store_id`).
  Negative stock is **not a setting**: the database forbids it (D-38).
- **billing_profiles** (Revision 4, D-49): `id, tenant_id, name ("Clinic", "Pharmacy"),
  legal_name, pan_vat_no, registration_no (e.g. a DDA pharmacy registration), address,
  phone, invoice_prefix, invoice_pad, receipt_footer, is_default, is_active`. Every invoice
  carries a `billing_profile_id`. Every store has an optional `billing_profile_id` (the
  profile its sales bill under), and every service has one too (the default profile is used
  otherwise). **Numbering is per profile** (`document_sequences` keyed by
  `billing_profile_id`). A tenant starts with one profile and adds a second only when its
  pharmacy is a separate registration (not the case at launch: one PAN, D-58).
- **tenant_modules** (D-50): `(tenant_id, module_key, enabled, changed_by, changed_at)`. The
  effective set is computed with `lib/modules.ts` (business type ∧ plan ∧ enabled ∧
  dependencies) and returned by `resolve_request_context`.
- **site_settings** (PK tenant_id): `published, theme_color, hero_title, hero_subtitle,
  about_md, contact_phone, contact_email, whatsapp, map_url, hours jsonb (validated),
  social jsonb, seo_title, seo_description, show_prices, show_registration_numbers,
  booking_enabled, updated_by`.
- **site_announcements**: `title, body_md, starts_at, ends_at, is_pinned`.
  **site_media**: `path, alt, sort`. **site_faqs**: `q, a_md, sort`.
- **departments**, **services** (`kind consultation|procedure|lab|other, price_npr,
  duration_minutes, is_public, tax_category`), **doctor_profiles** (`member_id` PK,
  `specialty, qualification, bio, photo_path, consultation_fee, is_public, public_slug`,
  credential via `member_credentials`), **doctor_departments**, **doctor_services**
  (`price_override`).
- **doctor_schedules** (weekly template with effective dating; exclusion constraint against
  overlapping windows), **schedule_exceptions** (leave/extra/modified).

## 6. Patients & patient accounts
- **patients**: `id, tenant_id, mrn (unique per tenant, trigger-stamped), full_name,
  full_name_ne, sex, date_of_birth | age_years_at_registration, phone, alt_phone, email,
  address, guardian_name/relation, blood_group, created_via (desk|online), possible_duplicate
  bool, deleted_at, merged_into, merged_at`. Per-tenant identity (D-20). Duplicate detection runs on phone + name +
  age. **patient_merges** + **patient_merge_rows** record each combination and exactly which
  rows moved, so it can be undone (M-37, D-138).
- **patient_advances** (M-52, D-139): append-only deposits (+) and refunds (−) with cash /
  online legs, AD- receipt per billing profile. **payments.advance_amount** is a third leg
  (cash + online + advance = amount). Held = Σ advances − Σ payments.advance_amount
  (`patient_advance_balance`); the books check compares it with `PATIENT_ADVANCES`.
- **patient_allergies**, **patient_conditions**, **consents** (`kind, given_at, method,
  withdrawn_at`; consent text versioned, P-10).
- **patient_accounts**: per tenant (D-31): `id, tenant_id, email, phone, display_name,
  email_verified_at, phone_verified_at, status`; unique `(tenant_id, email)` and
  `(tenant_id, phone)`.
- **patient_account_links**: `(account_id, patient_id, relation self|child|parent|spouse|
  other, verified_at, verified_by_member_id)`. **Unverified** links show only
  appointments the account itself booked. **Verified** links unlock clinical documents (P2).
- **patient_otps**: `(account_id or destination, code_hash, purpose, expires_at, attempts)`
  with a TTL of 10 min or less, at most 5 attempts, and resend throttling.
- **patient_sessions**: `(id, account_id, token_hash, created_at, expires_at, ip, ua)`.
  Cookie `cm_patient` (httpOnly, Secure, SameSite=Lax, path `/c/<slug>`). Idle expiry 30
  days, renewed on use, revocable.

## 7. Scheduling, visits, clinical records
- **appointments**: `patient_id, doctor_member_id, service_id, department_id,
  scheduled_range tstzrange (null in pure token mode), token_no, source (online|phone|
  walk_in|follow_up), booked_by_kind (guest|patient_account|member), booked_by_id,
  status, reason_for_visit, manage_token_hash, cancel fields, rescheduled_from_id`.
  - Status machine `requested → confirmed → checked_in → in_consultation → completed`,
    with exits `cancelled` and `no_show`. Transitions only through RPCs, and a trigger
    rejects illegal ones.
  - **GiST exclusion** on `(tenant_id, doctor_member_id, scheduled_range)` for active
    statuses (D-11). A second exclusion on the patient's own range.
- **visits**: `id, tenant_id, patient_id, doctor_member_id, department_id (opt),
  appointment_id (opt, unique), visit_date (tenant-local), token_no, checked_in_at/by,
  checked_out_at/by, status (open|with_doctor|awaiting_billing|closed|cancelled)`;
  `unique (tenant_id, doctor_member_id, visit_date, token_no)`. A walk-in visit has no
  appointment. The visit's `patient_id` and `doctor_member_id` must equal the appointment's
  when one is linked (trigger).
- **token_counters**: `(tenant_id, doctor_member_id, visit_date) PK, next_token`. Created on
  first use and row-locked by `check_in`, so tokens are unique and sequential per doctor per
  day.
- **encounters** (draft → finalized; trigger blocks edits after finalize),
  **encounter_addenda**, **vitals** (CHECK plausible ranges), **diagnoses** (text, optional
  ICD-10, P-15).
- **prescriptions**: `rx_number` (per tenant sequence), status draft|issued|cancelled,
  immutable after issue.
- **prescription_items**: `item_id (opt → inventory_items when BT has a pharmacy, else
  null), medicine_text (always stored, the printed name), strength, form, dose, frequency,
  route, duration_days, quantity, instructions`.
- **care_access_grants**: `kind referral|share|break_glass, reason, granted_by, starts_at,
  expires_at`.

## 8. Inventory master data (Revision 3)
Design reasons: D-38 to D-46. HRestroSewa comparison: `../docs/hrestrosewa-reference.md` §2b.

### 8.1 Item master
- **inventory_items**: `id, tenant_id, item_code (per-tenant seq, 'ITM-00001', HRestroSewa
  `product_code` pattern), item_type (medicine|consumable|surgical|lab_reagent|other), name
  (display/brand name, e.g. "Cetamol 500"), category_id → item_categories,
  manufacturer_id → manufacturers, base_unit_id, default_purchase_unit_id,
  default_sale_unit_id, sku (unique per tenant when set), tax_category (P-08),
  min_stock_level, reorder_level, reorder_qty, max_stock_level (all in base units;
  min < reorder ≤ max), allow_loose_sale (sell below a pack), storage_condition
  (room|cool_2_8|frozen|protect_light), is_returnable_to_vendor, is_active, notes,
  deleted_at`.
  - **min_stock_level** means "critical, act now". **reorder_level** means "add to the
    purchase suggestion list". Both are checked per store when
    **store_item_levels** `(store_id, item_id, min, reorder, max)` overrides exist,
    because a counter has small par levels and the main store has large ones.
- **item_categories**: `(tenant_id, parent_id, name)`, a two-level tree (e.g. Medicines →
  Antibiotics).
- **manufacturers**: `(tenant_id, name, country)`; unique `lower(name)`.
- **medicine_details** (1:1 when `item_type = medicine`): `generic_id → generics,
  strength_value, strength_unit (mg|g|mcg|ml|IU|%|mg/ml|…), strength_text (for combinations,
  "500 mg + 65 mg"), dosage_form (CHECK: tablet, capsule, syrup, suspension, injection,
  infusion, ointment, cream, gel, drops, inhaler, powder, sachet, suppository, lotion, other),
  route (oral, IV, IM, SC, topical, ophthalmic, otic, nasal, inhalation, rectal, vaginal),
  schedule_class (otc|prescription_only|controlled|narcotic; P-22),
  requires_prescription (CHECK: true unless schedule_class = 'otc'), dda_registration_no
  (opt), pack_description ("10×10 tablets"), is_combination`.
- **generics**: `(tenant_id, name, atc_code opt)`. **[OPEN] P-24:** seed a platform-level
  generic, dosage-form and strength-unit list so tenants don't type "Paracetamol" five
  different ways. Items themselves stay tenant-owned.
- **item_barcodes**: `(tenant_id, item_id, unit_id, barcode)`; unique `(tenant_id,
  barcode)`. An item can have several barcodes (different packs or suppliers), each tied to a
  unit, so scanning a box adds one box and scanning a strip adds one strip.
- *Advanced (P2):* `medicine_ingredients (item_id, generic_id, strength)` for proper
  combination search, drug-interaction data, and therapeutic substitutes.

### 8.2 Units & conversion
- **item_units**: `(tenant_id, item_id, name (tab|strip|box|bottle|vial|ampoule|ml|pcs…),
  factor_to_base numeric(14,4) > 0, is_base, can_purchase, can_sell, sort)`. There is
  exactly one `is_base` per item (partial unique index), with factor 1.
- **Rule:** the base unit is the **smallest unit the tenant ever sells or dispenses**
  (tablet if loose tablets are sold, bottle for a syrup). **All stock is stored in base
  units.**
- Every document line stores `unit_id`, `qty` (in that unit), `factor_snapshot`, and
  `base_qty = qty × factor_snapshot` (generated). Prices on a line are **per its unit**, and
  the per-base price is derived (`price / factor`, 4 dp).
- A factor can't change once a posted line uses it (trigger). To change one, add a new unit.
- Rounding: money to 2 dp, per-base cost/price to 4 dp, all totals computed in SQL.

### 8.3 Batches (received lots)
- **item_batches**: one row per **received lot**: `id, tenant_id, item_id, batch_no
  (normalised upper/trim), mfg_date (opt), expiry_date (required for medicines; CHECK
  expiry > mfg), source (purchase|opening|found), purchase_invoice_line_id (unique when source =
  purchase), vendor_id, unit_cost_base numeric(14,4), mrp_base numeric(14,4),
  sale_price_base numeric(14,4) (default = mrp_base), status (active|blocked|recalled),
  block_reason, blocked_by, blocked_at, created_at`.
  - **Why per lot and not per batch number:** the same printed batch number can arrive
    twice at different costs and from different vendors. One row per receipt keeps exact
    cost per unit, and therefore exact COGS (HRestroSewa only has `last_unit_cost`, which is
    why its profit is labelled "estimated"). It also means a new purchase **never
    overwrites** an existing lot's expiry, MRP or price. In reports, a "batch" is
    `group by (item_id, batch_no)`.
  - **Typo guard:** if `(item, batch_no)` already exists with a different expiry, the RPC
    raises `BATCH_EXPIRY_MISMATCH` unless an override reason is given (audited).
  - **Expired** = `expiry_date ≤ today` (tenant-local, `lib/clinic-time.ts`). It is derived,
    never a stored status.
  - **Sellable** = `status = 'active'` and `expiry_date > today + min_sale_shelf_days` and
    the store is sellable. Expired, blocked and recalled lots are never allocated to a sale,
    dispense or transfer to a sellable store (enforced in the allocation function, not the
    UI).
  - Price changes (`set_prices`) go to **batch_price_history** `(batch_id, old, new,
    changed_by, at, reason)`. **[OPEN] P-25:** whether a sale price may exceed MRP (the
    default is refused, `PRICE_ABOVE_MRP`).
  - Non-medicine items without a batch or expiry use `batch_no = 'NA'` and a null expiry
    (allowed only when `item_type <> 'medicine'`). FEFO sorts a null expiry last.
- **batch_status_history**: block, recall and unblock events (A2, audited). A block applies
  in every store.

### 8.4 Stores
- **stores**: `id, tenant_id, code, name, kind (main|pharmacy|emergency|department|branch|
  quarantine), department_id (opt), billing_profile_id (opt; the profile its sales invoice
  under), is_sellable, is_dispensing, is_receiving, is_active`.
  Every tenant gets a **`Pharmacy`** store (sellable, receiving, dispensing; D-58) and one `quarantine` store at provisioning. A `main` or department store is optional. Quarantine
  is never sellable and holds expired, damaged and recalled stock awaiting return or
  disposal.
- **store_members**: `(store_id, member_id, access view|operate|manage)`. **Assignment is
  the source of store visibility** (HRestroSewa's assignment rule). `tenant_admin` and holders
  of `all_stores` see every store (`permissions.md` §5a).
- A "Branch store" is only a store kind here. Branch addresses and branch-level finance
  belong to multi-branch (M-41, future).

## 9. Stock ledger, balances, transfers, counts
### 9.1 stock_movements: the source of truth (append-only)
`id bigserial, tenant_id, store_id, batch_id, item_id (denormalised; composite FK (tenant_id,
batch_id, item_id) guarantees it matches the batch), qty_base numeric(14,3) signed ≠ 0,
kind, unit_cost_base (snapshot of the lot's cost), posting_id, doc_type, doc_id,
doc_line_id, reason_code, note, created_by, occurred_at default now()`.

| kind | sign | written by |
|---|---|---|
| `opening` | + | `post_opening_stock` |
| `purchase` | + | `post_purchase_invoice` |
| `purchase_return` | − | `post_purchase_return` |
| `sale` | − | `issue_invoice` (counter or visit) |
| `sale_return` | + | `post_sale_return`, `void_invoice` |
| `transfer_out` / `transfer_in` | − / + | `dispatch_transfer` / `receive_transfer` |
| `adjustment_in` / `adjustment_out` | + / − | `post_stock_adjustment` (reason: damaged, expired, lost, theft, found, correction, internal_use, sample) |
| `count_variance` | ± | `post_stock_count` |
| `disposal` | − | `post_disposal` (from quarantine) |
| `reservation` is **not** a movement | | P2 `stock_reservations` (§9.5) |

- **Immutable:** a trigger raises on UPDATE/DELETE. A correction is always a new movement
  that references the one it corrects.
- **Only posting functions write here.** `INSERT` is revoked from every login role,
  including `service_role`. The posting RPCs are `SECURITY DEFINER` functions owned by a
  non-login `ledger_writer` role. This structurally enforces "no stock change without a
  movement record": there is no code path that changes quantities directly.
- Every movement belongs to a **posting** (§11.6), so it traces back to a document, a
  person, a session level and a device.

### 9.2 stock_balances: maintained cache with a DB-enforced non-negative rule (D-38)
`(tenant_id, store_id, batch_id) PK, item_id, qty_on_hand numeric(14,3) CHECK (>= 0),
qty_reserved numeric(14,3) CHECK (>= 0 and <= qty_on_hand), updated_at`.
- Maintained **only** by an `AFTER INSERT` trigger on `stock_movements`, in the same
  transaction. No role can UPDATE it.
- **Negative stock is impossible at the database level:** the CHECK rejects it. Posting RPCs
  lock the affected balance rows (`SELECT … FOR UPDATE`, ordered by `(store_id, batch_id)`
  to avoid deadlocks), so two counters selling the last strip of a lot are serialised and
  the second gets `INSUFFICIENT_STOCK`.
- **The ledger stays authoritative.** Nightly `reconcile_stock_balances(tenant)` compares
  each balance with `Σ stock_movements`. A mismatch raises an alert, rebuilds the row from
  the ledger and writes an audit entry. Balances can be rebuilt from zero at any time.
- Views: `v_item_stock (tenant, store, item, on_hand, reserved, available, sellable,
  expired, blocked, near_expiry, value_at_cost)` and `v_batch_stock`.

### 9.3 Transfers (request → approve → dispatch → receive)
- **stock_transfers**: `transfer_no (document_sequences), from_store_id, to_store_id (≠
  from), status (requested|approved|rejected|dispatched|partially_received|received|
  cancelled), requested_by/at, approved_by/at, reject_reason, dispatched_by/at,
  received_by/at, note`.
- **stock_transfer_items**: `item_id, unit_id, requested_qty, requested_base_qty`.
  **stock_transfer_lines** (per lot, set at dispatch): `batch_id, dispatched_base_qty,
  received_base_qty, loss_base_qty, loss_reason`, with CHECK `received + loss ≤ dispatched`.
- Dispatch writes `transfer_out` from the source, per lot. Receive writes `transfer_in` to
  the destination for the received qty. **In transit** = dispatched − received − loss
  (derived). Loss is posted to finance as `INV_LOSS` (reason: transit loss/damage).
- `tenant_settings.transfer_approval_required` (default true when the tenant has three or
  more stores). If false, a request can be dispatched straight away.
- A transfer **into quarantine** is how expired or damaged stock is segregated. It is
  allowed for blocked and expired lots, and it is the only movement out allowed for them
  apart from purchase returns and disposal.

### 9.4 Adjustments, counts, disposal, blocking
- **stock_adjustments** (document): `adj_no, store_id, reason_code, note, posted_by`.
  **stock_adjustment_lines**: `batch_id, qty_base (signed), unit_cost_base`. Posting writes
  movements plus the finance entries (`INV_LOSS` or a gain). A reason is mandatory, and
  `found` creates a lot (with batch and expiry) if needed.
- **stock_counts**: `count_no, store_id, scope (full|category|selected), blind bool, status
  (draft|counting|submitted|posted|cancelled), started_at`. **stock_count_lines**:
  `batch_id, counted_qty_base, counted_at, counted_by, system_qty_at_count (computed from the
  ledger as of counted_at), variance (generated), reason`.
  - **The count stays accurate in a live pharmacy:** the system quantity is taken *as of
    each line's `counted_at`* from the ledger, so sales during the count don't create false
    variances. Posting writes `count_variance` movements equal to the variance.
  - **Segregation (setting `count_post_requires_other_member`):** the person who posts
    must differ from the counter.
- **stock_disposals**: `disposal_no, store_id (quarantine), method (vendor_return|
  incineration|authorised_contractor|other), contractor, witness_name, disposed_at,
  certificate_path (P2 files)`. **stock_disposal_lines**: `batch_id, qty_base`. Writes
  `disposal` movements plus `INV_LOSS`. **[OPEN] P-22:** controlled and narcotic disposal
  rules.
- **Blocking:** `block_batch(batch, reason)` sets status `blocked`/`recalled` for every
  store. The stock stays counted but becomes unsellable. Typical next step: transfer to
  quarantine, then a purchase return or disposal.
- **Bulk recall (M-51, D-140):** **batch_recalls** (item, batch_no, reason, notice
  reference, who, when) + **batch_recall_lots** (each lot covered, its status before).
  `recall_batch` marks every lot of the item with that batch number recalled;
  `recall_affected_sales` lists the issued bills that sold them, net of returns, with the
  patient or walk-in contact (audited read).

### 9.5 Reservations: stock holds (M-45, migration 0063, D-145)
`stock_holds` (hold_no HD-, store, patient or customer name/phone, expires_at, status
held|collected|released|expired, client_key for retries, ended_*, invoice_id) and
`stock_hold_lines` (one per lot: item, batch, unit, qty_base, collected_base,
prescription_item_id). `stock_balances.qty_reserved` is set by `sync_reserved` from the
holds still held (never by hand). **Available = on_hand − reserved**; the existing CHECK
`qty_reserved <= qty_on_hand` makes held stock untouchable by any movement. Writes only
through `create_stock_hold`, `release_stock_hold`, `issue_counter_sale` (collection),
`release_expired_holds` and the lot-status trigger. A draft cart still holds nothing.

## 10. Purchasing
- **vendors**: `vendor_code, name (unique lower per tenant), pan_vat_no, contact_person,
  phone, email, address, payment_terms_days, opening_payable, opening_as_of, is_active,
  notes`. **The payable is not stored** (HRestroSewa stores `credit_balance`). It is the
  journal balance of `AP_VENDORS` for that vendor (§12), and nightly reconciliation checks it
  against the documents.
- **purchase_orders** (MVP basic): `po_no, vendor_id, deliver_to_store_id, status (draft|
  sent|partially_received|received|closed|cancelled), expected_date, note, created_by`.
  **purchase_order_lines**: `item_id, unit_id, qty, factor_snapshot, base_qty,
  expected_unit_cost`. The received qty is **derived** from the purchase invoice lines that
  reference the PO line. PO approval and emailing to the vendor come in P2.
- **purchase_invoices** (the posting document, formerly `purchases`): `purchase_no
  (document_sequences, per FY), vendor_id, vendor_invoice_no, vendor_invoice_date,
  received_store_id, billing_profile_id (buying entity, default = store's profile), po_id (opt),
  status (draft|posted|void), subtotal, line_discount_total,
  bill_discount, taxable_amount, tax_amount, round_off, total, paid_cash, paid_online,
  online_channel, credit_amount, posted_by, posted_at, void_reason, posting_id`.
  - **Totals are computed in SQL from the lines**, and client totals are ignored
    (HRestroSewa's `record_purchase` does the same).
  - CHECK `paid_cash + paid_online + credit_amount = total` (HRestroSewa's
    `purchases_amounts_balance`). The method is **derived**: cash, online, credit, mixed or
    partial.
  - **Duplicate bill prevention:** `unique (tenant_id, vendor_id,
    lower(btrim(vendor_invoice_no))) where status <> 'void'`.
- **purchase_invoice_lines**: `item_id, unit_id, qty, free_qty, factor_snapshot, base_qty
  and free_base_qty (generated), unit_cost (per line unit), discount_pct, discount_amount,
  tax_rate, tax_amount, line_net, batch_no, mfg_date, expiry_date, mrp (per line unit),
  sale_price (per line unit, default MRP), po_line_id (opt), batch_id (set at posting)`.
  - **Lot cost** = (line_net − the line's share of bill_discount, pro rata) ÷ (base_qty +
    free_base_qty), so free goods dilute cost. Input tax is excluded when it is recoverable,
    otherwise included (P-08).
  - CHECK `expiry_date > vendor_invoice_date` for medicines. The RPC warns or refuses if the
    shelf life at receipt is below `min_receive_shelf_days`.
- **Posted purchases are immutable** (an intended departure from HRestroSewa's in-place
  `edit_purchase`). A mistake is either a **void** (allowed only while none of its lots has
  any movement other than the receipt, A2 + re-auth) or a **purchase return**.
- **vendor_payments**: `payment_no, vendor_id, amount > 0, cash_amount + online_amount =
  amount, online_channel, reference, paid_at (now), note, posting_id`.
  **vendor_payment_allocations** `(vendor_payment_id, purchase_invoice_id, amount)`:
  Σ ≤ payment, and per invoice Σ ≤ outstanding. Partial payments are allowed. Allocation is
  automatic **FIFO by invoice date** (HRestroSewa's FIFO credit settlement) or chosen
  manually. An unallocated remainder is a **vendor advance** (`VENDOR_ADVANCES`).
  - Invoice outstanding = credit_amount − Σ allocations − Σ credit notes applied (derived).
- **purchase_returns**: `return_no, vendor_id, purchase_invoice_id (recommended), store_id,
  status (draft|posted), settlement (credit_note|cash_refund|online_refund), total,
  reason`. **purchase_return_lines**: `batch_id, qty_base, unit_cost_base (lot cost),
  amount, reason (expired|near_expiry|damaged|wrong_item|recall|excess)`.
  - Validation: qty ≤ on hand in that store, and (if an invoice is linked) ≤ received on that
    invoice − already returned. Blocked and expired lots **can** be returned.
  - A credit note reduces the payable (FIFO against open invoices). A refund moves cash or
    bank money in.

## 11. Sales, billing & payments
### 11.1 invoices (one pipeline for services and items, D-35)
`billing_profile_id (required), invoice_no (document_sequences per billing profile per FY,
stamped on issue, gapless), fiscal_year, store_id (required when there is any item line;
exactly one selling store per invoice, whose billing profile must match), visit_id
(opt), patient_id (opt; **required** for a due/credit balance or a prescription-only item),
customer_name, customer_phone (anonymous OTC), source (counter|visit|dispensing), status
(draft|issued|void), subtotal, discount_total, taxable_amount, tax_total, round_off, total,
issued_by, issued_at, void_reason, voided_by, posting_id`.
- For pharmacy-only tenants the **patients** table is the tenant's people registry: a
  credit customer is a patient row with minimal fields, and the MRN is still assigned. This
  avoids a parallel `customers` table (HRestroSewa has `credit_customers`).

### 11.2 invoice_lines
`line_no, line_type (service|item), service_id | (item_id, unit_id), qty, factor_snapshot,
base_qty, unit_price (per line unit), discount_pct, discount_amount, tax_rate, tax_amount,
line_total, prescription_item_id (opt), external_prescription_id (opt),
price_override_reason`.

### 11.3 invoice_line_allocations: how one line spans several batches (D-42)
`(invoice_line_id, batch_id, store_id, base_qty > 0, unit_price_base (the lot's sale price
unless overridden), unit_cost_base (lot cost snapshot), movement_id unique)`.
- **One line per item, one allocation per lot.** "Paracetamol 500 × 30 tab" that takes 20
  from lot A (exp 2027-03) and 10 from lot B (exp 2027-08) is **one line with two
  allocations**. Each allocation writes exactly one `sale` movement.
- A deferred constraint trigger checks that Σ allocation base_qty equals the line's
  base_qty.
- If the lots have **different sale prices**, each allocation keeps its own price, and the
  line total is Σ (qty × price) − discount. The invoice prints batch no., expiry and price per
  allocation (customary on Nepali pharmacy bills: **Assumption**). *Alternative rejected:*
  forcing one price per line, which would either overcharge from the older lot or need the
  line to be split by hand.
- **COGS is exact:** Σ allocation `base_qty × unit_cost_base`.

### 11.4 Prescriptions at the counter
- An internal Rx line links through `prescription_item_id`. Dispensed quantity per Rx item =
  Σ linked lines' base qty; **partial dispensing** is the remainder.
  **dispensations** `(prescription_item_id, invoice_line_id, base_qty, substituted_item_id,
  substitution_reason, pharmacist_member_id)`.
- **external_prescriptions**: `prescriber_name, prescriber_reg_no, facility, rx_date,
  patient_id, recorded_by, image_path (P2)`. This is how an outside prescription is recorded
  for prescription-only items.
- `issue_invoice` refuses a `requires_prescription` item without a linked internal or
  external Rx (`RX_REQUIRED`). Controlled and narcotic items also need a register entry
  (M-48, P-22). Until P-22 is settled they are **blocked from sale** by default.

### 11.5 payments (customer receipts) and allocations
- **payments**: `receipt_no, patient_id (opt), amount (signed; negative = refund),
  cash_amount, online_amount (CHECK cash + online = amount, and each leg has the same sign
  as amount; this is HRestroSewa's sign-agreement check, which stops a fake split crediting
  the till), online_channel (esewa|khalti|fonepay|bank_transfer|card|other), reference,
  received_by, received_at, posting_id`.
  - **Mixed** = both legs non-zero. Card counts as bank money (HRestroSewa rule). The method
    shown is derived from the legs.
- **payment_allocations** `(payment_id, invoice_id, amount)`: one payment can settle several
  invoices (collecting dues) and one invoice can take several payments. Invoice outstanding
  = total − Σ allocations − Σ return credits (derived).
  - Default: when an invoice is issued at the counter, payment and allocation happen in the
    same transaction. A later dues collection allocates FIFO, oldest first.
- A **due** (credit) is allowed only with `allow_credit`, a named patient, and the
  `tenant_settings.credit_limit_per_patient`.

### 11.6 Returns, voids, numbering, idempotency
- **sale_returns**: `return_no, invoice_id (required: no return without the original invoice
  in the MVP), store_id, status (draft|posted), total, settlement (refund_cash|refund_online|
  reduce_due), reason, posting_id`. **sale_return_lines**: `invoice_line_allocation_id (the
  exact lot sold), qty_base ≤ sold − already returned, restock (sellable|quarantine|none),
  amount (original price with the discount prorated)`.
  - Restock `sellable` is allowed only if the lot is unexpired and unblocked and the item is
    returnable. Otherwise it goes to quarantine. `none` = destroyed (loss).
- **Void** = the whole invoice is cancelled. It is allowed only on the **same business day**
  (`day_closing_hour`), with no return posted against it, and it needs A2 + re-auth. It
  reverses every allocation (a `sale_return` movement to the original lot and store), every
  payment allocation (a refund) and every journal entry. After that day the only route is a
  **return**.
- **document_sequences** `(tenant_id, doc_type, scope_id, fiscal_year, next_no) PK`.
  `scope_id` is the billing profile for invoices, receipts and sale returns (D-49), and the
  tenant id for every other document type.
  `next_document_no()` locks the row `FOR UPDATE` inside the posting transaction, so numbers
  are gapless (a rollback releases the number too) and never duplicated. HRestroSewa uses an
  advisory lock + `max()+1`. The counter row is simpler and survives deletes.
- **postings** `(id, tenant_id, idempotency_key, doc_type, doc_id, posted_by,
  session_level, device_id, posted_at, reverses_posting_id (opt, unique))`;
  `unique (tenant_id, idempotency_key)`. **Every
  posting RPC inserts here first.** A retry with the same key (a double tap, a flaky network,
  a PWA resubmit) returns the original result instead of posting twice (D-44).

## 12. Finance journal (D-43)
- **ledger_accounts**: a fixed system chart seeded per tenant (no user-editable chart in the
  MVP):
  | Code | Type | Meaning |
  |---|---|---|
  | `CASH` | asset | cash in hand / till |
  | `BANK` | asset | online, wallet, card and bank money (channel kept as a dimension) |
  | `AR_PATIENTS` | asset | receivables: patient/customer dues |
  | `INVENTORY` | asset | stock at lot cost |
  | `INVENTORY_IN_TRANSIT` | asset | dispatched, not yet received |
  | `VENDOR_ADVANCES` | asset | paid to vendors beyond their invoices |
  | `TAX_RECEIVABLE` | asset | recoverable input tax (only if applicable, P-08) |
  | `AP_VENDORS` | liability | payables |
  | `PATIENT_ADVANCES` | liability | patient deposits not yet applied (P2, M-52) |
  | `TAX_PAYABLE` | liability | output tax (if applicable) |
  | `REV_SERVICES`, `REV_PHARMACY`, `REV_OTHER` | income | net sales (after discount, excluding tax); other income |
  | `COGS` | expense | cost of medicines and items sold (exact, per lot) |
  | `INV_LOSS` | expense | expiry, damage, loss, theft, count shortage, transit loss, disposal |
  | `INV_GAIN` | income | found stock, count surplus |
  | `EXP_<category>` | expense | operating expenses |
  | `OPENING_EQUITY` | equity | opening balances and opening stock |
  | `ROUNDING` | expense/income | bill round-off |
- **ledger_entries** (append-only): `id, tenant_id, posting_id, account_code, debit,
  credit (exactly one > 0), store_id (dimension), vendor_id | patient_id (party dimension),
  channel (cash|esewa|khalti|fonepay|bank_transfer|card|other), doc_type, doc_id,
  occurred_at, memo`. A deferred constraint trigger checks **Σ debit = Σ credit per
  posting**. Update and delete are blocked. Reversals are new postings.
- **Balances** (cash, bank, receivable, payable, inventory) = Σ by account up to a time.
  Opening(T) = Σ before T, so carry-forward **cannot drift**. This is the same property as
  HRestroSewa's `finance_report`, now guaranteed by the journal.
- `finance_openings` becomes an `opening` posting (Dr CASH/BANK, Cr OPENING_EQUITY).
  Opening stock posts Dr INVENTORY, Cr OPENING_EQUITY.
- **Reconciliation:** `verify_finance_integrity(tenant, from, to)` recomputes every figure
  from the documents, HRestroSewa-style (invoices, payments, purchases, vendor payments,
  returns, adjustments, expenses), and compares it with the journal. It runs nightly and in
  every test. A mismatch alerts and **blocks** nothing; the documents decide.

### 12.1 Posting rules (what each document writes, in one transaction)
| Document | Stock movements | Journal entries |
|---|---|---|
| Opening stock | `opening` + per lot | Dr INVENTORY / Cr OPENING_EQUITY |
| Purchase invoice posted | `purchase` + per lot | Dr INVENTORY (net cost) [+ Dr TAX_RECEIVABLE]; Cr CASH / BANK (paid legs); Cr AP_VENDORS (credit part) |
| Vendor payment | — | Dr AP_VENDORS (allocated) [+ Dr VENDOR_ADVANCES (unallocated)]; Cr CASH / BANK |
| Purchase return | `purchase_return` − | Dr AP_VENDORS (credit note) or Dr CASH/BANK (refund); Cr INVENTORY (lot cost); any difference to INV_LOSS/INV_GAIN |
| Invoice issued | `sale` − per allocation | Dr AR_PATIENTS (total); Cr REV_SERVICES / REV_PHARMACY (net, excl. tax), Cr TAX_PAYABLE, ± ROUNDING; **and** Dr COGS / Cr INVENTORY (Σ allocation cost) |
| Payment received | — | Dr CASH / BANK (legs); Cr AR_PATIENTS |
| Sale return | `sale_return` + (if restocked) | Dr REV_* (returned net) [+ Dr TAX_PAYABLE]; Cr AR_PATIENTS; restock: Dr INVENTORY / Cr COGS; destroyed: Dr INV_LOSS / Cr COGS |
| Refund | — | Dr AR_PATIENTS; Cr CASH / BANK |
| Void invoice | reversing `sale_return` | exact reversal of the invoice (and its payments) |
| Transfer dispatch / receive | `transfer_out` − / `transfer_in` + | Dr INVENTORY_IN_TRANSIT / Cr INVENTORY; then Dr INVENTORY / Cr INVENTORY_IN_TRANSIT; loss: Dr INV_LOSS / Cr INVENTORY_IN_TRANSIT |
| Adjustment out / disposal / count shortage | − | Dr INV_LOSS / Cr INVENTORY (lot cost) |
| Adjustment in / count surplus / found | + | Dr INVENTORY / Cr INV_GAIN |
| Expense | — | Dr EXP_<cat> / Cr CASH / BANK |
| Other income | — | Dr CASH / BANK / Cr REV_OTHER |
| Purchase invoice void (only while its lots are untouched) | reversing `purchase_return`-kind movements with `reason = void` | exact reversal of the purchase posting |
| Vendor payment / expense / other income reversal | — | exact reversal posting referencing the original (`reverses_posting_id`), then the corrected entry as a new posting |
| Patient advance / deposit (P2, M-52) | — | Dr CASH / BANK / Cr PATIENT_ADVANCES (liability); applied to an invoice: Dr PATIENT_ADVANCES / Cr AR_PATIENTS |
**Reversal rule:** every reversal is a new posting with `reverses_posting_id`, whose journal
lines mirror the original's lines with debit and credit swapped, and whose movements mirror
the original's with the sign flipped. A posting can be reversed **at most once** (unique on
`reverses_posting_id`).
Every entry carries `store_id` when a store is involved, so **store-wise** revenue, COGS,
gross margin, losses and inventory value come straight from the journal. Expenses are
tenant-wide, with an optional store tag.

### 12.2 Expenses & other income (HRestroSewa shapes)
- **expenses** (`extra_expenses` shape): `expense_no, category (CHECK: rent, electricity,
  water, internet, salary, maintenance, marketing, licenses, transport, cleaning,
  medical_waste, other), amount > 0, cash_amount + online_amount = amount (same-sign rule),
  online_channel, store_id (opt), note, recorded_by, recorded_at (now; no back-dating),
  posting_id`. Correction or deletion is a **reversal posting plus a new one** (A2 +
  re-auth, audited). Rows are never edited in place.
- **other_income** (`extra_income` shape): `amount, cash/online split, description, posting_id`.
  It is not a sale and never touches revenue from sales.

### 12.3 Report functions (all derived from the journal and documents)
`stock_report(tenant, store|null, from, to)` (opening, in, out by kind, closing per
item/lot, value at cost) · `batch_history(batch)` (every movement with its running balance,
equivalent to HRestroSewa's `product_history`) · `expiry_report(tenant, store, horizon)` ·
`low_stock(tenant, store)` · `purchase_register`, `vendor_ledger(vendor, from, to)` (opening,
bills, payments, returns, closing) · `sales_register`, `daily_sales_summary(tenant, store,
day)` · `item_sales(tenant, store, from, to)` (qty, revenue, COGS, margin) ·
`finance_report(tenant, from, to)` (balances and flows, HRestroSewa layout) ·
`profit_and_loss(tenant, store|null, from, to)` · `cash_book(tenant, day)`.

## 13. Audit, notifications
- **audit_log** (append-only; a trigger raises on update/delete for every role): `tenant_id,
  actor_kind (member|platform_admin|patient_account|guest_token|system), actor_id,
  session_level, device_id, action, target_type, target_id, patient_id, outcome
  (success|denied|error), reason, ip, ua, detail jsonb (before/after for writes; never
  clinical text), created_at`. Covers clinical reads, PIN/device/role events, voids,
  refunds, adjustments, settings, website publishing and exports.
- **notifications**, **push_subscriptions**, **notification_outbox** (`unique (ref_type,
  ref_id, kind, channel)` for exactly-once delivery; PHI-minimal payload).

## 14. Key constraints & indexes
| Purpose | Constraint / index |
|---|---|
| Tenant integrity | `unique (tenant_id, id)` everywhere; composite FKs |
| No double booking | GiST exclusion (doctor, range) and (patient, range), active statuses |
| One token per doctor per day | `unique (tenant_id, doctor, visit_date, token_no)` |
| Numbers | `unique (tenant_id, mrn)`, `(tenant_id, rx_number)`; every document number via `document_sequences` + `unique (tenant_id, fiscal_year, <doc>_no)` |
| Duplicate prevention | `postings unique (tenant_id, idempotency_key)`; `purchase_invoices unique (tenant_id, vendor_id, lower(btrim(vendor_invoice_no))) where status <> 'void'`; `item_barcodes unique (tenant_id, barcode)`; `inventory_items unique (tenant_id, sku)` |
| Lots | `item_batches unique (purchase_invoice_line_id)`; index `(tenant_id, item_id, expiry_date)` for FEFO; index `(tenant_id, item_id, batch_no)` for batch grouping and the expiry-mismatch check |
| Stock integrity | `stock_balances` PK `(tenant_id, store_id, batch_id)`, `CHECK (qty_on_hand >= 0)`, `CHECK (qty_reserved between 0 and qty_on_hand)`; composite FK `(tenant_id, batch_id, item_id)` on movements |
| Ledger reads | `stock_movements (tenant_id, store_id, batch_id, occurred_at)`, `(tenant_id, doc_type, doc_id)`; `ledger_entries (tenant_id, account_code, occurred_at)`, `(tenant_id, store_id, occurred_at)`, `(tenant_id, vendor_id)`, `(tenant_id, patient_id)` |
| Balanced journal | deferred constraint trigger: Σ debit = Σ credit per `posting_id` |
| Allocation completeness | deferred constraint trigger: Σ `invoice_line_allocations.base_qty` = `invoice_lines.base_qty` for item lines |
| Return limits | RPC-checked under row lock: returned ≤ sold per allocation; purchase returned ≤ received per lot |
| Split payments | `cash + online = amount` and same-sign legs on `payments`, `vendor_payments`, `expenses`, `other_income`; `paid_cash + paid_online + credit = total` on purchase invoices |
| Identity | `unique (tenant_id, auth_user_id)`; `trusted_devices (token_hash)`; `session_assurance (session_id)` |
| Accounts | `unique (tenant_id, email)`, `(tenant_id, phone)` on patient_accounts |
| Lookup | `patients (tenant_id, phone)`, trigram on name; `appointments (tenant_id, doctor, lower(scheduled_range))` |
| Immutability triggers | encounters, prescriptions, issued invoices, posted purchase invoices/returns/adjustments/counts/disposals, stock_movements, ledger_entries, postings, audit_log |

## 15. Assumptions & unresolved decisions
- **Assumption:** single location per tenant, but **multiple stores** inside it. Multi-branch
  is future (M-41).
- **[OPEN] P-03** slot vs token · **P-08** tax/IRD · **P-10** retention · **P-15** ICD-10 ·
  **P-16** multi-tenant membership UI · **P-18** username accounts · **P-19** PIN length ·
  **P-22** drug classes and dispensing rules · **P-24** platform
  drug master · **P-25** price above MRP · **P-26** journal vs pure derivation · whether
  `national_id_no` is collected.
- **Assumption:** pharmacy bills in Nepal customarily print batch and expiry per line.
- **Assumption:** one fiscal-year numbering series per document type per tenant. Per-store
  series are possible later (`document_sequences` would gain `store_id`).

## 16. Relationship index (Revision 4 audit)
Every tenant table has `tenant_id` and `unique (tenant_id, id)`, and every arrow below is a
**composite FK** `(tenant_id, x_id)`. Platform tables (`platform_admins`, `plans`,
`tenant_applications`, `platform_settings`) are the only ones without `tenant_id`.
| Entity | Belongs to / references | Referenced by | Owner (who writes) |
|---|---|---|---|
| tenants | plan via tenant_subscriptions; application | every tenant table | Super Admin (provision) |
| tenant_members | tenant, auth.users | roles, credentials, PIN, store_members, doctor_profiles, every `*_by` column | Admin |
| billing_profiles | tenant | invoices, stores, services, document_sequences | Admin |
| stores | tenant, billing profile, department | store_members, balances, movements, transfers, invoices | Admin |
| patients | tenant | appointments, visits, encounters, prescriptions, invoices, payments, account links, allergies | Employee (front desk) / public booking RPC |
| appointments | patient, doctor (member), service, department | visit, notifications | patient (public) / Employee |
| visits | patient, doctor, appointment (opt) | encounters, invoices, vitals | Employee (`check_in`) |
| encounters | visit, patient, doctor | vitals, diagnoses, addenda, prescriptions | Employee (doctor) |
| prescriptions / items | encounter, patient, doctor; item (opt) | invoice_lines, dispensations | Employee (doctor) |
| inventory_items / units / barcodes | tenant, category, manufacturer, generic | batches, all document lines, levels | Admin / inventory manager |
| item_batches | item, vendor, purchase_invoice_line | movements, balances, allocations, return lines | posting RPCs only |
| stock_movements | posting, store, batch (+ item) | balances (trigger) | posting RPCs only |
| purchase_invoices / lines | vendor, receiving store, billing profile (the buying entity; defaults to the store's profile), PO (opt) | batches, vendor allocations, returns | Employee/Admin (`manage_purchases`) |
| vendor_payments / allocations | vendor; purchase invoices | journal | Admin/accountant (`pay_vendors`) |
| invoices / lines / allocations | billing profile, store, visit, patient; service / item+unit; Rx item; batch | payment allocations, sale returns, dispensations | Employee (cashier, pharmacist) |
| payments / allocations | patient (opt); invoices | journal | Employee (cashier) |
| expenses / other_income | store (opt) | journal | Employee (`add_expenses`) / Admin |
| postings → ledger_entries | posting; account; store/vendor/patient dimensions | reports | posting RPCs only |
| audit_log | tenant (null = platform), actor | — | every sensitive action / RPC |
**Audit result:** after the Revision 4 fixes (visits columns, token_counters,
billing_profiles, reversal links), no entity referenced in `workflows.md` lacks a
definition, and no FK crosses tenants.
