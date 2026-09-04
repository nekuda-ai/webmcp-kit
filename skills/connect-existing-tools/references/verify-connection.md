# Phase E — prove behavior survived and the connection is attributed

Two claims, proven separately. Neither is assumed from the other.

## 1. Behavior is unchanged

Re-run the inventory and diff it against the Phase-B baseline: names, schemas, invocation results,
errors, availability per page and auth state, and visible effects. Names alone are not a diff — a
tool can register under the right name and return the wrong thing.

Then prove idempotency: a second pass over the migrated tree proposes zero changes.

### Static first

The repo's own typecheck, lint, and build, relative to the baseline recorded before any write. A
`defineTool` that lost a required field, or an `execute` whose types no longer line up, fails here
— cheaply, and before a browser is involved. A failure that the baseline already had is not this
skill's, and is neither attributed to the migration nor fixed by it.

### Then the runtime diff

Resolve the browser driver exactly as `detection.md` does, and re-walk the same route × auth state
matrix the inventory recorded — once per pair, settling every tool in that single pass:

```sh
"$webmcp" browser start
"$webmcp" browser new_page "<local URL>" --output-format=json
"$webmcp" browser list_webmcp_tools <pageId> --output-format=json
"$webmcp" browser execute_webmcp_tool <pageId> <toolName> --input '<JSON object>' --output-format=json
"$webmcp" browser take_snapshot <pageId> --output-format=json
"$webmcp" browser list_console_messages <pageId> --output-format=json
"$webmcp" browser list_network_requests <pageId> --output-format=json
"$webmcp" browser stop
```

Compare against the baseline, field by field:

| baseline field | passes when |
|---|---|
| `wire_name` | byte-identical. A renamed tool is a broken contract with every agent already calling it. |
| `input_schema` | byte-identical. |
| `annotations` | byte-identical — `readOnlyHint` is a promise agents act on. |
| `availability` | every `registered: true` row still true **and every `registered: false` row still false**. |
| `samples[].result` | byte-identical to the recorded verbatim result. |
| `samples[].ui_effect` | the same visible change. |
| error samples | the same failure path still fails, with the same shape. |

The `registered: false` rows are the half most easily skipped and the half most worth keeping: a
migration that widens a gated tool passes every other row in this table.

A tool whose baseline had `samples: []` — no safe way to invoke it in an isolated environment —
cannot reach a clean behavior claim here. It ends **could-not-verify on behavior**, stated as such,
never quietly counted as connected.

### Idempotency

Re-run Phases A–C against the migrated tree without writing. It passes when the proposed change set
is empty: every migrated tool is now case 1, carries the `stableKey` the first run wrote, and needs
no further edit. A non-empty proposal here is a real finding — usually a `stableKey` that was
derived rather than read back, which means the identity is not durable yet. Fix it before shipping.

On a half-migrated repo this same property is the useful one: the proposal contains exactly the
tools not yet migrated, and nothing else.

## 2. The connection is attributed

Attributed arrival is the claim, not "a request was sent". Anonymous observations are on by
default before anything is connected, so their presence proves nothing about this step.

The proof has three parts: the CLI's healthy status flags, a ready edge verification, and one real
invocation whose beacon is observed **arriving at the configured endpoint** and drawing
**no rejection message in the browser console**.

Both halves of part 3 are required, and the second alone is worthless. The SDK only inspects the
response of a beacon it actually keyed — a page that was never given a key sends anonymously and has
nothing to be rejected, so it is silent too. Silence is therefore consistent with "the key was
accepted" *and* with "no key was ever sent", which is precisely the failure this phase exists to
catch (an entry module Connect never reached — see `migration.md`, once per registration scope).
Observe the keyed request first; only then does silence mean the key was accepted.

### The three parts, in order

1. **Configuration** — the CLI's own status report for this workspace, read as JSON, never scraped
   from prose. It must show the tracking configuration present and matching, the endpoint matching,
   the online check performed, and the key enabled, with no revoked advisory. This proves the seam
   is wired; it proves nothing about the browser.
2. **Readiness** — the Connect result's `edge_verification: "ready"`. This proves the far side
   accepted the site's registration; it proves nothing about the page the visitor loads.
3. **Runtime** — load a declared page **of this registration scope**, invoke one real tool, and
   observe both:
   - `list_network_requests` shows the invocation's request going to the **configured** endpoint
     (or the installed SDK's default when the seam deliberately omits an override), and accepted.
     Read the request, do not infer it: a batch that never received `tracking.apiKey` sends nothing
     here at all, and "no request" is not "a request that worked". The *arrival* is the key
     evidence, not a header you read — this transport fires only when a key is configured, and the
     browser entry redacts request headers, so do not ask for the header value or treat its
     absence from the listing as a finding.
   - `list_console_messages` shows **no** rejection message from the SDK — one naming the SDK,
     saying usage is still being recorded anonymously, and pointing at re-running Connect.

Repeat part 3 for every registration scope the inventory recorded. One scope proven attributed says
nothing about the others; they each carry their own seam.

Part 3 is the only one of the three that observes what a visitor's browser actually does, which is
why the other two cannot stand in for it.

### Reading the console signal correctly

The message appears **at most once per page load**, and it is emitted by the SDK's own default
usage reporting — a *different* channel from the one the invocation's request above rides, which
runs whether or not a tool is ever called. Three consequences:

- **Absence is only evidence on a page that reported at all.** A page loaded, left idle, and read
  in the same second may simply not have sent yet. Invoke a tool, then read the console: the
  invocation guarantees there was something to report.
- **Once per page load means once.** Reading the console after a reload that already produced the
  message, then reloading again and reading only the second page's messages, can miss it. Read the
  messages for the page you invoked on.
- **A page that opted out of the default reporting is silent no matter what.** That channel has its
  own opt-outs, independent of the one the invocation rides: the `registerTools` option that turns
  it off, the page-level global, and Global Privacy Control. Under any of them nothing is ever
  reported, so nothing can be rejected, and this half of part 3 says nothing at all. It does not
  block the claim — the arrival above is what carries it — but record that the signal was
  unavailable rather than counting the silence as evidence.

The SDK never throws and never retries on this path, so the message is the *only* client-visible
symptom. A silent console with a failing network tab is a different problem — a blocked request, a
CSP rule, an offline dev machine — and is reported as such, not as a rejected key.

### When part 3 cannot run

No runnable browser, or Connect skipped or declined. Then parts 1 and 2 stand alone and the honest
claim is "configured", not "attributed". Say which part is missing and what it would have proven.
Do not promote a configuration check into an arrival claim; that is the exact confusion this phase
exists to prevent.

## Report — one state per tool

- **connected** — migrated (or already on this SDK), behavior diff clean, attributed arrival seen.
- **failed** — behavior changed, or registration broke. Roll back; never ship a changed tool.
- **needs manual migration** — cases 3 and 4 from `detection.md`. Ships flagged, with the reason.

Two qualifiers ride alongside, because collapsing them into the three states above would overstate
what was proven:

- **could-not-verify on behavior** — migrated, static pass clean, but no safe invocation existed to
  diff against. Ships flagged.
- **migrated, not attributed** — behavior diff clean, connection not proven (skipped, declined, or
  no browser). The migration stands on its own; re-running the connection is how it finishes.

Print the per-tool table, then restate every non-**connected** row and its reason in the summary and
in the PR body. A failed row blocks the PR. The flagged ones do not — they are the honest edge of
what this run could prove.
