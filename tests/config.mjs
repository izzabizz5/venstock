// The one setting the test harness has: how to start the app locally.
// Step 2 (Worker conversion) changes only this file; the tests themselves stay the same.
export function serverCommand({ port, persistTo }) {
  return ["npx", ["--no-install", "wrangler", "pages", "dev", "public",
    "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistTo]];
}

// How the local database is seeded before the server starts (always --local).
export function d1ExecuteCommand({ persistTo, file }) {
  return ["npx", ["--no-install", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", persistTo, `--file=${file}`]];
}
