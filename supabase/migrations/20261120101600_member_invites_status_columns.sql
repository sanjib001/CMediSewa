-- 0017 Let the app read invite STATUS, never the token hash.
-- Found by the B2 end-to-end test: the Super Admin clinic page (invite expiry/used) failed with
-- "permission denied for table member_invites", because 0014 revoked everything. A column-level
-- grant exposes only what the page needs; token_hash stays reachable only through the
-- SECURITY DEFINER functions (invite_preview, accept_invite, reissue_invite).
grant select (id, tenant_id, member_id, expires_at, used_at, revoked_at, created_by_admin, created_by_member, created_at)
  on member_invites to service_role;
