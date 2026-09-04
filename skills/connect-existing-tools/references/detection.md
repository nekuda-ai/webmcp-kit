# Phase A — detect the existing registrations

Goal: an exhaustive, classified list of every WebMCP tool this site already registers, produced
without writing anything to the tree.

## Classification (every finding lands in exactly one case)

1. **Already on this SDK** — registered through `@nekuda/webmcp-sdk` or one of its legacy aliases
   `@agentlane/webmcp` / `@nekuda/webmcp`. No tool code changes; the connection is all that is
   missing.
2. **Native** — registered directly against `document.modelContext` / `navigator.modelContext`.
   Migrates through the registration layer.
3. **Other SDK** — a recognized third-party call shape. Inventoried and reported as *needs manual
   migration*; never rewritten by guess.
4. **Source unavailable** — observed in the running site but no defining source could be located.
   Reported honestly; migration is source-level, so there is nothing to safely rewrite.

Precedence when a tool matches more than one: **1 beats 2 beats 3**, because the case describes the
registration path the tool actually travels, and a wrapper is what registers it. A tool defined
with a third-party helper but registered through `registerTools` is case 1 — connecting it needs no
code change even though its definition looks foreign. Case 4 is never a match, it is a *residue*:
what the runtime shows and the source cannot explain.

## The sweeps — issue them as one parallel batch

These read different files and do not depend on each other. Send their Reads/Greps together; never
one file per turn.

**S1 — manifests and resolution.** `package.json` (every workspace), `composer.json`, import maps
(`<script type="importmap">`), vendored SDK directories, bundler aliases. Establishes the
**resolved name** the site imports the SDK under — an alias in `package.json` means the import
specifier in source is not the package identity. Every later sweep matches on the resolved name,
not on a name copied from this file.

**S2 — this SDK.** Grep for the resolved name and the three known spellings, plus the API surface:

```
@nekuda/webmcp-sdk|@agentlane/webmcp|@nekuda/webmcp
\bdefineTool\b|\bregisterTools\b
```

Each `defineTool` call is a finding. Record its existing `stableKey` verbatim — it is immutable
(`stable-keys.md`) and a re-run adopts it rather than deriving a new one.

**S3 — the native surface.** Grep for the spec surface and its registration verbs:

```
document\.modelContext|navigator\.modelContext|\bmodelContext\b
\.registerTool\s*\(|\.provideContext\s*\(|\.unregisterTool\s*\(
```

A bare `modelContext` local (destructured, aliased, or passed as a parameter) is why the second
pattern exists on its own: `const mc = navigator.modelContext; mc.registerTool(...)` is invisible
to the first. Follow each alias to the surface it came from before classifying.

**S4 — third-party shapes.** Recognize by **shape**, not by a trusted package list: a definition
object carrying a name plus a description plus an input schema, handed with a callable to some
registration entry point. The named shapes worth grepping first:

```
@mcp-b/|TabServerTransport|@modelcontextprotocol/sdk
window\.mcp\b|window\.__WEBMCP__|globalThis\.mcp\b
\bregisterAgentTool\b|\baddTool\s*\(|\btools\.register\s*\(
```

This list only *labels* a finding. It never authorizes a rewrite, so a wrong entry here costs a
label and nothing else — which is exactly why it may be generous. Anything matched by shape but not
by name is still case 3.

**S5 — the running site.** Source shows what is *written*; only the browser shows what actually
*registers*. Resolve the plugin's browser driver once, without host bias:

```sh
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
if [ -z "$plugin_root" ]; then
  skill_dir="<absolute base directory for this skill>"
  plugin_root="$(cd "$skill_dir/../.." && pwd -P)"
fi
webmcp="${plugin_root}/scripts/webmcp.sh"

"$webmcp" browser status
"$webmcp" browser start
"$webmcp" browser new_page "<local URL>" --output-format=json
"$webmcp" browser list_webmcp_tools <pageId> --output-format=json
"$webmcp" browser stop
```

On Windows use `$env:CLAUDE_PLUGIN_ROOT`, then `$env:PLUGIN_ROOT`, then
`(Resolve-Path "<absolute base directory for this skill>\..\..").Path`, and run `scripts\webmcp.cmd`.
The driver's requirements, flags, and failure handling are the `verify` skill's, unchanged — read
them there rather than restating them here. Visit each declared page **once** per auth state and
list its tools in that single pass; navigation is the expensive unit, not the tool.

This pass is read-only in the strongest sense: **list** tools, never execute them. An invocation
during detection can mutate the site before the developer has approved anything.

## Reconcile source against runtime — the difference is the finding

The union of S2–S5 is the candidate list. The two differences carry the information:

- **In the browser, not in the source** → case 4. Record the page, the wire name, and the schema
  the browser reports, then say plainly that the defining source could not be located. Bundled,
  minified, injected by a tag manager, or served by a third party are all the same outcome here:
  migration is source-level, so there is nothing safe to rewrite.
- **In the source, not in the browser** → not case 4 and not a failure. The registration is gated
  (auth state, route, feature flag, cart state) or dead. Record which, and which gate. A gated tool
  migrates normally; the gate moves with it. A dead one is reported, never quietly revived.

## No runnable browser

S5 is skipped, not faked. Classify on source alone, and mark the finding list **runtime-unverified**
in the Phase-C plan: case 4 cannot be detected at all without a runtime pass, so the honest claim is
"every tool the source defines", not "every tool the site registers".

## Finding record

One row per tool, carried forward into `inventory.md`:

| field | content |
|---|---|
| `wire_name` | exact name agents see |
| `case` | 1–4 above |
| `registration_path` | the call that registers it, with file and line |
| `definition_site` | file and line of the definition, or *browser-observed only* |
| `existing_stable_key` | verbatim if present (immutable), else empty |
| `gate` | the auth state / route / condition it registers under, or *unconditional* |
| `evidence` | `source`, `runtime`, or `both` |

`evidence: source` on a case-1 or case-2 row is the one that most often turns out to be a gate
nobody remembered. Resolve it in Phase B rather than carrying an unexplained row into the plan.
