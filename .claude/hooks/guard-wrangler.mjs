// PreToolUse hook for Bash: blocks wrangler commands that could touch anything remote.
// Backs up the deny rules in .claude/settings.json, and adds the one check deny rules can't express:
// `wrangler d1 execute` / `wrangler d1 export` must say --local.
// Reads the hook JSON on stdin; prints a "deny" decision or nothing (= no opinion).
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cmd = "";
  try { cmd = JSON.parse(input).tool_input?.command || ""; } catch { return; }

  // "wrangler" as a word being run (start, after whitespace, or after ; & |), not inside quotes or a path.
  const wr = String.raw`(?:^|[\s;&|])wrangler\s+`;
  const rules = [
    [/(?:^|\s)--remote\b/, "--remote is not allowed in this project"],
    [new RegExp(wr + String.raw`.*--preview\b`), "--preview targets a remote database"],
    [new RegExp(wr + String.raw`(?:deploy|publish|versions\s+(?:deploy|upload)|pages\s+deploy)\b`), "deploys are not allowed"],
    [new RegExp(wr + String.raw`d1\s+(?:create|delete|list|info|time-travel|migrations\s+apply)\b`), "this d1 command talks to Cloudflare"],
  ];
  let reason = rules.find(([re]) => re.test(cmd))?.[1];
  if (!reason && new RegExp(wr + String.raw`d1\s+(?:execute|export)\b`).test(cmd) && !/(?:^|\s)--local\b/.test(cmd)) {
    reason = "wrangler d1 execute/export must include --local";
  }
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked by .claude/hooks/guard-wrangler.mjs: ${reason}. See CLAUDE.md rules.`,
    },
  }));
});
