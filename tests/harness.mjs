// Test harness: starts the app on throwaway local databases (a control database plus one database per vendor), seeds
// users, and gives tests an HTTP client that keeps cookies and can log in with password + 6-digit code.
// No dependencies; local only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request as httpRequest } from "node:http";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { totpCode } from "../src/lib/auth.js";
import { serverCommand } from "./config.mjs";
import { localSql } from "./local-sql.mjs";
import { renderConfig, LOCAL_CONTROL, localVendorDb, vendorBinding } from "../scripts/lib/wrangler-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Known test accounts. Secrets are fake and only ever used against a temporary local database.
export const USERS = {
  admin: { email: "admin@example.test", password: "test-password-admin", totpSecret: "JBSWY3DPEHPK3PXP", isAdmin: true },
  staff: { email: "staff@example.test", password: "test-password-staff", totpSecret: "KRSXG5CTMVRXEZLU", isAdmin: false },
};

// Refuse anything that could reach Cloudflare, even if config.mjs is edited carelessly.
function assertLocal(args) {
  const bad = args.find((a) => /^--(remote|preview)\b/.test(a) || /^(deploy|publish)$/.test(a));
  if (bad) throw new Error(`test harness refuses to run a command with ${bad}`);
  if (args.includes("d1") && !args.includes("--local")) throw new Error("test harness: d1 commands must be --local");
}

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Same format as hashPassword() in src/lib/auth.js.
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
  return `pbkdf2$100000$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
export function userInsertSql(u) {
  return `INSERT INTO users (email, is_admin, password_hash, totp_secret, totp_enabled, created_at)
VALUES (${sqlString(u.email)}, ${u.isAdmin ? 1 : 0}, ${sqlString(hashPassword(u.password))}, ${sqlString(u.totpSecret)}, 1, ${sqlString(new Date().toISOString())});`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

// Low-level request to 127.0.0.1 with an explicit Host header (lets tests act as any subdomain).
export function rawRequest(port, { method = "GET", path = "/", host = "localhost", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1", port, method, path,
      headers: { host: `${host}:${port}`, ...(data !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// Every file in migrations/<kind>/, in order: the same SQL the migration runner applies.
const schemaSql = (kind) => readdirSync(join(ROOT, "migrations", kind)).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(ROOT, "migrations", kind, f), "utf8")).join("\n");
export const vendorSchemaSql = () => schemaSql("vendor");
const latestVendorMigration = () => readdirSync(join(ROOT, "migrations", "vendor")).filter((f) => f.endsWith(".sql")).sort().at(-1);

// Starts the app with a control database and one database per vendor. Vendor n (1-based, in list order) is tenant n,
// binding DB_T<n>, host <slug>.localhost. Each vendor: { slug, name?, status? ("active"), users? ([admin]), seedSql? }.
// Broken setups, on purpose, for resolver tests:
//   bind: false              the registry has the database but the server config has no binding for it
//   databaseOf: "<slug>"     this vendor's binding points at another vendor's database
//   registryBinding: "DB_T1" tenants.db_binding tampered (the derived name is still DB_T<n>)
// The old single-vendor form startServer({ users, seedSql }) is one vendor, "demo".
export async function startServer({ users = [USERS.admin], seedSql = "", vendors } = {}) {
  vendors = (vendors ?? [{ slug: "demo", users, seedSql }]).map((v, i) => ({
    users: [USERS.admin], seedSql: "", status: "active", name: v.slug, bind: true, ...v, id: i + 1,
  }));
  const persistTo = mkdtempSync(join(tmpdir(), "venstock-test-"));
  const now = new Date().toISOString();
  const rows = vendors.map((v) => ({ ...v, db_name: localVendorDb(v.id).name, db_id: localVendorDb(v.id).id }));

  // Seeding writes the local database files directly, with the true wiring (every vendor in its own database).
  const sql = localSql(persistTo);
  const seed = (binding, text) => sql(binding, text, false);
  const latest = latestVendorMigration();
  seed("CONTROL", schemaSql("control") + "\n" + rows.map((v) => `INSERT INTO tenants
    (id, slug, name, status, db_binding, db_name, db_id, schema_version, created_at, status_changed_at) VALUES
    (${v.id}, ${sqlString(v.slug)}, ${sqlString(v.name)}, ${sqlString(v.status)}, ${sqlString(v.registryBinding ?? vendorBinding(v.id))},
     ${sqlString(v.db_name)}, ${sqlString(v.db_id)}, ${sqlString(latest)}, ${sqlString(now)}, ${sqlString(now)});`).join("\n"));
  for (const v of rows) {
    seed(vendorBinding(v.id), vendorSchemaSql() + "\n" +
      `INSERT INTO vendor_identity (singleton, tenant_id, slug, created_at) VALUES (1, ${v.id}, ${sqlString(v.slug)}, ${sqlString(now)});\n` +
      v.users.map(userInsertSql).join("\n") + "\n" + v.seedSql);
  }

  // The server's config: what the bindings would look like in a deploy, including any deliberate miswiring.
  const serverRows = rows.map((v) => ({
    ...v,
    db_id: !v.bind ? null : v.databaseOf ? rows.find((o) => o.slug === v.databaseOf).db_id : v.db_id,
  }));
  const config = join(persistTo, "wrangler.toml");
  const toml = renderConfig({ root: ROOT, outDir: persistTo, control: LOCAL_CONTROL, vendors: serverRows });
  writeFileSync(config, toml);

  const port = await freePort();
  const inspectorPort = await freePort();
  const [cmd, args] = serverCommand({ port, inspectorPort, persistTo, config });
  assertLocal(args);
  let log = "";
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  // Ready once wrangler answers at all (unknown or broken hosts legitimately answer 404 or 503).
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await rawRequest(port, { path: "/", host: `${rows[0].slug}.localhost` });
      break;
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      throw new Error(`server did not start (exit ${child.exitCode}). Log:\n${log.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    port,
    persistTo,
    configText: () => readFileSync(config, "utf8"),
    vendors: rows.map(({ id, slug, status }) => ({ id, slug, status, binding: vendorBinding(id), host: `${slug}.localhost` })),
    log: () => log,
    client: (host = `${rows[0].slug}.localhost`) => new Client(port, host),
    // Direct SQL on one database for assertions and setup (true wiring, whatever the server's config says).
    // SELECTs return rows; anything else runs and returns [].
    query(binding, text) {
      return /^\s*(select|with)\b/i.test(text) ? sql(binding, text) : (sql(binding, text, false), []);
    },
    async stop() {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

// A 6-digit code is valid for the previous, current and next 30-second step, and each step can be used once
// per user, so successive logins by the same user take successive steps.
const lastStep = new Map();
async function nextCode(user) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const step = Math.max(now - 1, (lastStep.get(user.email) ?? 0) + 1);
    if (step <= now + 1) { lastStep.set(user.email, step); return totpCode(user.totpSecret, step); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// HTTP client with one cookie jar, bound to one host.
export class Client {
  constructor(port, host) { this.port = port; this.host = host; this.cookies = {}; }
  async req(method, path, body, headers = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await rawRequest(this.port, { method, path, host: this.host, body, headers: { ...(cookie ? { cookie } : {}), ...headers } });
    for (const sc of [].concat(r.headers["set-cookie"] || [])) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (value === "" || /max-age=0\b/i.test(sc)) delete this.cookies[name]; else this.cookies[name] = value;
    }
    return r;
  }
  get(path) { return this.req("GET", path); }
  post(path, body = {}) { return this.req("POST", path, body); }
  put(path, body = {}) { return this.req("PUT", path, body); }
  del(path) { return this.req("DELETE", path); }
  // Password, then 6-digit code. Returns the final /api/auth/mfa response.
  async login(user) {
    const pw = await this.post("/api/auth/login", { email: user.email, password: user.password });
    if (pw.status !== 200) throw new Error(`login failed: ${pw.status} ${pw.text}`);
    const mfa = await this.post("/api/auth/mfa", { code: await nextCode(user) });
    if (mfa.status !== 200 || mfa.json?.stage !== "ok") throw new Error(`code step failed: ${mfa.status} ${mfa.text}`);
    return mfa;
  }
}
