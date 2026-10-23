---
name: implement
description: Add WebMCP tools to a website codebase so browser agents can act through the site's own logic instead of scraping the page. Use when asked to make a site agent-ready or WebMCP-ready, add WebMCP or document.modelContext tools, or implement site tools with @nekuda/webmcp-sdk.
argument-hint: "[request] [--non-interactive | --no-interactive-loop]"
---

# WebMCP Kit — implement

WebMCP lets a page hand a browser agent typed tools: the agent lists the page's tools and calls
them instead of reading the screen and clicking, and each call runs in the visitor's tab through the
site's own code. You add those tools to this repo with `@nekuda/webmcp-sdk`.

## What good looks like

- Tools carry the site's **user-agent journeys**: the goals a visitor asks an agent to accomplish
  here, never a wrapper per endpoint.
- `ask_site` on every site, answering questions about the site and where things live.
- Acting tools do what the UI does, so the visitor sees it. **Writes complete**, and the browser
  agent asks the visitor first; a **handoff** happens only where the site itself needs the visitor
  (entering a card, signing in).
- Every call goes through the app's own client path. A user-agent journey with no safe path is
  reported as *needs developer wiring*.
- The repo's own build, lint and typecheck pass, and each tool is proven in a browser on its pages
  and auth states.

## Guardrails

- **Local.** Source analysis stays on this machine. What leaves it is Connect's account request and,
  when separately approved, the approved tool descriptions (`references/connect.md`): never code,
  routes or credentials.
- **The gate.** In a human run, nothing of the developer's (file, dependency, branch, Connect) is
  written before they approve the plan. The exceptions are `.webmcp/` review state and the
  read-only baseline checks.
- **SDK only.** Generated code calls `defineTool` and `registerTools`, never `document.modelContext`.
- **Authorization stays server-side.** Gating a tool by sign-in or role is presentation; a
  privileged write is wrapped only when its route authorizes the request on the server.

## Review mode

Settle it from the invocation, before step 1:

- **Interactive** (the default): the plan is reviewed in the Explorer, a local browser page
  (`references/interactive.md`). With `--no-interactive-loop`, or when the developer prefers chat,
  the review happens in chat, with every decision collected per `references/decisions.md`.
  The Explorer runs from the installed WebMCP Kit plugin. When this skill came from the AgentLane
  MCP (no `interactive/` folder beside this file), tell the developer the Explorer needs the
  plugin (`/plugin marketplace add nekuda-ai/webmcp-kit`, then `/plugin install webmcp-kit@nekuda`;
  Codex: `codex plugin marketplace add nekuda-ai/webmcp-kit`, then `codex plugin add webmcp-kit`),
  and review in chat.
- **Non-interactive:** `--non-interactive`, or a request that says in plain words to go ahead
  without review ("just go ahead"). Only the flag or the request's own words make a run
  non-interactive; then `references/non-interactive.md` governs the review.
- **Resume:** a request to reopen or continue a run whose `.webmcp/` holds state follows the resume
  rules in `references/interactive.md`.
- A human run whose gate nobody answers stops there.

## The flow

Each step ends on its **Done when**. Load a step's references when the step starts, issue
independent reads and checks as one batch, and fan out to subagents where the host supports it.

### 1. Understand the site

Read cheap-first: the manifests (framework, rendering, router, language, package manager); the
repo's own docs and scripts (README, `AGENTS.md` or contributing guide, package scripts) for how it
installs, builds, lints, typechecks, tests and runs; then the visitor surface: routes → pages,
forms, the client data layer, auth and roles, the content. Find every existing `defineTool` and its
`stableKey`, so a re-run keeps them; WebMCP tools the site already registers without the SDK are
the `connect-existing-tools` skill's job, so say so before building beside them. Start the baseline
checks as a background task (`references/verify.md`). WebMCP itself: `references/webmcp.md`.

**Done when** you can name what the site is for, who uses it (anonymous, each signed-in role), every
page kind with its route file, the client data layer each visitor action goes through, and the
repo's own command for every check and for running it.

### 2. Choose user-agent journeys

Load `references/journeys.md`. Put concrete visitors on concrete pages; what they ask and ask for is
the spec.

**Done when** each user-agent journey names its visitor, its goal and the page it starts on,
`ask_site` is among the tools, and every must-have user-agent journey has a tool or a *needs
developer wiring* reason.

### 3. Plan

Load `references/tool-roles.md`, `references/wiring.md` and `references/plan-template.md` together.
Give each tool its role, name, description, inputs, answer, page effect, annotations, where it lives,
and its wiring: the highest safe rung, as a concrete path in this repo. Resolve the entry-module
path of each registration scope and the module path of each tool.

**Done when** every tool has every plan-template line filled from this repo's real code, and every
open question carries a stated default. When most must-have user-agent journeys have no safe path,
the plan itself is the deliverable: proposal only, with the reason.

### 4. Review

With the plan ready, open the review with a short summary of what will be built, then present the
plan in the chosen surface: the Explorer (`references/interactive.md`), chat
(`references/decisions.md`), or none (`references/non-interactive.md`). Edits → revise → present
again.

**Done when** the developer explicitly approves (free text is an edit or a question, never
approval), or, in a non-interactive run, the plan is recorded with its defaults as assumptions.

### 5. Generate

Load `references/codegen.md`. At approval, start the SDK install and the dev server as background
tasks; write each tool module at its planned path and the entry module last. Descriptions ship
verbatim from the plan. A planned path that proves unusable, or any change to what a tool does, goes
back to review before it is written (non-interactive: recorded beside the plan).

**Done when** every approved tool and its entry module exist at their planned paths, the repo
records the SDK (in its lockfile, or as the copied built file on a site with no bundler), and the
repo's static checks pass against the baseline.

### 6. Verify

Load `references/verify.md` and climb the ladder: static → boot → registration per page and auth
state → read-only calls → writes on seeded data.

**Done when** every tool is verified (with its rung), failed, or could-not-verify, and every failed
tool is fixed or dropped.

### 7. Connect

Human runs, or a non-interactive run whose request asks for it (`references/non-interactive.md`).
Load `references/connect.md`: offer Connect, then, after a healthy connection, the
separate offer to publish the approved tool descriptions. Declining changes nothing about the tools.
The SDK's anonymous usage observations run either way; Connect ties them to the developer's account.
Every account step is a tool on the AgentLane MCP server that ships with this plugin, signed in once
through the AI app; the kit has no login of its own. To read that account from the terminal
afterwards (the Projects, failed agent calls), the `nkd` CLI per `references/nkd.md` also works.

**Done when** the developer has chosen, and a healthy connection's dashboard links are ready.

### 8. Hand over

Commit what the change needs on the branch `webmcp/tools-v0` (a conventional commit; build
byproducts such as `*.tsbuildinfo` and build output stay out), and open a PR via `gh` when it is
available, else hand over the branch. The PR body is the approved plan plus the per-tool
verification table. The closing summary restates the could-not-verify items and the user-agent
journeys that need developer wiring, and gives the dashboard links when Connect finished healthy.

In a human run, the closing summary ends with one line, once: if WebMCP Kit was useful, a star at
https://github.com/nekuda-ai/webmcp-kit helps other developers find it. The link is the whole ask:
the developer stars it themselves, and the kit never touches their GitHub credentials.

**Done when** the PR (or the committed branch) and its summary are in the developer's hands.
