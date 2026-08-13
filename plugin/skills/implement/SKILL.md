---
name: implement
description: Add WebMCP tools to a website codebase so browser agents can act through the site's own logic instead of scraping the page. Use when asked to make a site agent-ready, add WebMCP or document.modelContext tools, or implement site tools with @nekuda/webmcp-sdk.
argument-hint: "[request] [--non-interactive | --no-interactive-loop]"
---

# WebMCP Kit — implement

## Mission
- WebMCP hands a browser agent typed tools (via the `@nekuda/webmcp-sdk` SDK) so it answers from the site's own content and acts through the site's own logic. User and agent share the visible page — every tool produces a visible effect.
- Tools answer "what will a visitor ask, and ask for, here?" — journeys, never REST-endpoint wrappers.
- In every human-facing run, the plan you present in Phase D is approved by the developer **before any file is written**. That gate is the product, not a formality.

## Hard rules
- **Local only.** Never send customer code, routes, or schemas to any external or unauthenticated tool/API. The tool-selection rubric is this skill's text — there is no hosted scanner.
- **Client-reachable wiring only.** `execute` may use the app's own client data layer, same-origin routes, or client-safe actions — never server-only imports, secrets, third-party endpoints, or DOM-scraping when a data path exists.
- **Flag, don't fake.** A journey with no safe client path is listed as *needs developer wiring* — never invented data or a dead call. A guidance-only stub does not "cover" a must-have.
- **Irreversible/cost-bearing writes need a boundary.** A payment, cancellation, or delete must not complete in one agent call. The generated tool stops at a reversible handoff — creates the repo-native pending state (checkout session, pending order, prepared cancellation) and hands the final step to the app's own payment/confirm UI, or uses a prepare→confirm two-call shape. A consequence sentence in the description is not a boundary.
- **Authorization is the server's job.** Registration gating on auth/role is UX, not security. Only wrap a privileged mutation whose route independently enforces authn/authz server-side; an endpoint that trusts a hidden client button is *needs developer wiring*, not a tool.
- **Nothing before approval.** No branch, file, or dependency until the developer approves the plan, except in explicit `--non-interactive` mode. This skill reads with Read/Grep/Glob during A–C; after approval it requests the write, package-manager, and browser permissions it needs through the normal permission prompts — nothing is pre-authorized.
- **SDK only.** Generated code imports `defineTool` / `registerTools` from the SDK under its resolved name (the installed package's declared name — `references/sdk.md`); never the raw `modelContext` surface, never a bundled polyfill/shadow. The SDK pins the spec, resolves whichever surface the browser exposes, and no-ops when unsupported.

## Session flow (A–F)

**A — Understand the repo** (cheap-first). Stack ID from manifests (`package.json`, `composer.json`, …): framework, rendering mode (SPA/SSR/MPA/static), router, language, package manager, and whether a JS bundler/dependency install even exists (a PHP/static MPA may have none — see `references/codegen.md`). Read high-signal sources before app code: README, `openapi.yml`/swagger, route manifests (`app/`, `pages/`, routes files), sitemap, nav, homepage CTAs. Map the visitor surface — routes→pages, forms, data-layer calls, auth boundaries — recording for each: file, what it does, client-reachable or server-only. **Inventory any existing `@nekuda/webmcp-sdk` usage — including its legacy aliases `@agentlane/webmcp` and `@nekuda/webmcp`, the same SDK** (`defineTool` names and `stableKey`s) so a re-run preserves identity instead of churning it. No stack is privileged (Next.js is not pre-decided); read deeper only where a candidate tool's wiring stays ambiguous.

**B — Select journeys/tools.** Load `references/journeys.md`. Match the repo to a category by `applies_when` → primary (+ secondary with the hybrid downgrade). **No match → tell the customer; never draft against the nearest category.** Simulate a concrete visitor on concrete pages: the questions they ask and actions they request are the spec. Instantiate the matched template's must-haves to this repo's real domain objects, content, and CTAs (a "book a demo" site gets `book_demo`, not `request_quote`). `ask_site` wherever the site has visitor-facing content to answer from — one instance; if there is genuinely none (e.g. an auth-only internal dashboard that matches no category), don't fabricate a content bundle, say so. Stay in the category's count band and global 3–10; thin-content sites get `ask_site` and stop. Fix availability, context, response, and annotations per tool.

**C — Pick the wiring.** Load `references/wiring.md`. For each tool take the highest safe rung (client data layer > same-origin route > client action > content bundle) and name the concrete path. Confidence rule: a tool is **decided** only if its journey is a category must-have AND a rung-1/2 path exists with corroborating evidence (route + handler + UI element agree). Anything else — ambiguous semantics, competing flows, great-to-haves, uncertain category — is **needs your input** with a specific question and a stated default.

**D — Review the plan (hard gate).** Load `references/plan-template.md`. Open every human-facing review with a short summary, identical in substance across entry modes, of what the skill will do and which tools it will create; on the loop path, put it in the chat message that points the developer to the Explorer. Then present the plan in the selected review surface **before touching any file**; tool descriptions ship verbatim (description is the product). Edits → revise → re-present. Proceed only on explicit approval. In `--non-interactive` mode, use the stated defaults and Degrade path instead.

**E — Generate.** Load `references/codegen.md`. Load `references/sdk.md` for the exact SDK surface and wiring. Add the SDK dependency the way `references/sdk.md` prescribes; emit the two-module shape as **separate files** — side-effect-free tool modules (`defineTool` at module scope, never inside a component/effect) plus one entry module per registration scope. `stableKey` is `domain.action`, authored once and **never changed on re-runs** (reuse any inventoried in Phase A; never a copy of the wire `name`) — `name` may change freely. Each `description` states what it does, **when to use it**, and what it returns; `inputSchema` sets `additionalProperties: false`. `execute` runs the Phase-C path verbatim and **throws on failure or missing anchors/data** (never succeed-on-missing) — a read that finds nothing is not a failure: it still returns, with the empty result plus an explicit note field saying the site has no matching content, never a bare empty array. Match the repo's language, lint/format config, and file conventions. **If an approved call path proves unusable or the implementation must deviate from the approved plan** (different endpoint, changed behavior or coverage), stop and re-present the change — never silently substitute under a stale approval. Start Phase F's static checks (typecheck/lint/build) after this first write, not only once every file is written — a turn-budget cutoff should still land at least one static pass.

**F — Verify.** Load `references/verify.md`. Run the ladder: static → boot → registration on declared pages/auth states → read-only invocation → state-changing only on seeded/dev data with consent. Every tool ends **verified**, **failed**, or **could-not-verify**. Failed blocks the PR (fix or drop — never ship known-broken); could-not-verify ships flagged.

**PR.** Branch `webmcp/tools-v0`; conventional commit; open a PR (approved plan + per-tool verification table as the body) via `gh` when available, else commit on the branch and hand over. Restate could-not-verify items and needs-developer-wiring journeys in the summary.

## Entry and review mode
- Headless intent must be explicit: the `--non-interactive` flag in the invocation or an equally explicit standing instruction in the request text (for example, "proceed without approval" or "non-interactive") counts as that flag. Never infer it from the environment (no TTY sniffing or "seems headless"). A request to reopen or continue an existing run (a `.webmcp/` folder with state) → see **Resume**. A request with neither loads `references/interactive.md` and runs D–F as an interactive browser loop over the git-tracked state folder `.webmcp/` — UI phases propose → build → review → verify → done: approval starts `verify`, and `done` starts only after the PR exists. If the loop is not already running, Claude may offer to start it.
- Developer declines the browser loop → continue as `--no-interactive-loop` with chat-only review.
- `--no-interactive-loop` → human, chat-only: show the Phase-D summary and plan in chat, then wait for explicit approval. Do not start the browser loop.
- `--non-interactive` → explicit headless: skip the browser loop and use the gate-free Degrade path below.
- If nobody answers the gate and no explicit non-interactive intent was given, stop; inference may never skip the gate.

## Resume
- When asked to reopen or continue a run, read `<port>` from `.webmcp/.port` and `GET http://localhost:<port>/healthz`; if it answers `webmcp-explorer`, reprint `http://localhost:<port>`, then if this session has no armed Monitor for that port, arm one per `references/interactive.md` Startup step 4 and read the tail of `_feedback.ndjson` for unrelayed events before continuing from the last recorded phase.
- If `.port` is missing or unreadable, or the server is dead, follow **Recovery** in `references/interactive.md` against the existing `.webmcp/`, reprint the restarted server's URL, then continue from the last phase in `_status.ndjson`.
- This works whether the original agent session is alive or a fresh one handles the request — the files carry everything.

## Degrade paths
- No category match → say so; do not force a weak fit.
- Most must-haves unwireable → **proposal-only** is a legitimate terminal outcome: deliver the reviewed plan, no code, and say why. That is benchmark signal, not failure.
- Explicit `--non-interactive` → proceed automatically: record the plan verbatim as the PR body/summary, implement each needs-your-input item on its stated default, and restate each in the summary as an assumption — the question, the default taken, and why.
- No runnable browser → mark tools could-not-verify and still ship plan-conformant code.

## Environment
- If the working directory ships its own site runbook (lifecycle commands, base URL, test identities — e.g. an eval capsule), use it for boot/reset; otherwise use the repo's own scripts. Never assume a harness exists.
- Browser verification needs WebMCP active: Chrome 150+ flag or `@mcp-b/webmcp-polyfill` — recipe in `references/verify.md`.
