# Connect after the tools are built

Connect is an optional human decision after the Phase-F ladder has finished and before docs/PR work. Offer it in the Explorer when that loop is active, or in the agent conversation for a human chat-only run. Skip it only for an explicitly non-interactive/headless run. Tool generation and verification are already complete at this point; Connect may change only the existing entry module from the two-module seam in `references/codegen.md`.

## CLI runtime

Run the CLI from the installed plugin; never assume an executable is on `PATH`:

- **Claude Code:** `"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`
- **Codex:** `"${PLUGIN_ROOT}/scripts/webmcp.sh" <command> <arguments>`

Use the form for the current host in every step below. The entry preserves the CLI's arguments
and JSON output. It requires Bun; if Bun is missing, its exact fix is
`webmcp: Bun is required. Install Bun, then retry.`

`WEBMCP_API_BASE` selects the API and defaults to `https://api.agentlane.com`; the API's public
Connect configuration supplies that environment's browser ingest endpoint when it needs an SDK
override. Set `WEBMCP_API_BASE` to the environment's API; everything else follows.
`WEBMCP_CONFIG_DIR` selects the CLI's local configuration fallback directory. Set both on the
plugin-root invocation when targeting an isolated dev or preview environment, for example:

```sh
WEBMCP_API_BASE=https://api.preview.example.com \
WEBMCP_CONFIG_DIR=/tmp/webmcp-preview \
"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" status --workspace <workspace> --json
```

Before sign-in, explain the destination in plain language: the website being connected, the AgentLane environment, the account when known, and the project name as AgentLane will show it. That name is the `name` in the workspace's `package.json` without its `@scope/`, else the folder name — the CLI's own default — unless the developer picks another; a chosen name is passed as `--name` in step 2 below, and on a saved connection it renames the existing project. Verify the environment through its public Connect configuration; never infer it from a localhost website or call an unknown saved account “confirmed.” If account selection is still needed, explain that the sign-in page is where the developer will check it. For a local candidate test, explicitly distinguish the local plugin from the deployed dashboard: a development URL does not load unpublished dashboard changes.

## Decide whether to offer

1. Run the current host's plugin-root entry with `status --workspace <workspace> --json` and parse the one JSON object. Do not infer state from files or prose.
2. Surface `key_mismatch`, `key_revoked`, and `another_session_may_be_running` to your own agent reasoning. They are facts to weigh, not verdicts: decide whether a recovery run is appropriate. Check the current source and configuration before reusing a saved connection. Re-running Connect is the recovery path for stale or missing configuration and a revoked connection. `another_session_may_be_running` is the one the CLI itself enforces — a run that starts while another genuinely holds the workspace fails with `connect_in_progress` and provisions nothing; an abandoned advisory is taken over automatically, so a retry after a crashed run proceeds.
3. When `flags.already_connected` is true and the current source already has the matching tracking configuration, do not ask again: skip provisioning and source edits. Reload the declared page/auth matrix and gather fresh runtime evidence. Healthy means `tracking_api_key_present: true`, `tracking_api_key_matches: true`, `tracking_endpoint_matches: true`, `online.checked: true`, `online.key_enabled: true`, and no advisory that you judge requires action. For healthy reuse, the hand-over's links come from `connect_file.contents` (its `dashboard_url` and `domain_id`), as step 7 says. Append the step-7 done record only after those checks. If recovery will write an entry module, name the exact current path and tracking change. Reuse an explicit choice from this session only when it covers that same path and change; otherwise present the normal Connect choice before running the recovery steps. A saved connection file never supplies approval.
4. Otherwise, when the Explorer is active, append `{"ts":"<now>","run":"connect","state":"offer"}`. Then present the decision. Explain: `See registered tools and their activity in AgentLane. Your built tools stay in this project.` The Explorer owns the exact button copy:
   - `Connect WebMCP Kit to AgentLane`
   - `Connect to AgentLane`
   - `Skip for now`
   - success: `Connected — N tools ready`

   In a chat-only run, do not create Explorer state or journals. First summarize: (1) the tools checked, (2) the website and AgentLane account/project destination, with the project name the CLI will use and that the developer may choose a different one, and (3) what accepting will do: add connection settings to the named file and associate tool activity with that project. Put endpoint details after this explanation, not in the opening. Then put the two choices `Connect to AgentLane` and `Skip for now` to the developer per `references/decisions.md`, and wait for the developer's explicit choice. Treat that reply and the exact entry-module path named with the choice as the decision record below. The path comes from the approved Phase-D plan in the implement flow or from the current source/configuration check in a connection-only caller; never infer either approval or path from silence or search for a replacement path.

When the Explorer is active, the browser sends a durable `connect` event with payload `{"action":"connect"}` or `{"action":"skip"}`. Handle and acknowledge it by the normal journal rules in `references/interactive.md`. A chat-only reply has no browser event to acknowledge; the conversation is its approval record.

Every developer-facing Explorer or conversation string in this step must avoid the words mint, token, scope, telemetry, API key, and origin. Never echo CLI fields, error codes, or error prose. On failure say only that the connection did not finish, the built tools are unchanged, and the developer may retry or skip.

## Skip

For `{"action":"skip"}` or the equivalent chat reply, append `{"ts":"<now>","run":"connect","state":"skipped"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Do not run the CLI and do not touch the entry module. Continue docs/PR work with the built tools unchanged.

## Connect or recover

1. Resolve the approved entry module beneath the workspace and preserve its exact bytes before doing anything. In an Explorer run, re-read `plan.json.entry_module` and append `{"ts":"<now>","run":"connect","state":"start"}`. In a chat-only run, use the exact relative entry-module path from the decision record above and create no Explorer artifacts. A missing, absolute, escaping, or changed path is a failure; never search for or choose a different `registerTools` call during Connect.
2. Run the current host's plugin-root entry with `connect --workspace <workspace> --entry <the exact relative entry-module path from step 1> --skill implement --json`, adding `--name <project name>` when the developer chose one (`connect-existing-tools` passes its own name to `--skill` instead; the flag is how the platform tells a generated site from a migrated one). `--entry` is what makes the CLI write the seam itself, so the key never enters the conversation. Keep the process in a persistent terminal/tool session while the developer signs in; retain its session handle and read its completion. Do not launch it with an untracked shell `&`, end its session while awaiting approval, or restart it while it is still waiting. Use one browser for each sign-in attempt. If the host requires its built-in browser, suppress the CLI's default browser launcher with its existing `WEBMCP_BROWSER` override (on POSIX, `WEBMCP_BROWSER=true`), then open the exact authorization URL emitted on stderr in that browser. Do not open that one-use URL again in a second browser. Parse stdout as JSON, with sensitive values kept out of chat and logs. Never scrape human output. A browser error alone does not prove the CLI failed: check its result before offering a retry. If it timed out, start one fresh authorized attempt and use its new link.
3. Proceed only when the process succeeds and the result has `status: "connected"`, `edge_verification: "ready"`, and `entry_module.written: true` naming the path from step 1. The result carries no key: the CLI wrote it into the file. When present, `ingest_url` must be an absolute HTTP(S) URL ending in `/v1/collect` and must match `.webmcp/connect.json.ingest_url`. If the CLI reports `entry_module_changed`, preserve the current file: the developer edited it while Connect was pending. Never restore the earlier snapshot in that case; explain the refusal and retry only against the current source. For any other pending, disabled, cancelled, malformed, or failed result, restore the exact preserved bytes, append `{"ts":"<now>","run":"connect","state":"failed"}` only when Explorer state exists, explain in the conversation that the built tools are unchanged and the developer may retry or skip, then acknowledge an Explorer event when one exists. A refusal about the entry module itself (`entry_module_not_editable`, `entry_module_no_registration`) provisions nothing and writes nothing; it means a `registerTools` options or `tracking` argument is not an object literal, which is a shape to fix in the source before retrying, never a reason to pick another file.
4. Read the diff the CLI made, and only read it. In every existing `registerTools` batch of that module it added or replaced `tracking.apiKey` with the connection's publishable key, marked in the source as safe to commit; when `ingest_url` is present it added or replaced `tracking.endpoint` with that exact URL, otherwise it removed any existing `tracking.endpoint` (mandatory on a repeat Connect after moving from a preview to an environment that advertises no override: it never retains a stale endpoint); and it left every other option, tracking field, comment and line as it was. Do not rewrite that edit by hand, edit a tool module, duplicate a registration batch, create a second entry module, or substitute another path even if it also calls `registerTools`.
5. Reload every declared page/auth state for that registration scope. Re-run the registration rung from `references/verify.md`, then run the current host's plugin-root entry with `status --workspace <workspace> --json`. Success requires every entry-module batch to carry the same current key/endpoint decision, the same tools to register, `tracking_api_key_present: true`, `tracking_api_key_matches: true`, `tracking_endpoint_matches: true`, and no `key_revoked` flag. When a safe invocation exists, confirm its collect request targets the configured endpoint (or the installed SDK default when the seam omits it) and record runtime verification as `attributed`. If no invocation is safe under `references/verify.md`, do not make one; record runtime verification as `unverified`, keep the configuration, and state that no safe call was available. This limitation is not an edit failure and does not trigger rollback.
6. If the edit, reload, registration, or status check fails, restore the preserved entry-module bytes, reload once to prove the original built tools still register, append the failed run step only for Explorer state, and acknowledge as above when an event exists. Do not weaken or remove completed tool work.
7. On success append `{"ts":"<now>","run":"connect","state":"done","dashboard_url":"<tools URL>","runtime_verification":"<attributed|unverified>"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Build `<tools URL>` as the origin of `dashboard_url` followed by `/tools?domain=<domain id>` — from the Connect result's `dashboard_url` and `domain.id` for a new connection, or from `connect_file.contents`' `dashboard_url` and `domain_id` for healthy reuse. `dashboard_url` itself lands on Home for this project and deployment (`/?domain=<domain id>&environment=<environment>`), not on Tools or Connection. Never take `<tools URL>` from a browser's address bar: the dashboard selects the project from `?domain=` and then removes it from the address, so an observed `/tools` address opens whichever project the viewer last selected. Explorer state is untrusted and must not render it as an external link. The Explorer derives `N` from the approved built suggestions; chat-only reports the verified count in the conversation. When runtime verification is `unverified`, report **configured — runtime check incomplete**, keep affected tools out of **connected**, and say no safe call was available. An accepted call proves attribution for that registration scope, not dashboard processing or deployment. Then make the publish offer and the hand-over below, and continue docs/PR work only when source changed; include review/merge steps only when applicable and link an actual PR only when one exists.

Connection state written by the CLI is not the source seam. On every skip or failure the entry module must be byte-for-byte unchanged; the tool modules are never candidates for rollback.

## Publish the tool catalog (offered once the connection is healthy)

Publishing is the second optional decision, offered only after Connect has finished healthy — a
skipped or failed connection ends the run here, with the built tools unchanged. It sends the tool
descriptions the developer already approved (durable key, wire name, description, input schema,
annotations) so the tools appear in AgentLane's catalog instead of only showing up once something
calls them. Disclose all three facts when you offer it, in your own words:

- The approved **descriptions** of the tools are sent.
- The **source code is not** — no handler bodies, no endpoints, no file contents. The CLI reads the
  `defineTool` calls out of the entry module's text and the tool modules it imports, and never
  runs any of them.
- No **credential** is sent. The connection's publishable key stays at the seam; publishing uses
  the login the developer already authorized.

Present it as a choice with the same wording rules as Connect above (no *mint*, *token*, *scope*,
*telemetry*, *API key*, or *origin*, and never echo CLI fields or error prose). Suggested
explanation: `Publish these tool descriptions so they show up in AgentLane before anyone uses them.
Your code stays in this project.` Offer `Publish tool descriptions` and `Skip for now` per
`references/decisions.md`. A
non-interactive or headless run skips it, exactly as Connect does.

On approval, run the current host's plugin-root entry with:

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" publish --workspace <workspace> \
  --entry <the approved entry module, relative> --scope <registration-scope-name> --yes --json
```

Rules for that invocation:

1. `--entry` is the exact approved entry module from the decision record — the same path Connect
   edited, never a file found by searching. The tool modules it imports are read through it, so
   the two-module shape publishes as one run. One run covers one entry module; a workspace with a
   second registration scope runs `publish` again for it.
2. `--scope` names the registration scope durably and is **never a filesystem path**: a project
   that moves `src/tools/` to `app/tools/` must keep publishing as the same author. Pass it only on
   the first publish — the CLI records it in `.webmcp/connect.json` and reuses it verbatim
   afterwards, and refuses a different one rather than quietly creating a second author. Derive the
   first value from the connection's `display_name`, reduced to `[A-Za-z0-9._-]`.
3. `--yes` is required for an agent-driven run: without it the CLI refuses to publish when there is
   nobody at a terminal to confirm. Never pass it before the developer has approved.
4. Parse stdout as JSON. `status: "published"` is success; report the number of `entries`.
   `status: "skipped"` means nothing was sent.
5. Failures are not fatal to the run. `publisher_scope_required`, `publisher_scope_mismatch`,
   `key_owned_elsewhere` and `dynamic_tool_definition` all leave the built tools and the connection
   untouched — say only that the descriptions were not published and the developer may retry, then
   continue docs/PR work. `dynamic_tool_definition` is the one worth acting on: it names a tool
   whose definition is assembled at runtime, which is a tool no catalog can describe without
   running the project's code.

Publishing writes nothing to the developer's source. On any outcome the entry module must be
byte-for-byte what Connect left.

## Hand over the dashboard (after the publish decision, whichever way it went)

A healthy connection ends with the links that show the developer what they just did. Both come
from the Connect result, or on healthy reuse from `connect_file.contents`:

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

- **Tools not visible yet:** keep the website running, refresh Tools once after the stated processing window, and look for the actual tool names. If still absent, diagnose the status/receipt failure; do not keep telling the developer to wait indefinitely.
- **Tools visible, calls not checked:** explain that AgentLane received the tool list. If source configuration was verified, say no setup snippet needs to be copied. Open the project's Agents activity view to look for the test call. Tool registration alone is not proof that the call arrived.
- **Tools and calls visible:** say which were observed and give the next action for this user's task. For a practice run, reviewing that result completes the exercise; deployment is not required.

When the dashboard was opened, describe the page actually shown. If a deployed dashboard still says “Add this to your project” or “Ready for deployment,” explain what the observed tool rows prove and why no additional setup copy is needed when the source is already configured. Never describe “Ready for deployment” as proof of production readiness. State that the dashboard is deployed code and name the local candidate preview separately when applicable; do not silently replace the real project link with a mock.
