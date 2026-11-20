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
  return done;
}
