import { requireTenant } from "@/lib/auth/context";
import { listStaff, type Role, type StaffRow } from "@/lib/tenant/setup-data";
import { permissionGroups } from "@/lib/permission-labels";
import { addCredential, inviteStaff, reissueStaffInvite, saveRole, setStaffActive, setStaffRoles, verifyCredential } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Staff & roles" };
export const dynamic = "force-dynamic";

const PROFESSIONS: [string, string][] = [["doctor", "Doctor (NMC)"], ["nurse", "Nurse (NNC)"], ["pharmacist", "Pharmacist (NPC)"], ["lab_technician", "Lab technician (NHPC)"]];
const HOMES: [string, string][] = [["/employee/registrar", "Registrar desk"], ["/employee/opd", "Doctor OPD"], ["/employee/pharmacy", "Pharmacy counter"], ["/employee/lab", "Lab (Phase 3)"], ["/admin", "Admin dashboard"]];
const small = "[&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm";

function status(m: StaffRow): { text: string; cls: string } {
  if (!m.is_active) return { text: "Deactivated", cls: "text-ink-faint" };
  if (m.joined) return { text: m.last_active_at ? `Last active ${m.last_active_at.slice(0, 10)}` : "Joined", cls: "text-ink-soft" };
  if (m.invite && m.invite.expires_at > new Date().toISOString()) return { text: `Invite open until ${m.invite.expires_at.slice(0, 10)}`, cls: "text-warn" };
  return { text: "Invite expired", cls: "text-alert" };
}

function RoleChecks({ roles, selected }: { roles: Role[]; selected: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {roles.filter((r) => r.is_active || selected.includes(r.id)).map((r) => (
        <label key={r.id} className="flex items-center gap-2"><input type="checkbox" name="role_ids" value={r.id} defaultChecked={selected.includes(r.id)} />{r.name}</label>
      ))}
    </div>
  );
}

function RoleEditor({ role }: { role?: Role }) {
  const has = new Set(role?.permissions ?? []);
  return (
    <ActionForm action={saveRole} submitLabel={role ? "Save role" : "Create role"} resetOnSuccess={!role}>
      {role ? <input type="hidden" name="id" value={role.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className={label}>Name</span><input name="name" defaultValue={role?.name} required className={field} /></label>
        <label className="block"><span className={label}>Opens on</span>
          <select name="home_route" defaultValue={role?.home_route ?? "/employee/registrar"} className={field}>{HOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="block"><span className={label}>Description</span><input name="description" defaultValue={role?.description ?? ""} className={field} /></label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {permissionGroups().map((g) => (
          <fieldset key={g.section}>
            <legend className="mb-1 text-sm font-semibold">{g.title}</legend>
            {g.keys.map((k) => (
              <label key={k.key} className="flex items-start gap-2 py-0.5 text-sm">
                <input type="checkbox" name="permissions" value={k.key} defaultChecked={has.has(k.key)} className="mt-1" />
                <span>{k.label}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </ActionForm>
  );
}

// Viewing: Admin area + manage_staff. Every change here is staff.manage: password AND
// authenticator, confirmed within the last 5 minutes (permissions.md §3).
export default async function Staff() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_staff", allowPendingTenant: true, next: "/admin/staff" });
  const { staff, roles } = await listStaff(ctx.tenantId);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "?";
  const isAdmin = ctx.membershipRole === "tenant_admin";
  return (
    <>
      <PageHeader title="Staff & roles" subtitle="Invite people, decide what each can do, and verify registration numbers. Changes ask you to confirm your password and authenticator if you haven't in the last 5 minutes." />
      <div className="space-y-6">
        <Panel title="Invite someone">
          <ActionForm action={inviteStaff} submitLabel="Create invite link">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block"><span className={label}>Name</span><input name="display_name" required placeholder="e.g. Dr. Sita Sharma" className={field} /></label>
              <label className="block"><span className={label}>Job title</span><input name="title" placeholder="e.g. Pharmacist" className={field} /></label>
              <label className="block"><span className={label}>Access</span>
                <select name="membership_role" className={field}><option value="tenant_member">Staff (by roles below)</option>{isAdmin ? <option value="tenant_admin">Clinic admin (everything except clinical)</option> : null}</select></label>
              <label className="block"><span className={label}>Email</span><input name="email" type="email" className={field} /></label>
              <label className="block"><span className={label}>or a username</span><input name="username" pattern="[a-z0-9][a-z0-9._\-]{2,31}" placeholder="e.g. ramesh" className={field} />
                <span className="mt-1 block text-xs text-ink-faint">For staff without email. They sign in on your clinic&apos;s own link.</span></label>
              <div />
              <fieldset className="sm:col-span-3"><legend className={label}>Roles</legend><RoleChecks roles={roles} selected={[]} /></fieldset>
              <label className="block"><span className={label}>Registered professional?</span>
                <select name="profession" className={field}><option value="">No</option>{PROFESSIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="block"><span className={label}>Registration number</span><input name="registration_no" className={field} /></label>
            </div>
            <p className="text-sm text-ink-faint">You&apos;ll get a one-time link to send them (valid 7 days). Doctors and admins set up an authenticator app when they first sign in.</p>
          </ActionForm>
        </Panel>

        <Panel title="People" aside={<span className="text-sm text-ink-faint">{staff.filter((m) => m.is_active).length} active</span>} flush>
          <ul className="divide-y divide-line">
            {staff.map((m) => {
              const st = status(m);
              const self = m.id === ctx.memberId;
              return (
                <li key={m.id} className="px-5 py-3.5">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-5 gap-y-1">
                      <span className={m.is_active ? "font-medium" : "font-medium text-ink-faint"}>{m.display_name}{self ? " (you)" : ""}</span>
                      <span className="text-sm text-ink-faint">{m.title ?? ""}{m.title ? ", " : ""}{m.email ?? `username ${m.username}`}</span>
                      <span className="text-sm">{m.membership_role === "tenant_admin" ? "Clinic admin" : m.roleIds.map(roleName).join(", ") || <span className="text-warn">No role</span>}</span>
                      {m.credentials.some((c) => !c.verified_at) ? <span className="text-sm text-warn">Registration not verified</span> : null}
                      <span className={`ml-auto text-sm ${st.cls}`}>{st.text}</span>
                    </summary>

                    <div className="mt-4 grid gap-5 lg:grid-cols-2">
                      {m.membership_role === "tenant_member" ? (
                        <ActionForm action={setStaffRoles} submitLabel="Save roles" resetOnSuccess={false} className={small}>
                          <input type="hidden" name="member_id" value={m.id} />
                          <fieldset><legend className={label}>Roles</legend><RoleChecks roles={roles} selected={m.roleIds} /></fieldset>
                        </ActionForm>
                      ) : <p className="text-sm text-ink-soft">Clinic admins can use every non-clinical part of the system. Clinical work also needs a verified registration.</p>}

                      <div className="space-y-3">
                        <div className={label}>Registrations</div>
                        {m.credentials.length === 0 ? <p className="text-sm text-ink-faint">None.</p> : m.credentials.map((c) => (
                          <div key={c.id} className="flex flex-wrap items-center gap-3 text-sm">
                            <span>{PROFESSIONS.find(([k]) => k === c.profession)?.[1]}: {c.council} {c.registration_no}{c.expires_on ? `, expires ${c.expires_on}` : ""}</span>
                            {c.verified_at ? <span className="text-ok">Verified {c.verified_at.slice(0, 10)}</span>
                              : self ? <span className="text-warn">Another admin or CMediSewa must verify yours</span>
                              : isAdmin ? (
                                <ActionForm action={verifyCredential} submitLabel="I checked it: verify" tone="secondary" className={small}
                                  confirm={`Confirm you checked ${c.council} registration ${c.registration_no} for ${m.display_name} with the council's register.`}>
                                  <input type="hidden" name="credential_id" value={c.id} />
                                </ActionForm>
                              ) : <span className="text-warn">Not verified</span>}
                          </div>
                        ))}
                        <details>
                          <summary className="cursor-pointer text-sm text-pine">Add a registration</summary>
                          <ActionForm action={addCredential} submitLabel="Add registration" className={`mt-2 ${small}`}>
                            <input type="hidden" name="member_id" value={m.id} />
                            <div className="grid gap-2 sm:grid-cols-3">
                              <select name="profession" className={field}>{PROFESSIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                              <input name="registration_no" required placeholder="Number" className={field} />
                              <input name="expires_on" type="date" aria-label="Expires on (optional)" className={field} />
                            </div>
                          </ActionForm>
                        </details>
                      </div>

                      <div className="flex flex-wrap gap-3 lg:col-span-2">
                        {!m.joined && m.is_active ? (
                          <ActionForm action={reissueStaffInvite} submitLabel="New invite link" tone="secondary" className={small}>
                            <input type="hidden" name="member_id" value={m.id} />
                          </ActionForm>
                        ) : null}
                        {!self ? (
                          <ActionForm action={setStaffActive} submitLabel={m.is_active ? "Deactivate" : "Reactivate"} tone={m.is_active ? "danger" : "secondary"} className={small}
                            confirm={m.is_active ? `Deactivate ${m.display_name}? They are signed out at once and can't sign in until reactivated. Their records stay.` : undefined}>
                            <input type="hidden" name="member_id" value={m.id} /><input type="hidden" name="active" value={m.is_active ? "false" : "true"} />
                          </ActionForm>
                        ) : null}
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="Roles" aside={<span className="text-sm text-ink-faint">What each kind of staff member can do</span>} flush>
          <ul className="divide-y divide-line">
            {roles.map((r) => (
              <li key={r.id} className="px-5 py-3.5">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-sm text-ink-faint">{r.permissions.length} permissions, opens on {HOMES.find(([h]) => h === r.home_route)?.[1] ?? r.home_route}</span>
                    <span className="ml-auto text-sm text-ink-faint">{staff.filter((m) => m.roleIds.includes(r.id) && m.is_active).length} people</span>
                  </summary>
                  <div className="mt-4"><RoleEditor role={r} /></div>
                </details>
              </li>
            ))}
          </ul>
          <div className="border-t border-line p-5">
            <details>
              <summary className="cursor-pointer font-medium text-pine">Create a role</summary>
              <div className="mt-4"><RoleEditor /></div>
            </details>
          </div>
        </Panel>
      </div>
    </>
  );
}
