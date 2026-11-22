// The rules for suspending, unsuspending and soft-deleting a vendor, shared by scripts/suspend-tenant.mjs and
// scripts/delete-tenant.mjs. Pure: each plan takes the vendor's registry row and returns either { error } or the
// statements to run on CONTROL (all in one call, so all or nothing). Unit-tested in tests/tenant-status.unit.test.mjs.
//
// Every write is guarded by the status it expects, and the audit entry is inserted only if the status change took
// effect (it selects the row with the new status and this run's timestamp), so a race with another change can never
// leave an audit entry for something that didn't happen.
//
// Nothing here drops a database or deletes a registry row: a deleted vendor's row stays (status 'deleted'), so its
// slug can never be reused (tenants.slug is UNIQUE, and create-tenant refuses deleted slugs).
import { stmt } from "./executor.mjs";
import { isValidSlug } from "../../src/lib/tenant.js";

export const MAX_REASON = 200;

// Checks the optional --reason text; returns an error message or null.
export function reasonProblem(reason) {
  if (reason === undefined) return null;
  const r = reason.trim();
  if (!r || r.length > MAX_REASON || /[\u0000-\u001f\u007f]/.test(r)) return `The reason must be 1-${MAX_REASON} characters with no control characters.`;
  return null;
}

export function slugProblem(slug) {
  return isValidSlug(slug) ? null : `Bad slug "${slug}".`;
}

const detail = (script, reason) => `by scripts/${script}${reason ? `; reason: ${reason.trim()}` : ""}`;

// The statements that change a vendor's status, end any open support session on it, and record it.
function change(row, { from, to, action, endedBy, script, reason, now }) {
  const stmts = [
    stmt("UPDATE tenants SET status = ?, status_changed_at = ? WHERE id = ? AND status = ?", to, now, row.id, from),
  ];
  if (endedBy) {
    stmts.push(stmt(`UPDATE support_sessions SET code_hash = NULL, ended_at = ?, ended_by = ?
      WHERE tenant_id = ? AND ended_at IS NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = ? AND status_changed_at = ?)`,
    now, endedBy, row.id, row.id, to, now));
  }
  stmts.push(stmt(`INSERT INTO audit_log (at, tenant_id, action, detail)
    SELECT ?, id, ?, ? FROM tenants WHERE id = ? AND status = ? AND status_changed_at = ?`,
  now, action, detail(script, reason), row.id, to, now));
  return stmts;
}

// suspend-tenant <slug>            active -> suspended
// suspend-tenant <slug> --resume   suspended -> active
export function suspendPlan(row, { slug, resume = false, reason, now }) {
  if (!row) return { error: `No vendor with the slug "${slug}".` };
  if (row.status === "deleted") return { error: `"${row.slug}" is deleted; a deleted vendor can't be suspended or resumed.` };
  if (row.status === "provisioning") {
    return { error: `"${row.slug}" never finished setting up (provisioning). Finish it with create-tenant --resume, or give up on it with create-tenant --abandon.` };
  }
  if (resume) {
    if (row.status !== "suspended") return { error: `"${row.slug}" is ${row.status}, not suspended; nothing to resume.` };
    return {
      statements: change(row, { from: "suspended", to: "active", action: "vendor.unsuspended", script: "suspend-tenant.mjs --resume", reason, now }),
      expect: "active",
    };
  }
  if (row.status === "suspended") return { error: `"${row.slug}" is already suspended (since ${row.status_changed_at}).` };
  if (row.status !== "active") return { error: `"${row.slug}" has an unexpected status: ${row.status}.` };
  return {
    statements: change(row, { from: "active", to: "suspended", action: "vendor.suspended", endedBy: "vendor-suspended", script: "suspend-tenant.mjs", reason, now }),
    expect: "suspended",
  };
}

// delete-tenant <slug> --confirm <slug>: suspended -> deleted (soft). The confirmation must be the exact slug, as
// typed and as registered (the registry's slug lookup ignores case; this doesn't).
export function deletePlan(row, { slug, confirm, reason, now }) {
  if (confirm !== slug) return { error: `Refusing: pass --confirm ${slug} (the exact slug) to delete "${slug}".` };
  if (!row) return { error: `No vendor with the slug "${slug}".` };
  if (row.slug !== slug) return { error: `Refusing: the vendor's slug is "${row.slug}"; type it exactly, in --confirm too.` };
  if (row.status === "deleted") return { error: `"${row.slug}" is already deleted.` };
  if (row.status === "provisioning") return { error: `"${row.slug}" never finished setting up; use create-tenant --abandon ${row.slug} instead.` };
  if (row.status !== "suspended") {
    return { error: `Refusing: "${row.slug}" is ${row.status}. Suspend it first (node scripts/suspend-tenant.mjs ${row.slug}), export its data, then delete.` };
  }
  return {
    statements: change(row, { from: "suspended", to: "deleted", action: "vendor.deleted", endedBy: "vendor-deleted", script: "delete-tenant.mjs", reason, now }),
    expect: "deleted",
  };
}
