---
name: connect-existing-tools
description: Connect a site's existing WebMCP tools to AgentLane without rebuilding them. Use when a codebase already registers document.modelContext tools — natively or through any SDK — and the developer wants them visible in AgentLane, migrated onto @nekuda/webmcp-sdk with durable stable keys and verified to behave exactly as before.
argument-hint: "[workspace path or site URL] [--non-interactive | --no-interactive-loop]"
---

# WebMCP Kit — connect-existing-tools

## Mission
- The site already has working agent tools. This skill does not design, expand, or rebuild them. It moves their **registration** onto `@nekuda/webmcp-sdk` so they keep behaving exactly as they do today, and connects the site so their activity is visible in AgentLane.
- Preserved, always: wire name, input schema, handler body, business logic, visible effect, and the pages and auth states each tool is available on. Changed: the registration layer only — `defineTool` + `registerTools` — plus the single tracking field Connect writes at the entry-module seam.
- The developer's repo is the source of truth. Every tool this skill connects is derived from what is already in that repo or already registered in the running site; nothing is invented from an idea of what the tools *should* be.
- Connecting is not what starts network activity. The SDK's anonymous observations are on by default once it is installed; connecting is what makes those observations *attributed* to this site's account.

## Hard rules
- **Registration layer only.** Never edit a handler, schema, endpoint, or UI effect to make a tool connectable. A tool that cannot be connected without changing its behavior is reported as such, not rewritten.
- **Read-only until approved.** Phases A–C touch no source file, add no dependency, and create no branch. The migration plan presented in Phase C is approved by the developer **before any of the developer's files is written**. That gate is the product, not a formality. Two named exceptions, and only these: the Phase-B baseline is written to `.webmcp/connect-existing-tools/baseline.json` — agent state, never the developer's code, and never part of the migration commit (the same `.webmcp/` carve-out the `implement` skill takes); and Phase B *invokes* tools to capture samples — read-only ones freely, state-changing ones only against a positively confirmed isolated environment, per `references/inventory.md`. Phase A's browser pass inspects and never invokes.
- **Byte-for-byte rollback.** On skip or on any failure, every entry module and every tool module is left exactly as it was found. A half-migrated tree is never a terminal state.
- **Named set, honest fallback.** Automated migration covers native `document.modelContext` / `navigator.modelContext` registrations and `@nekuda/webmcp-sdk` — including its legacy aliases `@agentlane/webmcp` and `@nekuda/webmcp`, which are the same SDK. Any other SDK, and any tool whose defining source cannot be located, is inventoried and reported as *needs manual migration*. Never guess a rewrite.
- **Identity is durable.** A `stableKey` already present in source is immutable — a re-run adopts what it finds and never renames it. A derived key follows `references/stable-keys.md`, and anything ambiguous is put to the developer as an explicit decision recorded in source, never silently picked.
- **Behavior is proven, not assumed.** A tool is connected only when the post-migration inventory matches the pre-migration one on names, schemas, invocation results, errors, availability, and visible effects — and when a real invocation is observed arriving attributed. Default anonymous traffic is not proof.
- **Local only.** Source analysis stays on this machine. Never send the developer's code, routes, or schemas to an external service or an unauthenticated tool. The optional Connect step sends only the CLI's structured project/account request.
- **Developer-facing wording.** In anything shown to the developer, never use the words *mint*, *token*, *scope*, *telemetry*, *API key*, or *origin*, and never echo CLI fields, error codes, or raw error prose. The banned *scope* is the OAuth sense; **registration scope** — this skill's own term for one entry module and the batches it registers — is the one carve-out, because the per-scope result this skill owes the developer (*migrated, not attributed*, per `references/migration.md`) cannot be stated without it. On a failure, say only that the connection did not finish, that the existing tools are unchanged, and that they may retry or skip.

## CLI runtime

Run the CLI from the installed plugin; never assume an executable is on `PATH`:

- **Claude Code:** `"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`
- **Codex:** `"${PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`

Use the form for the current host in every step. The CLI is reused as-is: this skill adds no auth or provisioning of its own.

## Session flow (A–E)

**A — Detect.** Load `references/detection.md`. Find every existing registration by source scan — native `document.modelContext` / `navigator.modelContext` calls, `@nekuda/webmcp-sdk` and its legacy aliases, and the recognizer list for known third-party SDK call shapes — then inspect the running site to catch anything registered dynamically. Classify each finding into one of four cases: already on this SDK, native, other SDK, or source unavailable. These sweeps are independent of each other: issue their Reads/Greps as one parallel batch, never one file per turn.

**B — Inventory.** Load `references/inventory.md`. Record, per tool: wire name, input schema, the pages and routes it is available on, the auth state it requires, and the handler's exact location. Browser-observed entries carry names and schemas only — a handler needs source. This inventory is the baseline Phase E diffs against, so it is captured before anything is written and never re-derived afterward from the migrated tree.

**C — Propose (hard gate).** Present one plan: which tools will be migrated, which are already fine, which need manual migration and why, the `stableKey` each tool will carry, and every file that will change. Tools needing a developer decision are listed with the specific question and a stated default. Nothing is written until the developer approves. In `--non-interactive` mode, take the stated defaults and use the Degrade path below.

**D — Migrate.** Load `references/migration.md` and `references/stable-keys.md` in one batch. Wrap each existing definition in `defineTool` with `name` set **explicitly** to the original wire name, move registration into `registerTools` batches at the entry-module seam, and leave the handler untouched. Tools already on this SDK need no code change at all — only the connection. Connect itself is not re-specified here: it defers to the `implement` skill's Connect flow — login, readiness gate, seam edit, and the rule that a non-interactive run skips it — whose exact file `references/migration.md` names. That flow covers **one** entry module, so a site with more than one registration scope runs it once per recorded entry module, under the one per-scope amendment `references/migration.md` states.

**E — Verify.** Load `references/verify-connection.md`. Re-run the inventory and diff it against the Phase-B baseline; prove the run is idempotent by confirming a second pass proposes zero changes; and prove one real invocation arrives **attributed**, not merely recorded. Every tool ends **connected**, **failed**, or **needs manual migration**.

**PR.** Branch `webmcp/connect-existing-tools`; conventional commit; open a PR (approved plan + per-tool result table as the body) via `gh` when available, else commit on the branch and hand over. Restate every needs-manual-migration tool and the reason in the summary.

## Entry and review mode
- Headless intent must be explicit: the `--non-interactive` flag in the invocation, or an equally explicit standing instruction in the request text. Never infer it from the environment.
- `--no-interactive-loop` → human, chat-only: present the Phase-C plan in the conversation and wait for explicit approval.
- `--non-interactive` → skip the approval gate per the Degrade path, and skip Connect entirely.
- If nobody answers the gate and no explicit non-interactive intent was given, stop. Inference may never skip the gate.

## Degrade paths
- `--non-interactive`, nobody to answer the Phase-C gate → take every stated default, skip Connect, and list in the report each default that was taken and the question it stood in for. The gate is not silently satisfied; it is deferred to the PR, which is why the approved plan is the PR body.
- No existing registrations found → say so and stop. This skill does not author new tools; that is the `implement` skill's job.
- Every finding is an unrecognized SDK or has no locatable source → the inventory plus an honest *needs manual migration* report is a legitimate terminal outcome. Deliver it and say why; do not guess rewrites to have something to ship.
- No runnable browser → migrate what the source proves, mark the runtime half of Phase E unverified, and say which claims are unproven.
- Connect declined or unavailable → the migration still stands on its own. Leave the tools migrated and unconnected, and say that re-running the connection is the way to finish.

## Environment
- If the working directory ships its own site runbook (lifecycle commands, base URL, test identities), use it for boot and reset; otherwise use the repo's own scripts. Never assume a harness exists.
- Browser inspection needs WebMCP active — the same requirement and recipe the `verify` skill states.
