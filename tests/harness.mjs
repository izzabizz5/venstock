// Test harness: starts the app on a throwaway local database, seeds users, and gives tests an HTTP client
// that keeps cookies and can log in with password + 6-digit code. No dependencies; local only.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request as httpRequest } from "node:http";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { totpCode } from "../src/lib/auth.js";
import { serverCommand, d1ExecuteCommand } from "./config.mjs";

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

function runLocal(cmd, args) {
  assertLocal(args);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// The vendor schema: every file in migrations/vendor/, in order (schema.sql is gone; migrations are the source).
export const vendorSchemaSql = () => readdirSync(join(ROOT, "migrations", "vendor")).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(ROOT, "migrations", "vendor", f), "utf8")).join("\n");

// Starts the app on a fresh local database (the vendor schema), then `users`, then `seedSql`.
export async function startServer({ users = [USERS.admin], seedSql = "" } = {}) {
  const persistTo = mkdtempSync(join(tmpdir(), "venstock-test-"));
  const seedFile = join(persistTo, "seed.sql");
  writeFileSync(seedFile, vendorSchemaSql() + "\n" + users.map(userInsertSql).join("\n") + "\n" + seedSql);
  runLocal(...d1ExecuteCommand({ persistTo, file: seedFile }));

  const port = await freePort();
  const inspectorPort = await freePort();
  const [cmd, args] = serverCommand({ port, inspectorPort, persistTo });
  assertLocal(args);
  let log = "";
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await rawRequest(port, { path: "/" });
      if (r.status === 200) break;
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
    log: () => log,
    client: (host = "localhost") => new Client(port, host),
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
