// What a support session's browser may receive. The read-only database already refuses to read account secrets; this
// is the second lock, on the way out: JSON responses lose every key that could help take over an account, and any
// string that looks like an authenticator setup link. CSV exports carry no account data (tested).
const SECRET_KEYS = new Set(["password_hash", "password", "totp_secret", "secret", "uri", "invite", "invite_hash", "invite_code",
  "token", "token_hash", "code", "code_hash", "session_id", "cookie"]);

export function redactValue(v) {
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (!SECRET_KEYS.has(k.toLowerCase())) out[k] = redactValue(val);
    return out;
  }
  if (typeof v === "string" && /^otpauth:/i.test(v)) return "[redacted]";
  return v;
}

export async function redactForSupport(res) {
  if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
  const data = await res.clone().json().catch(() => undefined);
  if (data === undefined) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("set-cookie"); // a support session never receives a vendor login cookie
  return new Response(JSON.stringify(redactValue(data)), { status: res.status, headers });
}
