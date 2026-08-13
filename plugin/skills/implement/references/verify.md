# Verify — the runtime ladder (three visible states)

Shared by the `verify` skill and `implement` Phase F. Every tool ends in exactly one state: **verified** (which rung), **failed** (fix or drop — never ship known-broken), **could-not-verify** (ships flagged). Failed blocks the PR; could-not-verify does not.

## Environment & surface
- Use the working directory's own runbook (lifecycle commands, base URL, test identities — e.g. an eval capsule) if it ships one; otherwise the repo's own scripts. Never assume a harness exists.
- WebMCP must be active in the browser: **Chrome 150+ with the WebMCP flag** (`chrome://flags`, enabled for localhost) — the current surface is `document.modelContext`. On **Chrome 149** the only surface is the legacy `navigator.modelContext`. As a backup, load `@mcp-b/webmcp-polyfill`. The generated code never detects this itself — the SDK resolves whichever surface exists; here you only confirm one is present.
- Browser automation is tool-agnostic: a chrome-devtools MCP, a CLI driver, or a guided manual check.

## Baseline first (before touching anything, in Phase F)
Record whether the repo **already** typechecks/builds/boots cleanly. If the baseline is already broken, do not attribute it to your change and do not edit unrelated code to fix it — report it and mark affected tools could-not-verify.

## Ladder
1. **Static** — the repo's own typecheck/lint/build pass (relative to the recorded baseline). Run it after your **first** Phase-E write, not only once every file is written, so a turn-budget cutoff still lands at least one static pass; re-run after the last write. A new failure your change introduced → **failed**.
2. **Boot** — dev server starts; the baseline page renders; **no new console errors** versus the clean baseline load. Can't boot and the baseline booted → failed; baseline couldn't boot → could-not-verify.
3. **Registration** — on each declared page and auth state (check anonymous **and** signed-in where relevant), confirm each tool registers where it should, is **absent** where it should not (logged-out account tools, wrong-role tools), and unregisters on its declared exits (empty cart, logout). No WebMCP surface, or CSP blocks the polyfill → could-not-verify (not failed).
4. **Read-only invocation** — call read-only tools with sample inputs; check the returned data **and** the visible ui_effect. **If the plan has no state-changing tools, the ladder ends here** — thin-content / read-only sites verify at this rung; never invent a mutation to "complete" the ladder.
5. **State-changing invocation** — **precondition (hard):** the target must be a confirmed isolated environment — dev/local/seeded data, a test account, a non-production endpoint. If you cannot positively confirm isolation, **refuse this rung and mark the tool could-not-verify.** Never fire a write at a production or third-party service. When you do invoke, confirm the write by **persisted state** — a readback, DB/count delta, or a durable visible change — not an HTTP 2xx or a navigation alone (an accepted request can still fail async). For an irreversible/cost-bearing tool designed to stop at a reversible handoff (see `references/codegen.md`), verify only that the handoff state was created — never drive the payment/confirm step.

## Report
A per-tool table of the state reached and the rung. Restate could-not-verify items and any needs-developer-wiring journeys (no safe client path — not generated, never faked). In `implement`, this table becomes part of the PR body.
