-- 0024 Patients: the app may edit demographics only. 0022 revoked UPDATE on (mrn, …) by
-- column, but a column revoke does not narrow a TABLE-level grant (found by the tests; the
-- MRN trigger still blocked the change). Replace the table grant with column grants.
revoke update on patients from service_role;
grant update (full_name, full_name_ne, sex, date_of_birth, age_years, phone, alt_phone, email, address,
              guardian_name, guardian_relation, blood_group, deleted_at) on patients to service_role;
revoke update on patient_allergies from service_role;
grant update (removed_at) on patient_allergies to service_role;
