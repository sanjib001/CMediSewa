// DEVELOPMENT ONLY: the demo clinic's B3 setup data (departments, services, the demo doctor's
// profile and OPD hours, a published website). Idempotent: only fills what is missing, never
// overwrites what someone changed in the Admin screens. Runs inside the caller's transaction.
export async function ensureDemoSetup(c, tenantId) {
  const done = [];
  for (const [name, order] of [["General medicine", 1], ["Paediatrics", 2]]) {
    const r = await c.query(`insert into departments (tenant_id, name, sort_order) values ($1, $2, $3)
                             on conflict (tenant_id, lower(btrim(name))) do nothing`, [tenantId, name, order]);
    if (r.rowCount) done.push(`department ${name}`);
  }
  const { rows: [gm] } = await c.query(`select id from departments where tenant_id = $1 and name = 'General medicine'`, [tenantId]);
  for (const [name, kind, price, mins] of [
    ["General OPD", "consultation", 500, 15], ["Follow-up visit", "consultation", 300, 10],
    ["Dressing", "procedure", 200, 15], ["Nebulisation", "procedure", 250, 20],
  ]) {
    const r = await c.query(`insert into services (tenant_id, department_id, name, kind, price_npr, duration_minutes)
                             values ($1, $2, $3, $4, $5, $6) on conflict (tenant_id, lower(btrim(name))) do nothing`,
      [tenantId, kind === "consultation" ? gm.id : null, name, kind, price, mins]);
    if (r.rowCount) done.push(`service ${name}`);
  }

  const { rows: [doc] } = await c.query(`select id from tenant_members where tenant_id = $1 and lower(username) = 'doctor'`, [tenantId]);
  if (doc) {
    const p = await c.query(`insert into doctor_profiles (tenant_id, member_id, specialty, qualification, bio, consultation_fee, room)
                             values ($1, $2, 'General medicine', 'MBBS, MD', 'Family medicine for all ages. (Demo profile.)', 500, 'Room 1')
                             on conflict (member_id) do nothing`, [tenantId, doc.id]);
    if (p.rowCount) done.push("doctor profile");
    await c.query(`insert into doctor_departments (tenant_id, member_id, department_id) values ($1, $2, $3) on conflict do nothing`, [tenantId, doc.id, gm.id]);
    const { rows: [{ n }] } = await c.query(`select count(*)::int n from doctor_schedules where member_id = $1`, [doc.id]);
    if (n === 0) {
      // Sunday–Friday mornings in 15-minute slots; Sunday–Thursday evening token OPD.
      await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, slot_minutes, room, effective_from)
                     select $1, $2, d, '09:00', '13:00', 15, 'Room 1', current_date from generate_series(0, 5) d`, [tenantId, doc.id]);
      await c.query(`insert into doctor_schedules (tenant_id, member_id, weekday, start_time, end_time, max_tokens, room, effective_from)
                     select $1, $2, d, '16:00', '18:00', 25, 'Room 1', current_date from generate_series(0, 4) d`, [tenantId, doc.id]);
      done.push("doctor OPD hours");
    }
  }

  const s = await c.query(`insert into site_settings (tenant_id, published, published_at, hero_title, hero_subtitle, about_md, hours_text, contact_phone)
     values ($1, true, now(), 'Arogya Clinic (demo)', 'Family doctors and a full pharmacy under one roof.',
             'This is a demo clinic on CMediSewa. Nothing here is real.', 'Sun–Fri 9am–6pm', '01-5550123')
     on conflict (tenant_id) do nothing`, [tenantId]);
  if (s.rowCount) done.push("published website");
  const f = await c.query(`insert into site_faqs (tenant_id, question, answer_md, sort_order)
     select $1, 'Do I need an appointment?', 'Walk-ins get a token at the front desk. Booking ahead saves you the wait.', 1
     where not exists (select 1 from site_faqs where tenant_id = $1)`, [tenantId]);
  if (f.rowCount) done.push("FAQ");
  // ── demo medicines + opening stock (B5a), only when the clinic has no items yet ──
  const { rows: [{ n: itemCount }] } = await c.query(`select count(*)::int n from inventory_items where tenant_id = $1`, [tenantId]);
  if (itemCount === 0) {
    const { rows: [adm] } = await c.query(`select id from tenant_members where tenant_id = $1 and membership_role = 'tenant_admin' and is_active limit 1`, [tenantId]);
    const { rows: [store] } = await c.query(`select id from stores where tenant_id = $1 and kind = 'pharmacy' limit 1`, [tenantId]);
    const tabs = [{ name: "tab", factor: 1, is_base: true }, { name: "strip", factor: 10 }, { name: "box", factor: 100 }];
    const caps = [{ name: "cap", factor: 1, is_base: true }, { name: "strip", factor: 10 }];
    const MEDS = [
      { name: "Cetamol 500", generic: "Paracetamol", strength_value: 500, strength_unit: "mg", dosage_form: "tablet", schedule_class: "otc", units: tabs, reorder_level: 300, min_stock_level: 100, lots: [["CT2311", 36, "strip", 12, 20], ["CT2402", 14, "box", 115, 200]] },
      { name: "Amoxil 500", generic: "Amoxicillin", strength_value: 500, strength_unit: "mg", dosage_form: "capsule", schedule_class: "prescription_only", units: caps, reorder_level: 100, lots: [["AX2309", 8, "strip", 60, 95]] },
      { name: "Pantop 40", generic: "Pantoprazole", strength_value: 40, strength_unit: "mg", dosage_form: "tablet", schedule_class: "prescription_only", units: tabs, reorder_level: 100, lots: [["PT2310", 5, "strip", 70, 120]] },
      { name: "Cetrizet 10", generic: "Cetirizine", strength_value: 10, strength_unit: "mg", dosage_form: "tablet", schedule_class: "otc", units: tabs, reorder_level: 50, min_stock_level: 30, lots: [["CZ2207", 2, "strip", 15, 25]] },
      { name: "Amlod 5", generic: "Amlodipine", strength_value: 5, strength_unit: "mg", dosage_form: "tablet", schedule_class: "prescription_only", units: tabs, reorder_level: 200, lots: [["AM2312", 30, "strip", 25, 40]] },
      { name: "Jeevan Jal ORS", generic: "Oral rehydration salts", strength_text: "20.5 g", dosage_form: "sachet", schedule_class: "otc",
        units: [{ name: "sachet", factor: 1, is_base: true }, { name: "box", factor: 50 }], reorder_level: 50, lots: [["OR2401", 2, "box", 500, 750]] },
    ];
    const d = (months) => { const x = new Date(); x.setUTCMonth(x.getUTCMonth() + months); return x.toISOString().slice(0, 10); };
    const EXP = { CT2311: d(2), CT2402: d(20), AX2309: d(10), PT2310: d(14), CZ2207: d(-1), AM2312: d(5), OR2401: d(24) };
    const lines = [];
    for (const m of MEDS) {
      const { lots, ...item } = m;
      const { rows: [{ id }] } = await c.query(`select save_item($1, null, $2, $3) id`, [tenantId, JSON.stringify({ item_type: "medicine", route: "oral", manufacturer: "Demo Pharma", default_sale_unit: item.units[1]?.name ?? item.units[0].name, ...item }), adm.id]);
      const { rows: us } = await c.query(`select id, name from item_units where item_id = $1`, [id]);
      for (const [batch, qty, unit, cost, mrp] of lots) {
        lines.push({ item_id: id, unit_id: us.find((u) => u.name === unit).id, qty, batch_no: batch, expiry_date: EXP[batch], unit_cost: cost, mrp });
      }
    }
    await c.query(`select post_opening_stock($1, gen_random_uuid(), $2, $3, 'Demo opening stock', $4, 'A2', null)`, [tenantId, store.id, JSON.stringify(lines), adm.id]);
    const { rows: [ph] } = await c.query(`select id from tenant_members where tenant_id = $1 and lower(username) = 'pharmacy'`, [tenantId]);
    if (ph) await c.query(`insert into store_members (tenant_id, store_id, member_id, access) values ($1, $2, $3, 'manage') on conflict do nothing`, [tenantId, store.id, ph.id]);
    done.push(`demo medicines (${MEDS.length}) with opening stock, incl. one expired and one near-expiry lot`);
  }
  return done;
}
