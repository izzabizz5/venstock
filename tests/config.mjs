// The one setting the test harness has: how to start the app locally.
// Step 2 (Worker conversion) changes only this file; the tests themselves stay the same.
// inspectorPort: each test server needs its own, or servers started in parallel clash.
export function serverCommand({ port, inspectorPort, persistTo }) {
  return ["npx", ["--no-install", "wrangler", "dev",
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", persistTo]];
}

// How the local database is seeded before the server starts (always --local).
export function d1ExecuteCommand({ persistTo, file }) {
  return ["npx", ["--no-install", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", persistTo, `--file=${file}`]];
}
