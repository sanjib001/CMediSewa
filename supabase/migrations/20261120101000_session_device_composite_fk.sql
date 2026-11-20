-- 0011 Composite FK for session_assurance → trusted_devices (D-03).
-- Caught by the posture lint right after 0010: the plain FK on device_id alone could pair a
-- session of tenant A with a device of tenant B. Fixed forward.
alter table session_assurance drop constraint session_assurance_device_id_fkey;
alter table session_assurance add constraint session_assurance_device_fkey
  foreign key (tenant_id, device_id) references trusted_devices (tenant_id, id);
alter table session_assurance add constraint session_assurance_device_needs_tenant
  check (device_id is null or tenant_id is not null);
