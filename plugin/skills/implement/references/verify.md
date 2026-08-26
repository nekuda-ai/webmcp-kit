# Verify — the runtime ladder (three visible states)

Shared by the `verify` skill and `implement` Phase F. Every tool ends in exactly one state: **verified** (which rung), **failed** (fix or drop — never ship known-broken), **could-not-verify** (ships flagged). Failed blocks the PR; could-not-verify does not.

## Environment & surface
- Use the working directory's own runbook (lifecycle commands, base URL, test identities — e.g. an eval capsule) if it ships one; otherwise the repo's own scripts. Never assume a harness exists.
- Use the plugin-owned browser CLI. On Unix resolve it without host bias:
  ```sh
  plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
  if [ -z "$plugin_root" ]; then
    skill_dir="<absolute base directory for this skill>"
    plugin_root="$(cd "$skill_dir/../.." && pwd -P)"
  fi
  webmcp="${plugin_root}/scripts/webmcp.sh"
  "$webmcp" browser status
  ```
  The base directory is the host-shown directory containing the active skill's `SKILL.md`; do not guess from the repository checkout. On Windows use `$env:CLAUDE_PLUGIN_ROOT`, then `$env:PLUGIN_ROOT`, then `(Resolve-Path "<absolute base directory for this skill>\..\..").Path`, and run `scripts\webmcp.cmd`. Do not ask for MCP configuration, a global CLI, Playwright, or manual driving.
- Run `status`, then `start` once. The entry resolves `chrome-devtools-mcp@latest` and owns a host-session-scoped isolated/headless Chrome 150+, `--category-experimental-webmcp` / `--enable-features=WebMCP` flags, privacy flags, safe executable discovery, and cached Chrome for Testing fallback on platforms Chrome for Testing publishes. Set `WEBMCP_BROWSER_SESSION_ID` to any unique value for concurrent runs in one workspace; otherwise the entry scopes by the Claude/Codex session when available, then the workspace. On unsupported hosts such as Linux arm64, provide native Chrome/Chromium 150+ through `WEBMCP_BROWSER_PATH`. Use JSON output for page/tool commands; batch the ladder by page; inspect console and network; always `stop` in cleanup.
- If startup reports a Node/npm, browser download, architecture, shared-library, or launch error, preserve the exact cause and mark browser-dependent tools **could-not-verify**. Never use `sudo`, a system package manager, or a normal Chrome profile. An interrupted run recovers with `status` then `stop` before one retry.

## Baseline first (before touching anything)
Record whether the repo **already** typechecks/builds/boots cleanly. Capturing this is read-only, so don't leave it on the critical path: in `implement`, start the static half (typecheck/build) as a background task during Phases A–C while the repo is being read, and record the boot half when the pre-warmed dev server first comes up (rung 2) — before any entry-module wiring lands. By approval time the whole baseline is already known. If the baseline is already broken, do not attribute it to your change and do not edit unrelated code to fix it — report it and mark affected tools could-not-verify.

## Ladder
1. **Static** — the repo's own typecheck/lint/build pass (relative to the recorded baseline). Run it after your **first** Phase-E write (and after the background dependency install completes — unresolved SDK imports before that are the install in flight, not a failure; `references/codegen.md`), not only once every file is written, so a turn-budget cutoff still lands at least one static pass; re-run after the last write. Per-tool feedback comes from a **watch-mode** typechecker started as a background task at the first write (`tsc --noEmit --watch` or the repo's equivalent) plus lint scoped to the files just written — the full pass runs once after the last write, never once per tool. A new failure your change introduced → **failed**.
2. **Boot** — dev server starts; the baseline page renders; **no new console errors** versus the clean baseline load. Don't cold-start here: launch the dev server as a background task as soon as writes are approved and warm the declared pages by loading them, so this rung is a health check against a server already up rather than the longest wait on the critical path. Can't boot and the baseline booted → failed; baseline couldn't boot → could-not-verify.
3. **Registration** — on each declared page and auth state (check anonymous **and** signed-in where relevant), confirm each tool registers where it should, is **absent** where it should not (logged-out account tools, wrong-role tools), and unregisters on its declared exits (empty cart, logout). Navigation is the expensive unit: visit each declared page × auth state **once**, list its registered tools once, and settle every tool's presence/absence expectation for that page in that single pass — never one navigation per tool; auth states may run as parallel browser contexts where the driver supports it. No WebMCP surface, or CSP blocks the polyfill → could-not-verify (not failed).
4. **Read-only invocation** — call read-only tools with sample inputs; check the returned data **and** the visible ui_effect. Batch by page: invoke every read-only tool living on a page in the visit that verified its registration. **If the plan has no state-changing tools, the ladder ends here** — thin-content / read-only sites verify at this rung; never invent a mutation to "complete" the ladder.
5. **State-changing invocation** — **precondition (hard):** the target must be a confirmed isolated environment — dev/local/seeded data, a test account, a non-production endpoint. If you cannot positively confirm isolation, **refuse this rung and mark the tool could-not-verify.** Never fire a write at a production or third-party service. When you do invoke, confirm the write by **persisted state** — a readback, DB/count delta, or a durable visible change — not an HTTP 2xx or a navigation alone (an accepted request can still fail async). For an irreversible/cost-bearing tool designed to stop at a reversible handoff (see `references/codegen.md`), verify only that the handoff state was created — never drive the payment/confirm step.

## Report
A per-tool table of the state reached and the rung. Restate could-not-verify items and any needs-developer-wiring journeys (no safe client path — not generated, never faked). In `implement`, this table becomes part of the PR body.
