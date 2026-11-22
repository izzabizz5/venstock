// The repo's wrangler.toml put into a known state for a test, whatever launch settings the real file holds
// (pre-launch: BASE_DOMAIN = "localhost", no routes, CONTROL id "<>"; at launch the user sets all three).
// Tests that check refusals or run scripts against a copy build their wrangler.toml here, never by editing the
// real file's text in place: once the real file carries production values, such edits silently match nothing.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function replaceOnce(text, re, to, what) {
  if (!re.test(text)) throw new Error(`tests/wrangler-toml.mjs: wrangler.toml has no ${what}`);
  return text.replace(re, to);
}

// domain: BASE_DOMAIN; routes: add the wildcard route for it (default: yes unless localhost); controlId: CONTROL's
// database_id ("<>" is the placeholder every remote command refuses).
export function tomlFor({ domain = "localhost", routes = domain !== "localhost", controlId = "<>" } = {}) {
  let t = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  t = t.replace(/^\[\[routes\]\]\n(?:(?:pattern|zone_name|custom_domain) = [^\n]*\n)*/gm, "");
  if (/^\s*\[\[routes\]\]/m.test(t)) throw new Error("tests/wrangler-toml.mjs: could not remove wrangler.toml's [[routes]]");
  const route = routes ? `\n\n[[routes]]\npattern = "*.${domain}/*"\nzone_name = "${domain}"` : "";
  t = replaceOnce(t, /^BASE_DOMAIN = "[^"]*"$/m, `BASE_DOMAIN = "${domain}"${route}`, "BASE_DOMAIN line");
  t = replaceOnce(t, /(binding = "CONTROL"\ndatabase_name = "venstock-dev-control"\ndatabase_id = )"[^"]*"/,
    `$1"${controlId}"`, "CONTROL block (binding, database_name venstock-dev-control, database_id)");
  return t;
}
