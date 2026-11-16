# Connect after the tools are built

Connect is an optional human decision after the verify ladder has finished and before docs/PR work. Offer it in the Explorer when that loop is active, or in the agent conversation for a human chat-only run. Skip it only for an explicitly non-interactive/headless run, unless that run's request asks for it (`references/non-interactive.md`). Tool generation and verification are already complete at this point; Connect may change only the existing entry module from the two-module seam in `references/codegen.md` (or, on a tracking-only install, the setup module below), and the workspace's `.env.local` (step 4).

## Two kinds of entry module

The entry module Connect edits is one of two kinds, and a site may have both (one run each):

- **SDK batches**: the module whose `registerTools` calls register the tools (the SDK path).
- **A setup module**: the module whose one `trackTools` call does tool tracking, on a
  tracking-only install (`connect-existing-tools`' `references/tracking-only.md`). It takes the
  same `tracking` object a `registerTools` batch takes.

Below, **batch** means each `registerTools` call in the approved entry module, or its `trackTools`
call; every rule written for `registerTools` batches holds for that call the same way. Recovery
from either path is therefore one flow.

## The AgentLane MCP server

Every account step below is a tool call on AgentLane's MCP server, which ships with this plugin as
the server named `agentlane` (`https://api.nekuda.ai/mcp`). The developer signs in once, in the
AI app, and the app holds that sign-in: this kit has no login of its own, stores no credential, and
runs no command for these steps. A tool below is written with an `mcp` prefix and a colon before its
name, such as `mcp:whoami_get`; call the tool of that name on the `agentlane` server (the host may show it with a prefix, such as
`mcp__plugin_webmcp-kit_agentlane__projects_connect` in Claude Code).

Before the offer, call `mcp:whoami_get`. It names the organization and what the sign-in may do.

- **Not signed in, or the `agentlane` tools are missing:** say that Connect needs a sign-in to
  AgentLane through the AI app, and how: in Claude Code, run `/mcp`, pick `agentlane`, then
  Authenticate; in Codex, run `codex features enable mcp_2026_07_28`, then
  `codex mcp login agentlane` (without the first, the tools stay missing after a sign-in). The sign-in page is where the developer
  picks the account and the organization. Then wait. Never ask for a password, a key, or a token in
  the conversation, and never start a sign-in of your own.
- **A refusal that asks for more access** (a write the sign-in does not cover) is the app's job: it
  asks the developer to sign in again with the added access. Retry the same call after that.

Before the first write, explain the destination in plain language: the website being connected, the AgentLane organization from `mcp:whoami_get`, and the project name as AgentLane will show it. That name is the `name` in the workspace's `package.json` without its `@scope/`, else the folder name, unless the developer picks another. For a local candidate test, explicitly distinguish the local plugin from the deployed dashboard: a development URL does not load unpublished dashboard changes.

## Decide whether to offer

1. Read `.webmcp/connect.json` when it exists. It is the non-secret record of an earlier connection (`project_key`, `domain_id`, `display_name`, `environment`, `dashboard_url`, `publisher_scope`), written by this flow or by an older kit. It never holds a key. Treat it as a hint, never as approval or proof.
2. Read the approved entry module. It is **already connected** when every batch in it (its `registerTools` calls, or its `trackTools` call) carries the same key in `tracking.apiKey` (the key literal: the fallback after the variable that step 4 writes, or the bare literal an earlier kit wrote, which stays as it is), the variable in `.env.local`, when the module reads one and the file sets it, holds that same key (the variable wins over the fallback, so another key there is the key the site sends), and `mcp:publishable_keys_list` for the recorded project shows that key `enabled` and not revoked. Then do not ask again: skip the writes and source edits, reload the declared page/auth matrix and gather fresh runtime evidence, and go to step 7 of *Connect or recover* for the links. A key that is missing from the list, revoked or disabled, batches that disagree, or a `.env.local` variable that holds another key, make a recovery run: name the exact current path and tracking change. Reuse an explicit choice from this session only when it covers that same path and change; otherwise present the normal Connect choice. A saved connection file never supplies approval.
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

1. **Preserve.** Resolve the approved entry module beneath the workspace and keep its exact bytes before doing anything, and also the bytes of the workspace's `.env.local` (or the fact that it does not exist), which step 4 writes. In an Explorer run, re-read `plan.json.entry_module` and append `{"ts":"<now>","run":"connect","state":"start"}`. In a chat-only run, use the exact relative entry-module path from the decision record and create no Explorer artifacts. A missing, absolute, escaping, or changed path is a failure; never search for or choose a different `registerTools` or `trackTools` call during Connect. Every batch in that module must take an options object literal (or none) whose `tracking`, when present, is an object literal; any other shape is a source fix to make before retrying, never a reason to pick another file.
2. **Project and key.** Call `mcp:projects_connect` once. (When the `agentlane` server offers no `mcp:projects_connect`, it is an older AgentLane: follow *When AgentLane offers no `mcp:projects_connect`* below instead of steps 2 to 4.) It gets or creates the project, gets or creates its publishable key, and waits for AgentLane's edge to accept the key, all on the server. Send:
   - `project_key`: the codebase's identity, so a repeat returns the same project.
     - **With a remote:** read it with `git config --get remote.origin.url`. When it names a hosted repository (not a folder path or a `file:` address), the key is `git:` followed by that address as Git printed it, with any `user:password@` removed, then, when the workspace is not the repository's root, `#` and the workspace's folder in the repository (`git rev-parse --show-prefix`, without its trailing `/`). Example: `git:git@github.com:acme/shop.git#apps/web`. Send the address as it is: AgentLane reduces every form of one repository's address to one key (`git:github.com/acme/shop`). Never hash it.
     - **Without one:** the key is `local:` and a random id that this codebase keeps. Reuse the `local:` key that `.webmcp/connect.json` records; only when it records none, make one with `node -e 'console.log(crypto.randomUUID())'`. Never derive a key from the workspace's path: another codebase can sit at the same path on another machine.
   - `display_name`: the project name from the explanation above (the developer's choice, when they made one).
   - `source`: `"kit"`, always. It marks the project as connected by this kit, so the dashboard greets it with the tools it found.
   - `site_url`, when the developer gave the deployed address. Leave it out otherwise; adding it later keeps the same project.
   - `domain_id`, only when `.webmcp/connect.json` names one: it keeps a project an older kit connected.
   - `environment`: `.webmcp/connect.json`'s `environment` when it names one, so a reconnect keeps the key it already has (a project an older kit connected keeps its Production key). Otherwise `"development"`: the **Development & Testing** environment, the one a developer connects. Never choose `production` or `prod` yourself. Production is not made here: the developer adds it later on the project's Connection page in AgentLane, with a key of its own (the hand-over below says how).

   **Before the call**, write `project_key` into `.webmcp/connect.json` (create `.webmcp/` when needed; keep every other field the file has). As soon as the answer arrives, add `domain_id`, the answer's `domain.id`. A lost answer or a later failure then reruns with the same key and finds the same project.

   The answer's `environment` names the environment of the key: `development` is Development & Testing. A repeat with the same `project_key` returns the existing project and key and creates nothing, so this call is also the recovery path. An existing project keeps its own name (its owner may have renamed it): from here on, call the project by the answer's `domain.display_name`, and when it differs from the name you offered, say the project kept its name and can be renamed in the dashboard.
3. **Ready.** Proceed only when the answer has `edge_ready: true`. AgentLane has already waited for its edge, so do not call again: `edge_ready: false` is a failure (step 6), and `edge_verification: "disabled"` means that AgentLane does not confirm keys at its edge, so no later call can. The `api_key.key` value (`wmk_…`) is a **publishable key**: it is meant to ship in the site's code, like a payment provider's publishable key, so it may appear in the source and the diff. Still never print it in the conversation or a log; refer to it as the connection's key.
4. **Seam edit.** The site's code reads its key from a public build variable and falls back to this key, so a live site whose hosting has no variable yet still sends its activity (under this key). The variable's name is the framework's public prefix followed by `AGENTLANE_PUBLISHABLE_KEY`, read with the framework's own expression. Take the framework from the workspace's `package.json` and build config:

   | Framework | Variable | Read |
   |---|---|---|
   | Next.js | `NEXT_PUBLIC_AGENTLANE_PUBLISHABLE_KEY` | `process.env.NEXT_PUBLIC_AGENTLANE_PUBLISHABLE_KEY` |
   | Vite (React, Vue, Svelte, SvelteKit, Remix on Vite) | `VITE_AGENTLANE_PUBLISHABLE_KEY` | `import.meta.env.VITE_AGENTLANE_PUBLISHABLE_KEY` |
   | Astro | `PUBLIC_AGENTLANE_PUBLISHABLE_KEY` | `import.meta.env.PUBLIC_AGENTLANE_PUBLISHABLE_KEY` |
   | Create React App | `REACT_APP_AGENTLANE_PUBLISHABLE_KEY` | `process.env.REACT_APP_AGENTLANE_PUBLISHABLE_KEY` |
   | Expo | `EXPO_PUBLIC_AGENTLANE_PUBLISHABLE_KEY` | `process.env.EXPO_PUBLIC_AGENTLANE_PUBLISHABLE_KEY` |

   Write the read exactly as the table gives it (a bundler replaces only that exact text). A workspace whose build puts no public variable into browser code (a page that loads its modules without a bundler), or a framework this table does not name, gets no variable: write the key literal alone, keeping the marker comment (`apiKey: "<key>" /* publishable key, safe to commit */`), skip `.env.local`, and say in the hand-over that every deployment of this code sends under this key until its code reads a variable.

   - **Source.** In the preserved entry module, and only there, set `tracking.apiKey` in **every** `registerTools` batch (on a setup module, in its `trackTools` call): add `tracking: { apiKey: … }` to a batch without one, or replace an existing `tracking.apiKey`. Write it as `apiKey: <read> || "<key>" /* publishable key, safe to commit */` (`||`, so an empty variable also falls back); the comment is the marker earlier kits wrote.
   - **`.env.local`.** Only when the answer's `environment` is `development`: in the workspace's `.env.local` (create it when missing), set the line `<variable>=<key>`: replace that variable's line when there is one, else append it, and leave every other line as it was. It holds the Development & Testing key for local runs; the hosting settings hold the Production key once the developer adds Production. When the answer names another environment (a reconnect that kept a recorded `production`), never write its key into `.env.local`: that key belongs in the hosting provider's environment settings, which the hand-over says. One repair only: when `.env.local` sets the variable to a key that `mcp:publishable_keys_list` does not show `enabled` for this project (an earlier kit wrote it, and it was since revoked), remove that one line, because it would override the fallback; leave every other line, and a variable that holds an enabled key, exactly as it is.

   Leave every other option, tracking field, comment and line as it was, including `tracking.builtWith`. The same answer names the endpoint, for every AgentLane environment, production included: when its `ingest_url` is a URL, set `tracking.endpoint` to exactly that URL in every batch; when it is `null`, remove `tracking.endpoint`. Never keep a stale endpoint from an earlier environment. Do not edit a tool module, duplicate a registration batch, create a second entry module, or substitute another path even if it also calls `registerTools`. If the entry module or `.env.local` changed since step 1 (the developer edited it while you worked), stop, keep their bytes, and offer a retry against the current source.
5. **Check.** When step 4 changed `.env.local`, restart the dev server the way `references/verify.md` starts it: a running server can keep the variable's old value, which wins over the fallback. Then reload every declared page/auth state for that registration scope and re-run the registration rung from `references/verify.md`. Success requires every entry-module batch to carry the same key, the same tools to register, and the key `enabled` in `mcp:publishable_keys_list`. A `trackTools` call that still carries `debug` fails this check: debug mode sends nothing, so no call can arrive. When a safe invocation exists, confirm its collect request leaves the page (the SDK sends it to AgentLane's collect endpoint) and record runtime verification as `attributed`. If no invocation is safe under `references/verify.md`, do not make one; record runtime verification as `unverified`, keep the configuration, and state that no safe call was available. This limitation is not an edit failure and does not trigger rollback. The same holds when this machine has no browser that can load the pages (the verify ladder's **could-not-verify**): the reload and the registration rung cannot run here, which is not a failed check. Check the rest (every batch carries the same key, the key is `enabled`), record runtime verification as `unverified`, keep the configuration, say that the pages could not be loaded here, and go to step 7. `mcp:install_check` reading `Waiting for your SDK` is not a failed check either: no page has loaded the key yet.
6. **Failure.** If a call, the edit, the reload, registration, or the check fails (step 5's limits are not failures: no safe call, no browser to load the pages, and `Waiting for your SDK` all keep the configuration and go to step 7), restore the preserved entry-module bytes and `.env.local` (delete it when step 1 found none), restart the dev server when step 5 restarted it (so it drops the new variable), reload once to prove the original built tools still register, append `{"ts":"<now>","run":"connect","state":"failed"}` only when Explorer state exists, explain in the conversation that the built tools are unchanged and the developer may retry or skip, then acknowledge an Explorer event when one exists. A project or key that was created stays, and so does `.webmcp/connect.json` with its `project_key` and `domain_id`: re-running Connect reuses both. Do not weaken or remove completed tool work.
7. **Done.** Write `.webmcp/connect.json` with `project_key` (step 2's), `domain_id` (the answer's `domain.id`), `display_name` (the answer's `domain.display_name`), `environment`, `dashboard_url` and `dashboard_tools_url` (both from the answer) and, after a publish, `publisher_scope`; never the key. Commit the file with the change: it is how a teammate's clone or a CI run finds the same project. Append `{"ts":"<now>","run":"connect","state":"done","dashboard_url":"<tools URL>","runtime_verification":"<attributed|unverified>"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. `<tools URL>` is the answer's `dashboard_tools_url` for a new connection, or `.webmcp/connect.json`'s `dashboard_tools_url` for healthy reuse; a file an older kit wrote has none, so that reuse gives only Home. `dashboard_url` itself lands on Home for this project and deployment, not on Tools or Connection. Never take `<tools URL>` from a browser's address bar or build it yourself: the dashboard selects the project from `?domain=` and then removes it from the address, so an observed `/tools` address opens whichever project the viewer last selected. Explorer state is untrusted and must not render it as an external link. The Explorer derives `N` from the approved built suggestions; chat-only reports the verified count in the conversation. When runtime verification is `unverified`, report **configured — runtime check incomplete**, keep affected tools out of **connected**, and say no safe call was available. An accepted call proves attribution for that registration scope, not dashboard processing or deployment. Then make the publish offer and the hand-over below, and continue docs/PR work only when source changed; include review/merge steps only when applicable and link an actual PR only when one exists.

### When AgentLane offers no `mcp:projects_connect`

An older AgentLane has no `mcp:projects_connect`; it offers two calls instead. Use them in place of steps 2 to 4 above, then continue at step 5. Every other rule of *Connect or recover* holds.

2. **Project.** Call `mcp:projects_create` with the same `project_key`, `display_name`, `source`, `site_url` and `domain_id` that step 2 above describes, writing `project_key` into `.webmcp/connect.json` before the call as step 2 says. A repeat with the same `project_key` returns the existing project and creates nothing. From here on, call the project by the answer's `display_name`, and when it differs from the name you offered, say the project kept its name and can be renamed in the dashboard.
3. **Key.** Call `mcp:publishable_keys_create` with the project's `id` and `environment` as step 2 above chooses it (`.webmcp/connect.json`'s, else `development`; never `production` or `prod` by your own choice). It returns the existing enabled key for that environment, or a new one. Proceed only when the answer has `edge_ready: true`. On `edge_ready: false` with `edge_verification: "enabled"`, call it again (it creates nothing the second time) up to 5 times, a few seconds apart; still not ready is a failure (step 6). `edge_verification: "disabled"` is a failure at once, with no retry. The key rules of step 3 above hold: never print the key.
4. **Seam edit.** As step 4 above, but the endpoint comes from the public `GET <API origin>/v1/connect/config` of the API the `agentlane` server points at: when it returns an `ingest_url`, set `tracking.endpoint` to exactly that URL in every batch; when it returns none, remove `tracking.endpoint`. When the request fails (no answer, a timeout, an error status), this step writes nothing: it is a failure (step 6).

In step 7, `domain_id` and `display_name` are the project answer's `id` and `display_name`, and `dashboard_url` is the key answer's. An older AgentLane answers no `dashboard_tools_url`: write none, put `dashboard_url` in the Explorer's done record in place of `<tools URL>`, and hand over Home only, with no **View tools in AgentLane** link, as for a reuse of a file an older kit wrote. Never build the Tools link yourself.

On every skip or failure the entry module and `.env.local` must be byte-for-byte unchanged; the tool modules are never candidates for rollback.

## Publish the tool catalog (offered once the connection is healthy)

Publishing is the second optional decision, offered only after Connect has finished healthy — a
skipped or failed connection ends the run here, with the built tools unchanged. Connect has
finished healthy when it reached step 7 (*Done*), a **configured — runtime check incomplete**
report included; publishing needs no page to have loaded. Until a page with the key loads,
`mcp:install_check` reads `Waiting for your SDK` and `working: false`: that is a new
connection's expected state, not a fault, so it calls for no repeat Connect, no added allowed
site and no support request, and it does not hold back the publish offer. A setup module
(tool tracking) gets no publish offer: the SDK derives its tools' durable keys itself and a
connected install sends their descriptions when a page loads, so an entry published by hand under
another key would be a second tool in the catalog. It sends the tool
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

- `id`: the project's id; `environment`: the answer's `environment`, the same deployment as the key.
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
from the `mcp:projects_connect` answer, or on healthy reuse from `.webmcp/connect.json`:

- **Home** is `dashboard_url`, verbatim. It lands on Home for this project and this deployment,
  and the dashboard greets a first connection with the tools it found.
- **Tools** is `dashboard_tools_url`, verbatim (the `<tools URL>` of step 7).

Never substitute a guessed URL, an address copied from the browser, or a local mock project.

Lead with the strongest verified result and any unfinished part together: for example, **“Your
local tools work and AgentLane accepted a test call. The dashboard is still waiting to show your
tools.”** Do not lead with an unqualified “Everything is done” while receipt is unknown. Then say,
in your own words:

`You're connected. Watch your tools and every call to them in AgentLane: <dashboard_url>`

and give the project name, the environment, and the Tools URL as **View tools in AgentLane** in a
Markdown link, with the same full URL in a copyable code block for terminal clients.

When the answer's `environment` (on healthy reuse, `.webmcp/connect.json`'s) is `development`, the environment is **Development & Testing**:
say so in those words, never by its stored name. Then add, in your own words, what comes next for
the live site: the developer adds **Production** later on the project's Connection page in
AgentLane. Production has its own key, which goes in the hosting provider's environment settings
under the variable step 4 named. Until then, the live site sends its activity under the
Development & Testing key, the code's fallback. When step 4 wrote no variable, say instead that
the code must read one before Production can have its own key.

When the answer's `environment` is another one (a reconnect that kept a recorded `production`),
name that environment, and say that `.env.local` does not hold its key: this connection's key, the
fallback in the entry module, goes in the hosting provider's environment settings under the
variable step 4 named, and local runs send under it too unless `.env.local` sets the variable to
another key. When step 4 wrote no variable, say instead that
every deployment of this code sends under this key until its code reads a variable.

Once per run — a site with several registration scopes shares one hand-over. Print it before the
docs/PR work so it is not buried under the PR summary, and repeat it in the closing summary. A
skipped or failed connection has no link to give; say nothing about the dashboard.

Give one next action matched to the evidence:

- **Tools not visible yet:** keep the website running, refresh Tools once after the stated processing window, and look for the actual tool names. `mcp:registered_tools_list` shows what the site has registered so far. If still absent, diagnose the receipt failure; do not keep telling the developer to wait indefinitely.
- **Tools visible, calls not checked:** explain that AgentLane received the tool list. If source configuration was verified, say no setup snippet needs to be copied. Open the project's Agents activity view to look for the test call. Tool registration alone is not proof that the call arrived.
- **Tools and calls visible:** say which were observed and give the next action for this user's task. For a practice run, reviewing that result completes the exercise; deployment is not required.

When the dashboard was opened, describe the page actually shown. If a deployed dashboard still says “Add this to your project” or “Ready for deployment,” explain what the observed tool rows prove and why no additional setup copy is needed when the source is already configured. Never describe “Ready for deployment” as proof of production readiness. State that the dashboard is deployed code and name the local candidate preview separately when applicable; do not silently replace the real project link with a mock.

## Disconnect or remove a project

To stop reporting from one deployment, revoke its key: find it with `mcp:publishable_keys_list` and
call `mcp:publishable_keys_revoke` with its `id`, then remove `tracking.apiKey` from the entry
module (or leave it: a revoked key is refused). To remove the whole project,
call only `mcp:projects_delete` with the project's `id`: it also deletes the project's keys, tools
and history, so do not revoke the keys first. Both cannot be undone: before the call, name the project
(its name and `id` from `mcp:projects_get`) and get the developer's explicit yes for that project.

These two tools, and `mcp:publishable_keys_delete`, always ask the developer to approve the call in
the AI app, in every permission mode. A headless run (`claude -p`, CI, `--non-interactive`) has
nobody to approve, so the call is refused. Do not retry it and do not look for another tool. Say
that removing the project needs an interactive session, or give the exact command for the
terminal: `nkd projects delete <project-id> --yes --json`, with an `NKD_API_KEY` the developer
exported (`references/nkd.md`). After removal, delete `.webmcp/connect.json`.
