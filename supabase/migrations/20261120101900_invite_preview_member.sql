-- 0020 invite_preview also returns member_id, so a USERNAME-only staff member (P-18) can accept
-- an invite: their auth account uses the internal address m-<member_id>@users.cmedisewa.internal.
drop function invite_preview(text);
create function invite_preview(p_token_hash text)
returns table (invite_id uuid, member_id uuid, tenant_name text, tenant_slug text, member_name text, email text, username text)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select i.id, m.id, t.name, t.slug, m.display_name, m.email, m.username
    from member_invites i join tenant_members m on m.id = i.member_id join tenants t on t.id = i.tenant_id
   where i.token_hash = p_token_hash and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and m.auth_user_id is null and m.is_active and t.status <> 'closed';
$$;
revoke all on function invite_preview(text) from public, anon, authenticated;
grant execute on function invite_preview(text) to service_role;
