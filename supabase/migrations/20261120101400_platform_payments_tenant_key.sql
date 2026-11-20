-- 0015 Tenant key on platform_payments (D-03 convention), caught by the posture lint after 0014.
alter table platform_payments add constraint platform_payments_tenant_id_id_key unique (tenant_id, id);
