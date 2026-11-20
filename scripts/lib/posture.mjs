// Access-posture rules, checked against a LIVE database (CI, `npm run db:posture`, DB tests).
// Each rule returns human-readable violations; an empty list means the rule holds.
// These are the invariants from security.md §4/§11/§12 that a migration could silently break.

/** Functions owned by ledger_writer that service_role may EXECUTE. Grows with document RPCs (B4+). */
export const EXPOSED_POSTING_FUNCTIONS = new Set([
  "check_in_visit", "post_opening_stock",
  "request_transfer", "decide_transfer", "dispatch_transfer", "receive_transfer", "post_stock_adjustment",
  "start_stock_count", "record_count", "post_stock_count", "cancel_stock_count", "set_batch_status", "post_disposal",
  "reconcile_stock_balances", "reconcile_all_tenants",
  "post_vendor_opening", "post_purchase_invoice", "void_purchase_invoice", "post_vendor_payment",
]);

const LEDGER_TABLES = ["postings", "ledger_entries", "document_sequences", "ledger_accounts"];
const APPEND_ONLY = ["audit_log", "postings", "ledger_entries"];

export async function checkPosture(c) {
  const v = [];
  const rows = async (sql, params) => (await c.query(sql, params)).rows;

  // 1. RLS on every table in public.
  for (const r of await rows(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity`)) {
    v.push(`RLS disabled on public.${r.relname}`);
  }

  // 2. No privileges for anon / authenticated / PUBLIC on tables, sequences, functions.
  for (const r of await rows(`
      select c.relname, a.privilege_type, coalesce(g.rolname, 'PUBLIC') grantee
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(c.relacl) a
        left join pg_roles g on g.oid = a.grantee
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','S')
         and (a.grantee = 0 or g.rolname in ('anon','authenticated'))`)) {
    v.push(`${r.grantee} holds ${r.privilege_type} on public.${r.relname}`);
  }
  for (const r of await rows(`
      select p.oid::regprocedure::text sig, coalesce(g.rolname, 'PUBLIC') grantee
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        left join pg_roles g on g.oid = a.grantee
       where n.nspname = 'public' and a.privilege_type = 'EXECUTE'
         and (a.grantee = 0 or g.rolname in ('anon','authenticated'))
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`)) {
    v.push(`${r.grantee} can EXECUTE ${r.sig}`);
  }

  // 2b. service_role holds DML only, never TRUNCATE/TRIGGER/REFERENCES (migration 0006).
  for (const r of await rows(`
      select c.relname, a.privilege_type
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(c.relacl) a
        join pg_roles g on g.oid = a.grantee
       where n.nspname = 'public' and c.relkind in ('r','p') and g.rolname = 'service_role'
         and a.privilege_type in ('TRUNCATE','TRIGGER','REFERENCES','MAINTAIN')`)) {
    v.push(`service_role holds ${r.privilege_type} on public.${r.relname}`);
  }

  // 3. service_role cannot write the ledger tables, nor rewrite append-only tables.
  for (const t of LEDGER_TABLES) {
    for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
      const [r] = await rows(`select has_table_privilege('service_role', $1, $2) ok`, [`public.${t}`, priv]);
      if (r?.ok) v.push(`service_role has ${priv} on ledger table ${t}`);
    }
  }
  for (const t of APPEND_ONLY) {
    for (const priv of ["UPDATE", "DELETE", "TRUNCATE"]) {
      const [r] = await rows(`select has_table_privilege('service_role', $1, $2) ok`, [`public.${t}`, priv]);
      if (r?.ok) v.push(`service_role has ${priv} on append-only table ${t}`);
    }
    const [trg] = await rows(`
        select count(*)::int n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = $1::regclass and p.proname = 'forbid_mutation'`, [`public.${t}`]);
    if (!trg || trg.n < 2) v.push(`append-only table ${t} lacks its forbid_mutation triggers`);
  }

  // 4. SECURITY DEFINER functions must pin search_path.
  for (const r of await rows(`
      select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)) {
    v.push(`SECURITY DEFINER without search_path: ${r.sig}`);
  }

  // 5. Posting primitives are not callable by the app unless deliberately exposed.
  for (const r of await rows(`
      select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and pg_get_userbyid(p.proowner) = 'ledger_writer'
         and has_function_privilege('service_role', p.oid, 'EXECUTE')`)) {
    if (!EXPOSED_POSTING_FUNCTIONS.has(r.proname)) v.push(`service_role can EXECUTE ledger function ${r.sig}`);
  }

  // 6. Tenant convention: a tenant table with a uuid `id` has unique (tenant_id, id) …
  for (const r of await rows(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and a.atttypid = 'uuid'::regtype and not a.attisdropped)
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.oid and i.indisunique and i.indnkeyatts = 2
              and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                    where a.attrelid = c.oid and a.attnum = any(i.indkey)) = array['id','tenant_id'])`)) {
    v.push(`tenant table ${r.relname} lacks unique (tenant_id, id)`);
  }
  // … and every FK into a tenant-owned table includes tenant_id (composite FK, D-03).
  for (const r of await rows(`
      select con.conname, src.relname src, dst.relname dst
        from pg_constraint con
        join pg_class src on src.oid = con.conrelid
        join pg_class dst on dst.oid = con.confrelid
        join pg_namespace n on n.oid = src.relnamespace
       where con.contype = 'f' and n.nspname = 'public' and dst.relname <> 'tenants'
         and exists (select 1 from pg_attribute a where a.attrelid = dst.oid and a.attname = 'tenant_id' and not a.attisdropped)
         and not exists (select 1 from pg_attribute a where a.attrelid = src.oid and a.attnum = any(con.conkey) and a.attname = 'tenant_id')`)) {
    v.push(`FK ${r.conname} (${r.src} → ${r.dst}) does not include tenant_id`);
  }

  return v;
}
