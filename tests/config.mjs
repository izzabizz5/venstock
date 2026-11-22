// The one setting the test harness has: how to start the app locally.
// The tests themselves don't change when this does.
// inspectorPort: each test server needs its own, or servers started in parallel clash.
// config: the generated wrangler config (CONTROL + one DB_T<id> per vendor) the harness writes for this server.
export function serverCommand({ port, inspectorPort, persistTo, config }) {
  return ["npx", ["--no-install", "wrangler", "dev", "-c", config,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", persistTo]];
}
