# Plan template (R2 — the key interaction)

Present this in the selected review surface **before any file is touched**. Not committed to the customer repo by default; it becomes the PR body after approval. The approval gate is hard: edits → revise → re-present → proceed only on explicit "approve". No answer → stop unless the run is explicitly non-interactive. Each tool's `Description` line ships **verbatim** into the code, because description is the product.

The per-tool block below extends the base skeleton with `Annotations` and `Confirmation` lines so classifications and write boundaries are reviewed in the plan, not chosen silently at codegen time.

```
# WebMCP plan — <site>
<one-line what the site is> · Category: <primary>(+<secondary>) · Stack: <framework/rendering>
Proposing N tools (category norm: X–Y)

## Tools
### <n>. <tool_name> — <journey intent, one line>
- stableKey: <domain.action>            (durable — survives renames; reused if it already exists)
- Description (ships verbatim): "<the actual description text>"
- Inputs: <param: type — meaning; …>
- Reads/Writes: read-only | STATE-CHANGING — <consequence sentence>
- Annotations: readOnlyHint <true|false> · untrustedContentHint <true|false> (returned content authored by: <site | users/third parties>)
- Confirmation: <none (read-only) | none (reversible write) | HANDOFF — stops at <pending state>, human completes in <UI> | PREPARE→CONFIRM (token)>
- Lives on: <pages/auth states; context behavior, e.g. "product page bakes in viewed SKU">
- Returns: <data> · Page effect: <ui_effect>
- Wiring: <rung + concrete path, e.g. "calls existing addToCart (src/lib/data/cart.ts)"; server-side authz confirmed for privileged writes>
- Verification: <how it will be proven; expected 'could-not-verify' if applicable>

## Needs your input
- <specific question> (default: <default>)
## Needs developer wiring (not generated; never faked)
- <journey>: <why no safe client path>
## Changes
new: <files> · modified: <files> · dependency: <resolved SDK name> from <source>
  — the installed package's declared name (`references/sdk.md`), e.g. `@nekuda/webmcp`
  from `file:vendor/nekuda-webmcp`, or `@nekuda/webmcp-sdk` from npm
## After approval
branch → code → verify (each tool ends verified / failed / could-not-verify) → PR

Human run: reply approve, or edit anything above — nothing is written until you do. Explicit non-interactive run: proceed on the stated defaults above; each becomes a recorded assumption (see Degrade paths).
```
