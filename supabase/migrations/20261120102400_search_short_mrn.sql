-- 0025 Desk search: a short MRN ("2" for 000002) is a valid lookup. Names still need 2+
-- characters so one letter doesn't list the whole register.
create or replace function search_patients(p_tenant uuid, p_q text, p_limit integer default 20)
returns setof patients
language sql stable
set search_path = pg_catalog, public
as $$
  with q as (select btrim(coalesce(p_q, '')) t, regexp_replace(coalesce(p_q, ''), '\D', '', 'g') d)
  select p.* from patients p, q
   where p.tenant_id = p_tenant and p.deleted_at is null
     and ((q.d = q.t and length(q.d) between 1 and 6 and p.mrn = lpad(q.d, 6, '0'))
          or (length(q.d) >= 4 and q.d = regexp_replace(q.t, '[\s+()-]', '', 'g') and p.phone_digits like '%' || q.d || '%')
          or (length(q.t) >= 2 and lower(p.full_name) like '%' || lower(q.t) || '%'))
   order by (p.mrn = lpad(q.d, 6, '0')) desc, p.full_name
   limit least(greatest(p_limit, 1), 50);
$$;
