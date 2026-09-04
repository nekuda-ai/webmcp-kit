---
name: verify
description: Check that a locally running site's WebMCP tools register and execute correctly. Use to verify WebMCP tools, confirm document.modelContext tools appear on the right pages and auth states, or test @nekuda/webmcp-sdk tools in a browser.
argument-hint: "[base URL of the running site]"
---

# WebMCP Kit — verify

Runtime check that a site's WebMCP tools register and work. Runs standalone, and is the ladder the `implement` skill uses in its Phase F.

## Before you start
- The site must run locally. Use its own runbook (lifecycle commands, base URL, test identities) if it ships one; otherwise its own dev script. Never assume a harness exists.
- Use the browser driver shipped in this plugin. Do not ask for MCP configuration, a global `chrome-devtools` install, Playwright, or manual browser driving.

## Packaged browser driver

Resolve the plugin root once. Use `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` when the host exports one. Otherwise, take the absolute base directory shown for this skill (the directory containing this `SKILL.md`) and go up two directories. Do not guess from the repository checkout.

Run one driver session for the whole ladder:

```sh
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
if [ -z "$plugin_root" ]; then
  skill_dir="<absolute base directory for this skill>"
  plugin_root="$(cd "$skill_dir/../.." && pwd -P)"
fi
webmcp="${plugin_root}/scripts/webmcp.sh"

"$webmcp" browser status
"$webmcp" browser start
"$webmcp" browser status
"$webmcp" browser new_page "<local URL>" --output-format=json
"$webmcp" browser list_webmcp_tools <pageId> --output-format=json
"$webmcp" browser execute_webmcp_tool <pageId> <toolName> --input '<JSON object>' --output-format=json
"$webmcp" browser take_snapshot <pageId> --output-format=json
"$webmcp" browser list_console_messages <pageId> --output-format=json
"$webmcp" browser list_network_requests <pageId> --output-format=json
"$webmcp" browser stop
```

On Windows, apply the same fallback in PowerShell and use the packaged command entry:

```powershell
$pluginRoot = if ($env:CLAUDE_PLUGIN_ROOT) { $env:CLAUDE_PLUGIN_ROOT } elseif ($env:PLUGIN_ROOT) { $env:PLUGIN_ROOT } else { (Resolve-Path "<absolute base directory for this skill>\..\..").Path }
$webmcp = Join-Path $pluginRoot "scripts\webmcp.cmd"
& $webmcp browser status
& $webmcp browser start
```

Run the remaining ladder commands through `& $webmcp browser ...` and always end with `& $webmcp browser stop`.

`start` resolves the official `chrome-devtools-mcp@latest`, launches one host-session-scoped isolated headless Chrome 150+ with both `--category-experimental-webmcp` and `--enable-features=WebMCP`, and disables usage statistics and CrUX while redacting network headers. Set `WEBMCP_BROWSER_SESSION_ID` to any unique value when concurrent runs share one workspace; otherwise the entry scopes by the Claude/Codex session when available, then the workspace. It first uses a supported installed or cached browser; if none exists, on a platform published by Chrome for Testing, it downloads stable Chrome into the user cache and reuses it later. You may pass `--executable-path <path>` for a known safe test browser. On an unsupported host such as Linux arm64, install a native Chrome/Chromium 150+ and set `WEBMCP_BROWSER_PATH` instead.

If `start` fails, report its exact Node/npm, download, architecture, shared-library, or launch error and mark browser-dependent tools **could-not-verify**. Never use `sudo`, a system package manager, or a normal Chrome profile. After an interrupted run, use `status`, then `stop`, before retrying. Always stop the driver in cleanup, including after a failed rung.

## Ladder
1. **Boot.** Site starts; the baseline page renders; no *new* console errors versus a clean load.
2. **Discover.** On each declared page and auth state — check anonymous **and** signed-in where relevant — list the registered tools. Confirm each tool appears where it should, is **absent** where it should not (logged-out account tools, wrong-role tools), and unregisters on its declared exits (empty cart, logout). Navigation is the expensive unit: visit each page × auth state **once** and settle every tool's expectations for that page in that single pass — never one navigation per tool.
3. **Invoke read-only.** Call read-only tools with sample inputs; check the returned data **and** the visible ui_effect. Batch by page: invoke a page's tools in the visit that discovered them.
4. **Invoke state-changing.** Only against local/dev/seeded data, with an explicit go-ahead. **Never** fire real POSTs at third-party or production services. No safe way to invoke → don't; report could-not-verify.

## Report — one state per tool
- **verified** — registered and invoked as declared (note the rung reached).
- **failed** — did not register or errored; must be fixed or dropped, never shipped.
- **could-not-verify** — plausible but unproven (no browser, or no safe way to invoke); ships flagged.

Print a per-tool table and restate any could-not-verify items.
