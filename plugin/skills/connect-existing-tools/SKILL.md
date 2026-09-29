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
- **Behavior is proven, not assumed.** A tool is connected only when the post-migration inventory matches the pre-migration one on names, schemas, invocation results, errors, availability, and visible effects — and when a real invocation is observed arriving attributed. A connection-only tool (already on this SDK, nothing to migrate) has no before/after diff; it needs its route × auth-state registration matrix and one safe attributed call per recorded entry module. Default anonymous traffic is not proof.
- **Local only.** Source analysis stays on this machine. Never send the developer's code or routes to an external service, and never send anything to an unauthenticated tool. The optional Connect step sends only the CLI's structured project/account request; the separately approved publish step that follows it sends the approved tool descriptions and input schemas, and no handler body or credential.
- **Developer-facing wording.** In anything shown to the developer, never use the words *mint*, *token*, *scope*, *telemetry*, *API key*, or *origin*, and never echo CLI fields, error codes, or raw error prose. The banned *scope* is the OAuth sense; **registration scope** — this skill's own term for one entry module and the batches it registers — is the one carve-out, because the per-scope result this skill owes the developer (*migrated, not attributed*, per `references/migration.md`) cannot be stated without it; keep it out of progress messages and decision summaries. On a failure, say only that the connection did not finish, that the existing tools are unchanged, and that they may retry or skip. Beyond those words, lead with what the developer is trying to achieve, not implementation terms. Explain the SDK once as “the library that connects your tools to AgentLane.” Say “saved test results” for baseline, “checking that rerunning makes no extra changes” for idempotency, and “confirming activity appears in your account” for attribution. File paths, `stableKey` values, and other technical identifiers belong in the separate code-review details. Never expose sensitive values.

## CLI runtime

Run the CLI from the installed plugin; never assume an executable is on `PATH`:

- **Claude Code:** `"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`
- **Codex:** `"${PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`

Use the form for the current host in every step. The CLI is reused as-is: this skill adds no auth or provisioning of its own.

## Explain the journey

In the first user-facing message after reading this skill, show the goal, a short numbered journey, and what you are starting now. Do not leave the journey only in an internal plan or replace it with “I'll inspect and propose a migration.” Adapt the example to the actual request: omit completed or skipped work; for a local-only test, say once that AgentLane connection is being skipped.

> The goal is to see your existing tools and their activity in AgentLane.
>
> 1. **Check your tools.** Find them and test what they do today.
> 2. **Explain any changes.** Show you what needs updating and why, before editing.
> 3. **Apply and test.** Make the approved changes and check the tools again.
> 4. **Connect to AgentLane.** Help you choose the account and project, if you want to connect.
> 5. **Check the result.** Show what arrived and explain your next step.
>
> **Starting now:** I'll inspect your site. You don't need to do anything yet.

Phase letters below organize the agent's work; do not announce “Phase A/B/C” to the developer. If no migration is needed, say so and skip those steps rather than narrating them as work. Do not front-load hypothetical approvals or a safety checklist. Explain a data-changing test only if one is actually needed, with its effect and required permission. Reuse existing authorization for the same concrete action; do not ask again just to advance a step.

At each transition, give the result, the next action, and the expected outcome in at most three short sentences. Example, only when observed: **“Both tools work: searching for ‘lamp’ found Aurora task lamp, and the reservation list is empty. Next I'll show you the changes needed to connect them. You don't need to do anything until that review is ready.”** Attribute browser-tool evidence as required by the host, after the plain explanation. Keep baseline paths, stable keys, and idempotency in technical details rather than narrating bookkeeping. If blocked, explain what prevents progress and recommend one next action.

During long work, report completed/total pages or tools when known and name the current check. Explicitly say when the developer needs to act; otherwise say you are continuing. Do not estimate a duration or invent a countdown. Measured elapsed time or actual counts are fine.

## Session flow (A–E)

**A — Detect.** Load `references/detection.md`. Find every existing registration by source scan — native `document.modelContext` / `navigator.modelContext` calls, `@nekuda/webmcp-sdk` and its legacy aliases, and the recognizer list for known third-party SDK call shapes — then inspect the running site to catch anything registered dynamically. Classify each finding into one of four cases: already on this SDK, native, other SDK, or source unavailable. These sweeps are independent of each other: issue their Reads/Greps as one parallel batch, never one file per turn.

After detection, report the actual tool and page counts, whether changes are needed, and why. Keep the registration-scope count in the technical inventory. Example: **“Found 9 tools across 4 pages. They already use the connection library, so I can check their AgentLane connection now.”**

**Connection-only fast path.** Take this path only when at least one source-backed registration exists, every source-backed registration is case 1, and no case-2 migration is needed. Cases 3 or 4 remain in the report but can never trigger this path by themselves. Do not run the migration baseline/sample/diff cycle or Phase C's migration approval. Check the current source and configuration; record the relevant route × auth-state registration matrix and exact entry modules. Load `references/migration.md`, including its multi-scope amendment and the shared Connect reference it requires. If tracking needs an entry-module edit, name every current path before writing. Reuse an explicit choice from this session when it already covers those exact paths and the same tracking change; otherwise present the normal optional Connect decision. A saved connection file is configuration, not approval. A healthy connection whose current source needs no edit is reused without asking again. Then run Connect once per registration scope.

Verify every batch received the intended current configuration and observe one safe accepted call per recorded entry module. A healthy saved connection skips provisioning only: reload the recorded route/auth matrix, recheck the current configuration, and collect fresh runtime evidence. Prefer a read-only tool; use a state-changing tool only in a positively confirmed isolated environment. If no safe call exists, do not invoke one: keep the verified configuration, mark runtime attribution unverified, and report the limitation. Finish through the reporting rules below.

**B — Inventory.** Load `references/inventory.md`. Record, per tool: wire name, input schema, the pages and routes it is available on, the auth state it requires, and the handler's exact location. Browser-observed entries carry names and schemas only — a handler needs source. This inventory is the baseline Phase E diffs against, so it is captured before anything is written and never re-derived afterward from the migrated tree.

**C — Propose (hard gate).** Prepare the exact proposed diff before asking. Lead with four short numbered items, one sentence each: (1) what works today, (2) why this site needs a change, (3) what will change and its implications, and (4) how you will check it afterward. Explain migration as “updating how your existing tools connect.” Include relevant effects such as installing the library and its default anonymous reporting; connecting later associates activity with the chosen AgentLane project. Keep actual compatibility differences and unresolved choices in this plain summary: tools needing a developer decision are listed with the specific question and a stated default. Do not promise zero behavior changes before verification.

Keep the exact diff and file details in a separate **Code review details** section or a linked, readable review. Include which tools change, which are already fine, which cannot be migrated automatically and why, their `stableKey` values, and every affected file. Show each fact once: prefer the existing review link; otherwise show a focused diff in chat without also repeating it as replacement modules and multiple tables. The developer must be able to understand the decision from the short summary and inspect the exact changes before approving.

End with one concrete question such as **“May I update these two tools to use the connection library, then test them again?”**, not an unexplained “Approve migration?”. If a host requires the approval rule's source, link and quote it in one short separate paragraph after the question. Approval and those decisions are collected per the `implement` skill's `decisions.md`. Nothing is written until the developer approves. In `--non-interactive` mode, take the stated defaults and use the Degrade path below.

**D — Migrate.** Load `references/migration.md` and `references/stable-keys.md` in one batch. Wrap each existing definition in `defineTool` with `name` set **explicitly** to the original wire name, move registration into `registerTools` batches at the entry-module seam, and leave the handler untouched. Tools already on this SDK need no code change at all — only the connection. Do not start optional Connect during this phase.

**E — Verify migration before Connect.** Load `references/verify-connection.md`. Re-run the inventory and diff it against the Phase-B baseline, then prove the run is idempotent by confirming a second pass proposes zero changes. If either check fails, restore every migration edit per the rollback rule before any optional Connect attempt. This check finishes before any connection configuration is written.

**Optional Connect — only after Phase E.** Connect itself is not re-specified here: it defers to the `implement` skill's Connect flow — login, readiness gate, seam edit, and the rule that a non-interactive run skips it — whose exact file `references/migration.md` names. That flow covers **one** entry module, so a site with more than one registration scope runs it once per recorded entry module, under the one per-scope amendment `references/migration.md` states. The same file's publish offer applies here unchanged, once per recorded entry module: the migrated tools' descriptions — never their handlers, and never a credential — become the site's catalog, so a tool is listed before anything calls it. After configuration, prove one safe real invocation per recorded entry module arrives **attributed**, not merely recorded. Every tool ends **connected**, **failed**, or **needs manual migration**; when no safe call exists, keep it configured and out of **connected**.

**Finish.** Give one short evidence-based report: what changed, what was verified locally, what remains unknown (especially production), and one next action. When Connect finished healthy, hand over the dashboard exactly as the `implement` skill's Connect flow's hand-over step says. Its **View tools in AgentLane** link is built from the origin of `dashboard_url` plus `/tools?domain=<domain id>`, never copied from the browser's address bar: the dashboard drops `?domain=` once it has selected the project, so a copied address opens whichever project the viewer last selected. If source changed, review/merge or deployment is a later action only when it fits the developer's goal; a disposable practice run ends with reviewing its test result, not a deployment instruction. Link an actual PR only when one exists. Never treat local registration, configuration, or an accepted transport call as proof that production is deployed or dashboard processing has completed.

**PR, only when source changed.** Branch `webmcp/connect-existing-tools`; conventional commit; open a PR (approved plan + per-tool result table as the body) via `gh` when available, else commit on the branch and hand over. Restate every needs-manual-migration tool and the reason in the summary, and — when Connect finished healthy — the dashboard links from the `implement` skill's Connect flow's hand-over step.

## Entry and review mode
- Headless intent must be explicit: the `--non-interactive` flag in the invocation, or an equally explicit standing instruction in the request text. Never infer it from the environment.
- `--no-interactive-loop` → human, chat-only: present the Phase-C plan in the conversation and collect approval per the `implement` skill's `decisions.md`.
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
