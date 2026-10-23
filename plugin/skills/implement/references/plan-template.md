# Plan template

Present this in the selected review surface **before any file of the developer's is touched**. It
is not committed to the repo; it becomes the PR body after approval. The approval gate is hard:
edits → revise → re-present → proceed only on explicit approval, collected per
`references/decisions.md`. Each tool's `Description` line ships **verbatim** into the code, because
the description is the product.

```
# WebMCP plan — <site>
<one line: what the site is> · Kind: <main kind>(+<others>) · Stack: <framework / rendering>
User-agent journeys: <one line each: visitor (anonymous | role) · goal · where it starts>

## Tools
### <n>. <tool_name> — <the user-agent journey it serves, one line>
- Role: <ask_site | search | list_filter | detail | content_read | availability | add_to_cart | view_cart | update_cart | start_checkout | booking/registration/RSVP/enquiry | create/update record>
- stableKey: <domain.action>            (durable: survives renames; reused when it already exists)
- Description (ships verbatim): "<the actual description text>"
- Inputs: <param: type — meaning; closed sets as enums of visible labels; …>
- Returns: <data> · Page effect: <what the visitor sees> · Quiet read: <parameter, or none>
- Writes: none | <what changes> — completes, the agent confirms with the visitor | HANDOFF at <the step the visitor completes: card entry, sign-in>
- Annotations: readOnlyHint <true | absent> · untrustedContentHint <true | false> (answer content written by: <the site | users or third parties>)
- Lives on: <everywhere | pages …> · <auth state / role / state it needs>
- Wiring: <rung + concrete path, e.g. "calls addLineItem (src/lib/cart.ts)">; <server-side authorization confirmed, for privileged writes>
- Verification: <how it will be proven; could-not-verify expected, and why, if so>

## Needs your input
- <specific question> (default: <default>)
## Needs developer wiring (not generated)
- <user-agent journey>: <why there is no safe client path>
## Changes
new: <files> · modified: <files> · dependency: @nekuda/webmcp-sdk from npm (or its built file copied into <served path>)
entry module: <one workspace-relative path per registration scope>
## After approval
branch → code → static checks → verify (each tool ends verified / failed / could-not-verify) → PR

Nothing is written until you approve; any edit to the above re-presents the plan.
```

In a non-interactive run the plan is not presented for approval: it is recorded as written, each
*needs your input* item takes its stated default, and the last line is dropped
(`references/non-interactive.md`).
