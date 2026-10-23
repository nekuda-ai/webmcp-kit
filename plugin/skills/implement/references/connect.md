# Connect after the tools are built

Connect is an optional human decision after the verify ladder has finished and before docs/PR work. Offer it in the Explorer when that loop is active, or in the agent conversation for a human chat-only run. Skip it only for an explicitly non-interactive/headless run, unless that run's request asks for it (`references/non-interactive.md`). Tool generation and verification are already complete at this point; Connect may change only the existing entry module from the two-module seam in `references/codegen.md`.

## The AgentLane MCP server

Every account step below is a tool call on AgentLane's MCP server, which ships with this plugin as
the server named `agentlane` (`https://api.nekuda.ai/mcp`). The developer signs in once, in the
AI app, and the app holds that sign-in: this kit has no login of its own, stores no credential, and
runs no command for these steps. A tool below is written with an `mcp` prefix and a colon before its
name, such as `mcp:whoami_get`; call the tool of that name on the `agentlane` server (the host may show it with a prefix, such as
`mcp__plugin_webmcp-kit_agentlane__projects_create` in Claude Code).

Before the offer, call `mcp:whoami_get`. It names the organization and what the sign-in may do.

- **Not signed in, or the `agentlane` tools are missing:** say that Connect needs a sign-in to
  AgentLane through the AI app, and how: in Claude Code, run `/mcp`, pick `agentlane`, then
  Authenticate; in Codex, run `codex mcp login agentlane`. The sign-in page is where the developer
  picks the account and the organization. Then wait. Never ask for a password, a key, or a token in
  the conversation, and never start a sign-in of your own.
- **A refusal that asks for more access** (a write the sign-in does not cover) is the app's job: it
  asks the developer to sign in again with the added access. Retry the same call after that.

Before the first write, explain the destination in plain language: the website being connected, the AgentLane organization from `mcp:whoami_get`, and the project name as AgentLane will show it. That name is the `name` in the workspace's `package.json` without its `@scope/`, else the folder name, unless the developer picks another. For a local candidate test, explicitly distinguish the local plugin from the deployed dashboard: a development URL does not load unpublished dashboard changes.

## Decide whether to offer

1. Read `.webmcp/connect.json` when it exists. It is the non-secret record of an earlier connection (`domain_id`, `display_name`, `environment`, `dashboard_url`, `publisher_scope`), written by this flow or by an older kit. It never holds a key. Treat it as a hint, never as approval or proof.
2. Read the approved entry module. It is **already connected** when every `registerTools` batch in it carries the same `tracking.apiKey` and `mcp:publishable_keys_list` for the recorded project shows that key `enabled` and not revoked. Then do not ask again: skip the writes and source edits, reload the declared page/auth matrix and gather fresh runtime evidence, and go to step 7 of *Connect or recover* for the links. A key that is missing from the list, revoked or disabled, or batches that disagree, make a recovery run: name the exact current path and tracking change. Reuse an explicit choice from this session only when it covers that same path and change; otherwise present the normal Connect choice. A saved connection file never supplies approval.
3. Otherwise, when the Explorer is active, append `{"ts":"<now>","run":"connect","state":"offer"}`. Then present the decision. Explain: `See registered tools and their activity in AgentLane. Your built tools stay in this project.` The Explorer owns the exact button copy:
   - `Connect WebMCP Kit to AgentLane`
   - `Connect to AgentLane`
   - `Skip for now`
   - success: `Connected — N tools ready`

   In a chat-only run, do not create Explorer state or journals. First summarize: (1) the tools checked, (2) the website and AgentLane organization/project destination, with the project name you will use and that the developer may choose a different one, and (3) what accepting will do: add connection settings to the named file and associate tool activity with that project. Then put the two choices `Connect to AgentLane` and `Skip for now` to the developer per `references/decisions.md`, and wait for the developer's explicit choice. Treat that reply and the exact entry-module path named with the choice as the decision record below. The path comes from the approved plan in the implement flow or from the current source/configuration check in a connection-only caller; never infer either approval or path from silence or search for a replacement path.

When the Explorer is active, the browser sends a durable `connect` event with payload `{"action":"connect"}` or `{"action":"skip"}`. Handle and acknowledge it by the normal journal rules in `references/interactive.md`. A chat-only reply has no browser event to acknowledge; the conversation is its approval record.

Every developer-facing Explorer or conversation string in this step must avoid the words mint, token, scope, telemetry, API key, and origin. Never echo tool fields, error codes, or error prose. On failure say only that the connection did not finish, the built tools are unchanged, and the developer may retry or skip.

## Skip

For `{"action":"skip"}` or the equivalent chat reply, append `{"ts":"<now>","run":"connect","state":"skipped"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Make no AgentLane call that writes, and do not touch the entry module. Continue docs/PR work with the built tools unchanged.

## Connect or recover

1. **Preserve.** Resolve the approved entry module beneath the workspace and keep its exact bytes before doing anything. In an Explorer run, re-read `plan.json.entry_module` and append `{"ts":"<now>","run":"connect","state":"start"}`. In a chat-only run, use the exact relative entry-module path from the decision record and create no Explorer artifacts. A missing, absolute, escaping, or changed path is a failure; never search for or choose a different `registerTools` call during Connect. Every `registerTools` call in that module must take an options object literal (or none) whose `tracking`, when present, is an object literal; any other shape is a source fix to make before retrying, never a reason to pick another file.
2. **Project.** Call `mcp:projects_create` with:
   - `project_key`: the codebase's stable id, the same one earlier kits sent, so a repeat returns the same project. With a Git remote, it is `git:sha256:` followed by the SHA-256 of the remote URL without a trailing `.git`, a newline, and the workspace's path relative to the repository root (`.` at the root): `printf '%s\n%s' "<remote>" "<relative path>" | shasum -a 256`. Without a remote it is `path:sha256:` and the SHA-256 of the workspace's absolute path.
   - `display_name`: the project name from the explanation above (the developer's choice, when they made one).
   - `source`: `"kit"`, always. It marks the project as connected by this kit, so the dashboard greets it with the tools it found.
   - `site_url`, when the developer gave the deployed address. Leave it out otherwise; adding it later keeps the same project.
   - `domain_id`, only when `.webmcp/connect.json` names one: it keeps a project an older kit connected.

   A repeat with the same `project_key` returns the existing project and creates nothing, so this call is also the recovery path.
3. **Key.** Call `mcp:publishable_keys_create` with the project's `id` and `environment` (`production` unless the developer named another deployment). It returns the existing enabled key for that environment, or a new one. Proceed only when the answer has `edge_ready: true`. On `edge_ready: false` with `edge_verification: "enabled"`, call it again (it creates nothing the second time) up to 5 times, a few seconds apart; still not ready is a failure (step 6). `edge_verification: "disabled"` is a failure at once, with no retry: that AgentLane does not confirm keys at its edge, so no later call can (step 6). The `api_key.key` value (`wmk_…`) is a **publishable key**: it is meant to ship in the site's code, like a payment provider's publishable key, so it may appear in the source and the diff. Still never print it in the conversation or a log; refer to it as the connection's key.
4. **Seam edit.** In the preserved entry module, and only there, set `tracking.apiKey` to that key in **every** `registerTools` batch: add `tracking: { apiKey: "<key>" }` to a batch without one, or replace an existing `tracking.apiKey`. Write it as `apiKey: "<key>" /* publishable key, safe to commit */`, the marker earlier kits wrote. Leave every other option, tracking field, comment and line as it was, including `tracking.builtWith`. Against production (`https://api.nekuda.ai/mcp`, or the AgentLane-named production address an earlier kit configured), remove any existing `tracking.endpoint`: the SDK's default is production. Against another AgentLane environment (a dev or local API the developer pointed the `agentlane` server at), read that API's public `GET <API origin>/v1/connect/config`: when it returns an `ingest_url`, set `tracking.endpoint` to exactly that URL; when it returns none, remove `tracking.endpoint`. Never keep a stale endpoint from an earlier environment. Do not edit a tool module, duplicate a registration batch, create a second entry module, or substitute another path even if it also calls `registerTools`. If the file changed since step 1 (the developer edited it while you worked), stop, keep their bytes, and offer a retry against the current source.
5. **Check.** Reload every declared page/auth state for that registration scope and re-run the registration rung from `references/verify.md`. Success requires every entry-module batch to carry the same key, the same tools to register, and the key `enabled` in `mcp:publishable_keys_list`. When a safe invocation exists, confirm its collect request leaves the page (the SDK sends it to AgentLane's collect endpoint) and record runtime verification as `attributed`. If no invocation is safe under `references/verify.md`, do not make one; record runtime verification as `unverified`, keep the configuration, and state that no safe call was available. This limitation is not an edit failure and does not trigger rollback.
6. **Failure.** If a call, the edit, the reload, registration, or the check fails, restore the preserved entry-module bytes, reload once to prove the original built tools still register, append `{"ts":"<now>","run":"connect","state":"failed"}` only when Explorer state exists, explain in the conversation that the built tools are unchanged and the developer may retry or skip, then acknowledge an Explorer event when one exists. A project or key that was created stays; re-running Connect reuses both. Do not weaken or remove completed tool work.
7. **Done.** Write `.webmcp/connect.json` (create `.webmcp/` when needed) with `domain_id` (the project's `id`), `display_name`, `environment`, `dashboard_url` (from the key answer) and, after a publish, `publisher_scope`; never the key. Append `{"ts":"<now>","run":"connect","state":"done","dashboard_url":"<tools URL>","runtime_verification":"<attributed|unverified>"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Build `<tools URL>` as the origin of `dashboard_url` followed by `/tools?domain=<domain id>`, from the key answer's `dashboard_url` and the project's `id` for a new connection, or from `.webmcp/connect.json`'s `dashboard_url` and `domain_id` for healthy reuse. `dashboard_url` itself lands on Home for this project and deployment (`/?domain=<domain id>&environment=<environment>`), not on Tools or Connection. Never take `<tools URL>` from a browser's address bar: the dashboard selects the project from `?domain=` and then removes it from the address, so an observed `/tools` address opens whichever project the viewer last selected. Explorer state is untrusted and must not render it as an external link. The Explorer derives `N` from the approved built suggestions; chat-only reports the verified count in the conversation. When runtime verification is `unverified`, report **configured — runtime check incomplete**, keep affected tools out of **connected**, and say no safe call was available. An accepted call proves attribution for that registration scope, not dashboard processing or deployment. Then make the publish offer and the hand-over below, and continue docs/PR work only when source changed; include review/merge steps only when applicable and link an actual PR only when one exists.

On every skip or failure the entry module must be byte-for-byte unchanged; the tool modules are never candidates for rollback.

## Publish the tool catalog (offered once the connection is healthy)

Publishing is the second optional decision, offered only after Connect has finished healthy — a
skipped or failed connection ends the run here, with the built tools unchanged. It sends the tool
descriptions the developer already approved (durable key, wire name, description, input schema,
annotations) so the tools appear in AgentLane's catalog instead of only showing up once something
calls them. Disclose all three facts when you offer it, in your own words:

- The approved **descriptions** of the tools are sent.
- The **source code is not**: no handler bodies, no endpoints, no file contents. You write each
  description from the `defineTool` call as it stands in the source; you never run the project's
  code to learn it.
- No **credential** is sent. The connection's key stays at the seam; publishing uses the sign-in
  the developer already gave the AI app.

Present it as a choice with the same wording rules as Connect above (no *mint*, *token*, *scope*,
*telemetry*, *API key*, or *origin*, and never echo tool fields or error prose). Suggested
explanation: `Publish these tool descriptions so they show up in AgentLane before anyone uses them.
Your code stays in this project.` Offer `Publish tool descriptions` and `Skip for now` per
`references/decisions.md`. A non-interactive or headless run skips it, exactly as Connect does, unless its request asks for publishing too.

On approval, call `mcp:contracts_publish` once per registration scope (one entry module), with:

- `id`: the project's id; `environment`: the same deployment as the key.
- `scope`: the registration scope's durable name, **never a filesystem path**: a project that moves
  `src/tools/` to `app/tools/` must keep publishing as the same author. Reuse
  `.webmcp/connect.json`'s `publisher_scope` verbatim when it exists; otherwise take the project's
  `display_name` reduced to `[A-Za-z0-9._-]` (starting with a letter or digit), and record it there.
  A second registration scope adds `.` and a short name of its own (`shop.checkout`).
- `idempotency_key`: a fresh random id per publish; a retry of the same publish reuses it.
- `entries`: one per tool that entry module registers, the **whole** set. A tool left out is
  not withdrawn: it keeps its last published description, so name in your report any tool the
  source no longer registers. Each entry has:
  - `stable_key`: the tool's durable key from the approved plan, lowercase dot-separated
    (`shop.cart.add_item`; the pattern is at least two `[a-z0-9_]+` parts joined by `.`).
  - `name`: the wire name as registered; `description`: the registered description, verbatim.
  - `execution_owner`: `"site"` (the site's own page runs the tool).
  - `input_schema`: the registered JSON Schema, verbatim; `annotations` when the tool declares any.
  - `availability`: `{ "routes": [<the pages from the plan>], "auth": "none" | "session" | "unknown" }`.
  - `contract_complete`: `true` only when every field above came straight from the source; `false`
    for a tool whose definition is assembled at runtime, which no catalog can describe without
    running the project's code. Say which tools those were.

Read the answer's `entries`: report how many are `created`, `updated` or `unchanged`. A `conflict`
entry or a refused call is not fatal to the run: it leaves the built tools and the connection
untouched. Say only that the descriptions were not published and the developer may retry, then
continue docs/PR work. Publishing writes nothing to the developer's source except
`publisher_scope` in `.webmcp/connect.json`; the entry module stays byte-for-byte what Connect left.

## Hand over the dashboard (after the publish decision, whichever way it went)

A healthy connection ends with the links that show the developer what they just did. Both come
from the key answer, or on healthy reuse from `.webmcp/connect.json`:

- **Home** is `dashboard_url`, verbatim. It lands on Home for this project and this deployment,
  and the dashboard greets a first connection with the tools it found.
- **Tools** is the `<tools URL>` built in step 7: the origin of `dashboard_url` plus
  `/tools?domain=<domain id>`.

Never substitute a guessed URL, an address copied from the browser, or a local mock project.

Lead with the strongest verified result and any unfinished part together: for example, **“Your
local tools work and AgentLane accepted a test call. The dashboard is still waiting to show your
tools.”** Do not lead with an unqualified “Everything is done” while receipt is unknown. Then say,
in your own words:

`You're connected. Watch your tools and every call to them in AgentLane: <dashboard_url>`

and give the project name, the environment, and the Tools URL as **View tools in AgentLane** in a
Markdown link, with the same full URL in a copyable code block for terminal clients.

Once per run — a site with several registration scopes shares one hand-over. Print it before the
docs/PR work so it is not buried under the PR summary, and repeat it in the closing summary. A
skipped or failed connection has no link to give; say nothing about the dashboard.

Give one next action matched to the evidence:

- **Tools not visible yet:** keep the website running, refresh Tools once after the stated processing window, and look for the actual tool names. `mcp:registered_tools_list` shows what the site has registered so far. If still absent, diagnose the receipt failure; do not keep telling the developer to wait indefinitely.
- **Tools visible, calls not checked:** explain that AgentLane received the tool list. If source configuration was verified, say no setup snippet needs to be copied. Open the project's Agents activity view to look for the test call. Tool registration alone is not proof that the call arrived.
- **Tools and calls visible:** say which were observed and give the next action for this user's task. For a practice run, reviewing that result completes the exercise; deployment is not required.

When the dashboard was opened, describe the page actually shown. If a deployed dashboard still says “Add this to your project” or “Ready for deployment,” explain what the observed tool rows prove and why no additional setup copy is needed when the source is already configured. Never describe “Ready for deployment” as proof of production readiness. State that the dashboard is deployed code and name the local candidate preview separately when applicable; do not silently replace the real project link with a mock.
