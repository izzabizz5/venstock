// The suspend / unsuspend / soft-delete rules (scripts/lib/tenant-status.mjs), without any database. The scripts
// running these statements against real local databases are in tests/tenant-lifecycle.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suspendPlan, deletePlan, reasonProblem, slugProblem } from "../scripts/lib/tenant-status.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
const row = (status, extra = {}) => ({ id: 7, slug: "acme", name: "Acme", status, status_changed_at: "2026-11-01T00:00:00.000Z", ...extra });
const sqlOf = (plan) => plan.statements.map((s) => s.sql.replace(/\s+/g, " ").trim());

test("suspend: unknown, provisioning, deleted and already-suspended vendors are refused, with nothing to run", () => {
  for (const [r, why] of [[undefined, /No vendor with the slug "acme"/], [row("provisioning"), /never finished setting up/],
    [row("deleted"), /deleted; a deleted vendor can't be suspended/], [row("suspended"), /already suspended \(since 2026-11-01/]]) {
    const p = suspendPlan(r, { slug: "acme", now: NOW });
    assert.match(p.error, why);
    assert.equal(p.statements, undefined);
  }
});

test("--resume: only a suspended vendor; unknown, active, provisioning and deleted are refused", () => {
  for (const [r, why] of [[undefined, /No vendor/], [row("active"), /active, not suspended; nothing to resume/],
    [row("provisioning"), /never finished/], [row("deleted"), /deleted/]]) {
    assert.match(suspendPlan(r, { slug: "acme", resume: true, now: NOW }).error, why);
  }
});

test("suspend: a guarded status change, open support sessions ended, an audit entry only if the change took effect", () => {
  const p = suspendPlan(row("active"), { slug: "acme", reason: "  unpaid  ", now: NOW });
  assert.equal(p.expect, "suspended");
  const [upd, support, audit] = p.statements;
  assert.deepEqual(sqlOf(p), [
    "UPDATE tenants SET status = ?, status_changed_at = ? WHERE id = ? AND status = ?",
    "UPDATE support_sessions SET code_hash = NULL, ended_at = ?, ended_by = ? WHERE tenant_id = ? AND ended_at IS NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = ? AND status_changed_at = ?)",
    "INSERT INTO audit_log (at, tenant_id, action, detail) SELECT ?, id, ?, ? FROM tenants WHERE id = ? AND status = ? AND status_changed_at = ?",
  ]);
  assert.deepEqual(upd.params, ["suspended", NOW, 7, "active"]);
  assert.deepEqual(support.params, [NOW, "vendor-suspended", 7, 7, "suspended", NOW]);
  assert.deepEqual(audit.params, [NOW, "vendor.suspended", "by scripts/suspend-tenant.mjs; reason: unpaid", 7, "suspended", NOW]);
});

test("--resume: suspended -> active, audited; no reason means no reason text", () => {
  const p = suspendPlan(row("suspended"), { slug: "acme", resume: true, now: NOW });
  assert.equal(p.expect, "active");
  assert.equal(p.statements.length, 2);
  assert.deepEqual(p.statements[0].params, ["active", NOW, 7, "suspended"]);
  assert.deepEqual(p.statements[1].params, [NOW, "vendor.unsuspended", "by scripts/suspend-tenant.mjs --resume", 7, "active", NOW]);
});

test("delete: refused without the exact --confirm slug, before anything else is looked at", () => {
  for (const confirm of [undefined, "", "ACME", "acme ", "acm", "other"]) {
    const p = deletePlan(row("suspended"), { slug: "acme", confirm, now: NOW });
    assert.match(p.error, /pass --confirm acme \(the exact slug\)/, String(confirm));
    assert.equal(p.statements, undefined);
  }
  // The registry's lookup ignores case; the confirmation doesn't.
  assert.match(deletePlan(row("suspended", { slug: "acme" }), { slug: "ACME", confirm: "ACME", now: NOW }).error, /slug is "acme"; type it exactly/);
});

test("delete: only a suspended vendor; active, provisioning, deleted and unknown are refused", () => {
  for (const [r, why] of [[row("active"), /is active\. Suspend it first \(node scripts\/suspend-tenant\.mjs acme\), export its data/],
    [row("provisioning"), /create-tenant --abandon acme/], [row("deleted"), /already deleted/], [undefined, /No vendor with the slug/]]) {
    const p = deletePlan(r, { slug: "acme", confirm: "acme", now: NOW });
    assert.match(p.error, why);
    assert.equal(p.statements, undefined);
  }
});

test("delete: suspended -> deleted (soft): no DROP, no DELETE, the registry row stays so the slug is never reused", () => {
  const p = deletePlan(row("suspended"), { slug: "acme", confirm: "acme", reason: "left", now: NOW });
  assert.equal(p.expect, "deleted");
  assert.deepEqual(p.statements[0].params, ["deleted", NOW, 7, "suspended"]);
  assert.deepEqual(p.statements[1].params, [NOW, "vendor-deleted", 7, 7, "deleted", NOW]);
  assert.deepEqual(p.statements[2].params, [NOW, "vendor.deleted", "by scripts/delete-tenant.mjs; reason: left", 7, "deleted", NOW]);
  for (const s of sqlOf(p)) {
    assert.doesNotMatch(s, /\bDROP\b|\bDELETE\b/i, s);
    assert.doesNotMatch(s, /\bslug\b/i, "the slug is never changed");
  }
});

test("reason and slug checks", () => {
  assert.equal(reasonProblem(undefined), null);
  assert.equal(reasonProblem("Unpaid invoice"), null);
  for (const bad of ["", "   ", "x".repeat(201), "a\nb", "bell\u0007"]) assert.match(reasonProblem(bad), /1-200 characters/, JSON.stringify(bad));
  assert.equal(slugProblem("acme"), null);
  for (const bad of ["Acme", "ab", "a;b", "acme' OR 1=1"]) assert.match(slugProblem(bad), /Bad slug/);
});
