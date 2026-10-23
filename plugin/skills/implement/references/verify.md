# Verify — how and what

Shared by the `verify` skill and the `implement` flow. Every tool ends in exactly one state:
**verified** (name the rung reached), **failed** (fix it or drop it; known-broken code never
ships), or **could-not-verify** (ships flagged, with the reason). Failed blocks the hand-over;
could-not-verify does not.

## Run the repo the way it documents itself

Take install, build, lint, format, typecheck and test commands, how to start the app and the
services it needs, and its seeded test accounts from the repo itself: its README, `AGENTS.md` or
contributing guide, package scripts, Makefile, compose files. Take machine facts (which services
are already running, a browser this machine provides) from the machine's own setup notes or the
developer.

## Baseline, before your first write

Record whether the repo already typechecks, lints, builds and boots cleanly. Capturing it writes
nothing, so it never waits: start the static half as a background task while the repo is being read,
and record the boot half when the dev server first comes up. A baseline that is already broken is
not your change: report it, leave unrelated code alone, and mark the affected tools
could-not-verify.

## The ladder

1. **Static** — every check the repo defines: typecheck, lint, format check, build, and the unit
   tests that cover the files you touched. A check passes on its exit status, with its full output
   read; a crashing linter or a filtered exit is unresolved, not passed. Start a watch-mode
   typechecker as a background task at the first write (once the SDK install has landed, since an
   unresolved SDK import before then is the install in flight), check the files just written as you
   go, and run the full set once after the last write. A new failure from your change → **failed**;
   fix formatting with the repo's own formatter.
2. **Boot** — start the app and its services as a background task when generation starts, so this
   rung checks a server that is already up. Load the declared pages; no console error that the
   baseline did not have. Cannot boot while the baseline booted → **failed**; the baseline could not
   boot → **could-not-verify**.
3. **Registration** — on each declared page and auth state (anonymous **and** every signed-in role
   the plan names), list the registered tools once and settle every expectation for that page in
   that pass: each tool is present where it should be, **absent** where it should not be (account
   tools signed out, another role's tools), and gone after its exits (an emptied cart, sign-out).
   Navigation is the expensive unit: one visit per page × auth state, never one per tool. No WebMCP
   surface in the browser → **could-not-verify**.
4. **Read-only invocation** — call each read-only tool with realistic input in the visit that
   listed it, and check both the answer and the page effect. `ask_site` gets a question one of the
   site's pages answers, and one the site does not cover. A plan with no writes ends here.
5. **Writes on seeded data** — only against a positively confirmed local, development or seeded
   environment with a test account, and with the developer's go-ahead (the approved plan's
   Verification line counts). Confirm the **persisted** change by reading it back (the list, the
   record, a count), never by a 2xx or a navigation alone. For a handoff, confirm the visitor lands
   on the handoff step with their choices kept, and never drive the card or credential step. No
   confirmed isolated environment → **could-not-verify**.

## The browser

Use the plugin's own browser entry. On Unix, resolve it without host bias:

```sh
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
if [ -z "$plugin_root" ]; then
  skill_dir="<absolute base directory for this skill>"
  plugin_root="$(cd "$skill_dir/../.." && pwd -P)"
fi
webmcp="${plugin_root}/scripts/webmcp.sh"
"$webmcp" browser status
```

The base directory is the host-shown directory containing the active skill's `SKILL.md`; do not
guess it from the repository checkout. On Windows use `$env:CLAUDE_PLUGIN_ROOT`, then
`$env:PLUGIN_ROOT`, then `(Resolve-Path "<absolute base directory for this skill>\..\..").Path`, and
run `scripts\webmcp.cmd`. It needs no MCP configuration, global CLI or Playwright. With no
`scripts/webmcp.sh` there (this skill came from the AgentLane MCP), run the same pinned driver
through npx, as the `verify` skill's *Without the plugin* section shows.

- **Launch.** Run `status`, then `start` once. The entry resolves
  `chrome-devtools-mcp@1.10.1` (pinned) and runs one host-session-scoped, isolated, headless Chrome 150+ with
  `--category-experimental-webmcp` and `--enable-features=WebMCP`, privacy flags, safe executable
  discovery, and a cached Chrome for Testing where that project publishes a build. Set
  `WEBMCP_BROWSER_SESSION_ID` to any unique value for concurrent runs in one workspace. On a host
  Chrome for Testing does not cover (such as Linux arm64), point `WEBMCP_BROWSER_PATH` at a native
  Chrome or Chromium 150+.
- **Attach.** When the machine's setup notes name a dedicated test browser that already runs,
  is WebMCP-capable and exposes the Chrome DevTools Protocol (a remote, CI or headless machine,
  often with no Chrome to launch), set `WEBMCP_BROWSER_URL` to its endpoint, for example
  `http://127.0.0.1:9222`. `start` then attaches to it instead of launching Chrome, and every other
  command is the same. Point it only at that dedicated test browser, never the developer's own
  browser or profile: the writes on seeded data run in whatever session it holds.
- **Drive.** Use JSON output for page and tool commands, batch the ladder by page, read the console
  and network, and always `stop` in cleanup, including after a failed rung.
- **Failure.** If startup reports a Node or npm, download, architecture, shared-library or launch
  error, keep its exact cause and mark browser-dependent tools **could-not-verify**. Use only the
  entry's own isolated profile, or the attached dedicated test browser: no `sudo`, system package
  manager or personal Chrome profile. An interrupted run recovers with `status`, then `stop`,
  before one retry.

## Report

A per-tool table: the state, the rung reached, and the evidence. Restate the could-not-verify items
and the user-agent journeys that need developer wiring. In `implement`, this table goes into the PR
body.
