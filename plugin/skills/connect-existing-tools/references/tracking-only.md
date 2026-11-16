# Tracking-only install — report the tools as they are

The SDK path builds or rewrites the tools with the SDK. When the developer declines that rewrite,
or a tool cannot be rewritten (cases 3 and 4 of `detection.md`), the fallback is a
**tracking-only install**: the SDK goes in only for **tool tracking**. One setup call,
`trackTools`, reports every tool the page registers, whatever built it. Tool code is unchanged;
the page gains the SDK dependency, the setup module and a trial script tag in the head (the list
below). The SDK README's *Tools you already have: `trackTools`* section is the
authority for its options and results; this file says what the Kit writes and checks.

Every change it makes, each named in the Phase-C plan:

- the SDK dependency and its lockfile change, per `implement`'s `codegen.md` → *Install*;
- one **setup module** that calls `trackTools`;
- one new first import line in the app entry, which loads the setup module;
- one plain trial script tag in the page head;
- the content security policy change of section 2, only when the site sends one;
- the `include` / `exclude` lists the developer chose;
- after Connect, the key at the setup module (`implement`'s `connect.md` step 4).

**One SDK copy.** When the site already depends on this SDK, under its name or a legacy alias
(`@nekuda/webmcp`, `@agentlane/webmcp`), upgrade that dependency in place and import
`trackTools` from it; never add a second copy. An older copy on the page double-counts calls or
adds a second catalog tool (README → *More than one copy of the SDK on a page*).

No tool module, handler, schema or registration call changes.

**Rollback.** Preserve the bytes of every file before writing it (the manifest and lockfile
included), and record every file the run creates. The install and Connect are separate
consents, so they roll back apart:

- **The install fails** (its debug check fails) **or the developer skips it:** restore every
  preserved file and delete every created one (the setup module, a vendored SDK copy): the
  dependency, lockfile, entry import, head tag and policy edits all go back.
- **Connect is declined or fails:** undo only Connect's own writes (`connect.md` step 6: the
  setup module's key and `.env.local`, plus any `connect-src` origin Connect added in section 2). The install
  stays, whole and keyless, reported **tracked, not attributed**.

Either way the tree is the site as found or a whole install, never a half-installed one.

## 1. The setup call goes first

Tool tracking reports per call only the tools registered after `trackTools` runs. A tool
registered earlier still works and is listed, but its calls are missed, and the console says
`registered_before_tracking` with its name. Static imports run before the body of the module
that imports them, so the call goes in its own module, imported on the **first line** of the app
entry, above every import that can register a tool. Take the entry from the inventory's recorded
entry modules and the framework's own config; a call in the entry's body runs too late.

**Plain app with a bundler**:

```ts
// webmcp-setup.ts
import { trackTools } from "@nekuda/webmcp-sdk";
trackTools({ tracking: { builtWith: "webmcp-kit/connect-existing-tools@<version>" } });
```

```ts
// main.ts, the entry
import "./webmcp-setup"; // first: before anything that registers tools
import "./app";
```

**Plain app with no bundler** (the browser loads the modules as written): the SDK is the vendored
copy that `implement`'s `codegen.md` → *Install* describes, and every import is a relative URL
with its extension. Derive the SDK specifier from the two served URLs: the path from the setup
module's served location to the vendored copy's (below, both under `/webmcp/`). Section 4's debug
run proves it resolves: no `debug_on` line after the canary means the module did not load.

```js
// /webmcp/setup.js
import { trackTools } from "./vendor/webmcp-sdk.js";
trackTools({ tracking: { builtWith: "webmcp-kit/connect-existing-tools@<version>" } });
```

```js
// main.js, loaded with <script type="module" src="/main.js">
import "./webmcp/setup.js"; // first: before anything that registers tools
import "./app.js";
```

The vendored file is committed with the site, and an SDK upgrade copies it again: it is the
page's one SDK copy. A classic `<script>` that registers tools runs before any module script;
its tools are listed, calls not reported (section 4).

On a site that loads a new page for each link, the entry loads from the shared layout, so the
setup call runs on every page.

**React** (Vite, Remix or any React SPA): the same setup module, imported on the first line of
the client entry (`main.tsx`; in Remix, `app/entry.client.tsx`), above `App`. Never in a
`useEffect`: React runs a child's effects before its parent's, so a component that registers
tools in its own effect gets there first.

**Next.js**: the call goes at the top level of `instrumentation-client.ts` (project root or
`src`), which Next.js runs before React hydrates. No `await` or dynamic `import()` before it.
The README's Next.js section names the version that runs this file. On an older Next.js there
is no place proven to run first: put that to the developer as a decision (upgrade, or the SDK
path) instead of guessing one.

`builtWith` follows `migration.md`'s stamp rule (the *Invariants* line on `builtWith`), `<version>` included.

## 2. The trial script tag in the head

Stable Chrome turns WebMCP on only with a flag or a trial token. A connected `trackTools` call
loads the trial script itself, but site code that checks for the WebMCP surface once at load, as
hand-written and third-party registrations often do, checks before that load ends and never
registers. So the Kit adds the script as a static tag in the shared head, where it runs before
any app code: `<script src="<trial script URL>"></script>`, with the URL exactly as the installed
SDK's README gives it (`node_modules/@nekuda/webmcp-sdk/README.md` → *Chrome's WebMCP trial
token*). The README is its owner; copy it from there on each run, never from memory.

Plain (no `async`, no `defer`, no `type="module"`), and above every script tag of the app. The SDK
sees the tag and loads no second copy. Put it where the framework writes the document head:
the shared layout or `index.html` for a plain or Vite app, the root layout for Next.js. A
framework can rewrite a head tag (add `async`, move it below its own scripts), so the step is
done only when the HTML the dev server serves holds the tag, plain, above the app's first
script; check it there, not in the source. When the framework will not serve it that way (for
example a Next.js App Router layout), mark the step unverified and put the choice to the
developer: accept that SDK-loaded trial timing (a registration that checks for WebMCP once at
load may miss it), or the SDK path. 

When the site sends a content security policy, the install adds the SDK's default hosts that
the installed README's *Content security policy* section names (`script-src` for the trial script,
`connect-src` for the ingest host), so its reports leave the page before Connect and after a
declined one. Connect adds the origin of the ingest URL its answer gives, which it writes as `tracking.endpoint` to
`connect-src` only when that origin differs from the default, in the same change as its seam
edit, and rolls it back with that edit. Name each change in the plan, and make it only where the
policy lives in this repo.

## 3. Which tools to report

Every tool is reported unless the developer chooses otherwise. Ask once, in the Phase-C plan,
with "report every tool" as the stated default. A developer's choice becomes `include` (the only
tools to report) or `exclude` (tools never to report; a name in both is not reported). Both are
lists of wire names, exactly as the inventory recorded them. A tool left out still registers,
exactly as before; only its reports stop.

## 4. Check the data with `debug`, then go live

Before Connect, add `debug: true` to the setup call and reload each recorded page × auth state
in the verification browser (the `verify` skill's recipe). In debug mode nothing leaves the
page; each event that would have been sent prints to the console instead (README → *Check the
data first*). Then invoke each tool that is safe under `inventory.md`.

Before Connect there is no key, so only the anonymous channel prints. Each printed line reads
`debug_not_sent: anonymous <event>` and carries the event object; the tool names are in that
object, so read them there, not in the line: each `tool_registration` entry in `tools` carries the
tool's `name` and `stableKey`; an anonymous `tool_call` carries only `tool.stableKey`, so match
a call to its tool by that key. An excluded tool's registration prints a `tool_registration`
whose `tools` is empty: that is expected. A `tools` cut down to a count (not a list) names no
tool: treat that page as unchecked.

**With a key already set** (a rerun on the tracking-only fast path): the anonymous lines print as
above (`tool_contract` lines may join them; the check does not read them); each call also prints `debug_not_sent: keyed`
lines whose objects carry `eventName` `tool_call_request` and `tool_call_response` and the
tool's `toolName`. The Pass rule reads the same, and a call counts when either its anonymous
`tool_call` or its keyed pair names the tool.

**Prove the console first.** A console reader can miss page output (a remote browser over CDP
can deliver none). Before reading the result, print a canary from the page (`console.info` a
unique string through the browser tool's script evaluation) and confirm the reader shows it. No
canary means the check could not run, never "nothing printed".

- **Pass:** the console says `debug_on`; the `tool_registration` objects name every reported
  tool, and each safe invocation prints a `tool_call` whose `tool.stableKey` is that tool's; no object names an excluded
  tool; every tool still behaves as the Phase-B baseline recorded, and no
  `registered_before_tracking` warning appears beyond the listed-only tools below.
- **Refused:** `debug_refused` means the page refused debug mode and events are still sent. Stop
  the check, remove `debug`, and report it unverified.
- **Nothing printed:** usage reporting is off on this page (the site turned it off, or the
  browser sends Global Privacy Control). Never turn it on against the site's choice. The
  registration half stays unverified: registrations and descriptions go out on that same
  channel. Calls can still be checked after Connect: add `debug` to the connected setup call,
  invoke each safe tool, and read `debug_not_sent: keyed` lines, whose objects carry
  `eventName` `tool_call_request` and `tool_call_response` and the tool's name. That run ends by
  removing `debug` and reloading, before `connect.md` step 5 checks the install. Otherwise mark
  the check unverified.
- **Fail:** `registered_before_tracking` for a tool the app's own module graph registers (move
  the setup call earlier, section 1), a tool missing that the page registers, an excluded tool
  printed, or any change in tool behavior. Fix the install, or roll back.
- **Listed, calls not reported:** `registered_before_tracking` for a tool registered by code that
  runs before any module can (a classic `<script>` in the head, such as a vendor's). Its
  registration and description are still reported; its calls are not. Not a failure: name those
  tools in the plan and the report, and that moving their script after the app's entry is the
  developer's call.

**Rerun check.** Run this file's steps once more on the result: they must propose no change (one
setup module, one head tag, the same lists). A second setup module or tag is a fail.

Then remove `debug` and reload: debug mode lasts until the page reloads, and a later call
without it does not turn it off. A setup call that still carries `debug` is never committed or
handed over; on a live page it stops every report from every visitor.

## 5. Connect and report

Connect is `implement`'s `connect.md`, unchanged, with the setup module as the approved entry
module: step 4 writes the key into the `trackTools` call's `tracking`. A site that also has SDK
batches (case 1, or tools migrated in the same run) has two registration scopes, the setup module
and the batches' entry module, and runs Connect once for each, per `migration.md`. A batch with
no key is reported by its own batch only, never by tool tracking: the console's
`sdk_batch_without_key` names such tools.

The setup module gets no publish offer (`connect.md` says why): say instead that the tools
appear in AgentLane once a page with the install loads.

Each tool ends in one of the tracking-only states that `verify-connection.md` → *Report* lists. The report names the install as tool tracking,
and says that rebuilding the tools with the SDK stays open as a later step.
