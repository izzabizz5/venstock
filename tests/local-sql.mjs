// Direct SQL on the throwaway local databases tests create (no wrangler process per query; see scripts/lib/local-d1.mjs).
// Bindings map to local database ids the same way the scripts name them: CONTROL -> local-control, DB_T<n> -> local-t<n>.
import { localRun, localQuery } from "../scripts/lib/local-d1.mjs";
import { LOCAL_CONTROL, localVendorDb } from "../scripts/lib/wrangler-config.mjs";

export function localDatabaseId(binding) {
  if (binding === "CONTROL") return LOCAL_CONTROL.id;
  const m = /^DB_T(\d+)$/.exec(binding);
  if (!m) throw new Error(`unknown binding ${binding}`);
  return localVendorDb(Number(m[1])).id;
}

// sql(binding, command): rows of a SELECT; sql(binding, command, false): runs statements, returns null.
export const localSql = (persistTo) => (binding, command, json = true) =>
  json ? localQuery(persistTo, localDatabaseId(binding), command) : (localRun(persistTo, localDatabaseId(binding), command), null);
