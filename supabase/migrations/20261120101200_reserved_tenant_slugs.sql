-- 0013 Reserved tenant slugs. /login/mfa, /login/verify etc. live beside /login/[slug] and
-- /c/[slug]; a clinic with one of these slugs would be unreachable or would shadow an app
-- route. Enforced in the database so provisioning (B2) can never create one.
alter table tenants add constraint tenants_slug_not_reserved check (slug not in (
  'admin', 'api', 'app', 'auth', 'c', 'employee', 'help', 'login', 'logout', 'mfa', 'new',
  'platform', 'pricing', 'register', 'reset', 'settings', 'signin', 'signup', 'superadmin',
  'support', 'verify', 'www'
));
