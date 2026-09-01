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
WEBMCP_API_BASE=https://api-pr-332.pr.agentlane.dev \
WEBMCP_CONFIG_DIR=/tmp/webmcp-pr-332 \
"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh" status --workspace <workspace> --json
```

## Decide whether to offer

1. Run the current host's plugin-root entry with `status --workspace <workspace> --json` and parse the one JSON object. Do not infer state from files or prose.
2. Surface `key_mismatch`, `key_revoked`, and `another_session_may_be_running` to your own agent reasoning. They are facts to weigh, not verdicts: decide whether a recovery run is appropriate. Re-running Connect is the recovery path. `another_session_may_be_running` is the one the CLI itself enforces — a run that starts while another genuinely holds the workspace fails with `connect_in_progress` and provisions nothing; an abandoned advisory is taken over automatically, so a retry after a crashed run proceeds.
3. When `flags.already_connected` is true, do not ask again. Healthy means `tracking_api_key_present: true`, `tracking_api_key_matches: true`, `tracking_endpoint_matches: true`, `online.checked: true`, `online.key_enabled: true`, and no advisory that you judge requires action. Append `{"ts":"<now>","run":"connect","state":"done"}` only for that healthy state. A missing/mismatched seam or an advisory that needs action takes the recovery steps below without presenting a second offer.
4. Otherwise, when the Explorer is active, append `{"ts":"<now>","run":"connect","state":"offer"}`. Then present the decision. Explain: `See registered tools and their activity in AgentLane. Your built tools stay in this project.` The Explorer owns the exact button copy:
   - `Connect WebMCP Kit to AgentLane`
   - `Connect to AgentLane`
   - `Skip for now`
   - success: `Connected — N tools ready`

   In a chat-only run, do not create Explorer state or journals. Present the same explanation followed by the two choices `Connect to AgentLane` and `Skip for now`, then end the turn and wait for the developer's explicit choice. Treat that reply and the exact entry-module path in the approved Phase-D plan as the decision record below; never infer either from silence or search for a replacement path.

When the Explorer is active, the browser sends a durable `connect` event with payload `{"action":"connect"}` or `{"action":"skip"}`. Handle and acknowledge it by the normal journal rules in `references/interactive.md`. A chat-only reply has no browser event to acknowledge; the conversation is its approval record.

Every developer-facing Explorer or conversation string in this step must avoid the words mint, token, scope, telemetry, API key, and origin. Never echo CLI fields, error codes, or error prose. On failure say only that the connection did not finish, the built tools are unchanged, and the developer may retry or skip.

## Skip

For `{"action":"skip"}` or the equivalent chat reply, append `{"ts":"<now>","run":"connect","state":"skipped"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Do not run the CLI and do not touch the entry module. Continue docs/PR work with the built tools unchanged.

## Connect or recover

1. Resolve the approved entry module beneath the workspace and preserve its exact bytes before doing anything. In an Explorer run, re-read `plan.json.entry_module` and append `{"ts":"<now>","run":"connect","state":"start"}`. In a chat-only run, use the exact relative `entry_module` path from the approved Phase-D plan and create no Explorer artifacts. A missing, absolute, escaping, or changed path is a failure; never search for or choose a different `registerTools` call during Connect.
2. Run the current host's plugin-root entry with `connect --workspace <workspace> --json`. Parse stdout as JSON. Never scrape human output.
3. Proceed only when the process succeeds and the result has `status: "connected"`, `edge_verification: "ready"`, and a non-empty `api_key.value` beginning `wmk_`. When present, `ingest_url` must be an absolute HTTP(S) URL ending in `/v1/collect` and must match `.webmcp/connect.json.ingest_url`. A pending, disabled, cancelled, malformed, or failed result is a failure: restore the exact preserved bytes, append `{"ts":"<now>","run":"connect","state":"failed"}` only when Explorer state exists, explain in the conversation that the built tools are unchanged and the developer may retry or skip, then acknowledge an Explorer event when one exists. Never write the seam before readiness.
4. Prepare the normal code edit against exactly the approved entry module resolved in step 1. In every existing `registerTools` batch in that module, add or replace `tracking.apiKey` with `<api_key.value>`. When `ingest_url` is present and differs from the installed SDK flavor's baked collect default, also add or replace `tracking.endpoint` with that exact URL: `tracking: { apiKey: "<api_key.value>", endpoint: "<ingest_url>" }`. Otherwise remove any existing `tracking.endpoint`, leaving `tracking: { apiKey: "<api_key.value>" }` when there are no other tracking fields. This removal is mandatory on a repeat Connect after changing from preview to an environment that advertises no override; never retain a stale endpoint. Preserve every other options/tracking field. Do not edit a tool module, duplicate a registration batch, create a second entry module, or substitute another path even if it also calls `registerTools`.
5. Reload every declared page/auth state for that registration scope. Re-run the registration rung from `references/verify.md`, confirm a real tool call's collect request targets the configured endpoint (or the installed SDK default when the seam omits it), then run the current host's plugin-root entry with `status --workspace <workspace> --json`. Success requires every entry-module batch to carry the same current key/endpoint decision, the same tools to register, `tracking_api_key_present: true`, `tracking_api_key_matches: true`, `tracking_endpoint_matches: true`, and no `key_revoked` flag.
6. If the edit, reload, registration, or status check fails, restore the preserved entry-module bytes, reload once to prove the original built tools still register, append the failed run step only for Explorer state, and acknowledge as above when an event exists. Do not weaken or remove completed tool work.
7. On success append `{"ts":"<now>","run":"connect","state":"done"}` only when Explorer state exists, then acknowledge an Explorer event when one exists. Continue docs/PR work. The Explorer derives `N` from the approved built suggestions; chat-only reports the verified count in the conversation.

Connection state written by the CLI is not the source seam. On every skip or failure the entry module must be byte-for-byte unchanged; the tool modules are never candidates for rollback.
