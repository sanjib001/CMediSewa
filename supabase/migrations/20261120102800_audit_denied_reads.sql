-- 0029 Found by tests/db/clinical.test.mjs: a REFUSED chart opening wrote its 'denied' audit row
-- and then raised, which rolled the row back, so refusals were never logged (security.md
-- requires them). clinical_check() logs and RETURNS the refusal; open_chart returns
-- {"error": …} instead of raising, so the row persists. Write functions still raise (their
-- work must roll back); the app logs those refusals itself (lib/clinical.ts).

create or replace function clinical_check(p_tenant uuid, p_member uuid, p_patient uuid, p_session_level text, p_need text, p_action text)
returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_scope text := clinical_scope(p_tenant, p_member, p_patient); v_code text;
begin
  if p_session_level is null or p_session_level not in ('A2', 'A3') then
    v_code := 'PASSWORD_REQUIRED';
  elsif v_scope is null
     or (p_need = 'write' and v_scope <> 'write')
     or (p_need = 'read' and v_scope not in ('write', 'read'))
     or (p_need = 'vitals' and v_scope not in ('write', 'vitals')) then
    v_code := 'NO_CLINICAL_ACCESS';
  end if;
  if v_code is not null then
    insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, reason)
    values (p_tenant, 'member', p_member, p_session_level, p_action, 'patient', p_patient::text, 'denied',
            case when v_code = 'PASSWORD_REQUIRED' then 'assurance' else coalesce(v_scope, 'no_care_relationship') end);
  end if;
  return v_code;
end $$;

create or replace function clinical_guard(p_tenant uuid, p_member uuid, p_patient uuid, p_session_level text, p_need text, p_action text)
returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_code text := clinical_check(p_tenant, p_member, p_patient, p_session_level, p_need, p_action);
begin
  if v_code is not null then raise exception '%', v_code using errcode = 'P0001'; end if;
  return clinical_scope(p_tenant, p_member, p_patient);
end $$;

create or replace function open_chart(p_tenant uuid, p_member uuid, p_patient uuid, p_session_level text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_scope text; v_out jsonb; v_refused text;
begin
  v_scope := clinical_scope(p_tenant, p_member, p_patient);
  -- A refusal is RETURNED, not raised, so its audit row is kept (a raise would roll it back).
  v_refused := clinical_check(p_tenant, p_member, p_patient, p_session_level, case when v_scope = 'vitals' then 'vitals' else 'read' end, 'patient.chart_read');
  if v_refused is not null then return jsonb_build_object('error', v_refused); end if;
  v_out := jsonb_build_object(
    'scope', v_scope,
    'patient', (select jsonb_build_object('id', id, 'mrn', mrn, 'full_name', full_name, 'sex', sex, 'date_of_birth', date_of_birth,
                  'age_years', age_years, 'created_at', created_at, 'blood_group', blood_group, 'phone', phone) from patients where id = p_patient),
    'allergies', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'allergen', allergen, 'reaction', reaction, 'severity', severity) order by created_at)
                   from patient_allergies where tenant_id = p_tenant and patient_id = p_patient and removed_at is null), '[]'),
    'vitals', coalesce((select jsonb_agg(v order by v->>'recorded_at' desc) from (
                   select jsonb_build_object('recorded_at', recorded_at, 'systolic', systolic, 'diastolic', diastolic, 'pulse', pulse, 'temp_c', temp_c,
                     'spo2', spo2, 'resp_rate', resp_rate, 'weight_kg', weight_kg, 'height_cm', height_cm) v
                     from vitals where tenant_id = p_tenant and patient_id = p_patient
                      and (v_scope <> 'vitals' or recorded_at > now() - interval '1 day')
                     order by recorded_at desc limit 10) x), '[]'));
  if v_scope in ('write', 'read') then
    v_out := v_out || jsonb_build_object(
      'encounters', coalesce((select jsonb_agg(e order by e->>'started_at' desc) from (
          select jsonb_build_object('id', en.id, 'status', en.status, 'started_at', en.started_at, 'finalized_at', en.finalized_at,
                   'doctor', m.display_name, 'mine', en.doctor_member_id = p_member, 'visit_id', en.visit_id,
                   'chief_complaint', en.chief_complaint, 'history', en.history, 'examination', en.examination, 'assessment', en.assessment,
                   'plan', en.plan, 'advice', en.advice, 'follow_up_on', en.follow_up_on,
                   'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('text', d.text, 'icd10', d.icd10, 'is_primary', d.is_primary) order by d.sort_order)
                                 from diagnoses d where d.encounter_id = en.id), '[]'),
                   'addenda', coalesce((select jsonb_agg(jsonb_build_object('body', a.body, 'at', a.created_at, 'by', am.display_name) order by a.created_at)
                                 from encounter_addenda a join tenant_members am on am.id = a.author_id where a.encounter_id = en.id), '[]'),
                   'prescription', (select jsonb_build_object('id', rx.id, 'rx_number', rx.rx_number, 'status', rx.status, 'notes', rx.notes, 'issued_at', rx.issued_at,
                                      'items', coalesce((select jsonb_agg(jsonb_build_object('medicine_text', i.medicine_text, 'strength', i.strength, 'form', i.form,
                                          'dose', i.dose, 'frequency', i.frequency, 'route', i.route, 'duration_days', i.duration_days, 'quantity', i.quantity,
                                          'instructions', i.instructions) order by i.line_no) from prescription_items i where i.prescription_id = rx.id), '[]'))
                                    from prescriptions rx where rx.encounter_id = en.id)) e
            from encounters en join tenant_members m on m.id = en.doctor_member_id
           where en.tenant_id = p_tenant and en.patient_id = p_patient
             and (en.status = 'finalized' or en.doctor_member_id = p_member)   -- others' drafts stay private
           order by en.started_at desc limit 30) x), '[]'));
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, session_level, action, target_type, target_id, outcome, detail)
  values (p_tenant, 'member', p_member, p_session_level, 'patient.chart_read', 'patient', p_patient::text, 'success', jsonb_build_object('scope', v_scope));
  return v_out;
end $$;

revoke all on function clinical_check(uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
