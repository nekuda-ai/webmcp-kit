---
name: verify
description: Check that a locally running site's WebMCP tools register and execute correctly. Use to verify WebMCP tools, confirm document.modelContext tools appear on the right pages and auth states, or test @nekuda/webmcp-sdk tools in a browser.
argument-hint: "[base URL of the running site]"
---

# WebMCP Kit — verify

Runtime check that a site's WebMCP tools register and work. Runs standalone, and is the ladder the `implement` skill uses in its Phase F.

## Before you start
- The site must run locally. Use its own runbook (lifecycle commands, base URL, test identities) if it ships one; otherwise its own dev script. Never assume a harness exists.
- WebMCP must be active in the browser: Chrome 150+ with the WebMCP flag (`chrome://flags`, enabled for localhost) — or load `@mcp-b/webmcp-polyfill` as backup. Confirm `document.modelContext` (or `navigator.modelContext` on Chrome 149) exists before testing.
- Browser automation is tool-agnostic: a chrome-devtools MCP, a CLI driver, or a guided manual check all work.

## Ladder
1. **Boot.** Site starts; the baseline page renders; no *new* console errors versus a clean load.
2. **Discover.** On each declared page and auth state — check anonymous **and** signed-in where relevant — list the registered tools. Confirm each tool appears where it should, is **absent** where it should not (logged-out account tools, wrong-role tools), and unregisters on its declared exits (empty cart, logout).
3. **Invoke read-only.** Call read-only tools with sample inputs; check the returned data **and** the visible ui_effect.
4. **Invoke state-changing.** Only against local/dev/seeded data, with an explicit go-ahead. **Never** fire real POSTs at third-party or production services. No safe way to invoke → don't; report could-not-verify.

## Report — one state per tool
- **verified** — registered and invoked as declared (note the rung reached).
- **failed** — did not register or errored; must be fixed or dropped, never shipped.
- **could-not-verify** — plausible but unproven (no browser, or no safe way to invoke); ships flagged.

Print a per-tool table and restate any could-not-verify items.
