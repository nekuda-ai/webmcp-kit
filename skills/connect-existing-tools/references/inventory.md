# Phase B — inventory the tools before anything changes

Goal: the baseline Phase E diffs against. It is captured **before** any file is written and is
never re-derived from the migrated tree afterward — a baseline read back out of the thing it is
meant to check proves nothing.

## Per tool

- wire name (exact, as agents see it)
- input schema (verbatim)
- pages and routes it is available on
- auth state required, and where it is deliberately absent
- handler location: exact workspace-relative source path, or *browser-observed only*

A browser-observed entry carries names and schemas only. A handler needs source, so such an entry
cannot leave case 4 of `detection.md` on inventory evidence alone.

## The record

Write the inventory to `.webmcp/connect-existing-tools/baseline.json` in the workspace, one entry
per Phase-A finding, and never stage it into the migration commit — not even when the repo already
tracks `.webmcp/`, which the `implement` skill routinely leaves it doing. It is agent state, and
its `samples[].result` rows are **verbatim** responses from real invocations against a real
environment: whatever those handlers return — order records, account data, seeded fixtures
indistinguishable from either — lands in the diff and then in the PR the moment it is staged. If
the repo tracks `.webmcp/`, leave the file untracked explicitly rather than relying on nobody
running `git add -A`. It exists to be compared, so it must survive the migration turn — an inventory held
only in the conversation is gone the moment the context is compacted, and Phase E then has nothing
to diff against but the tree it just wrote.

```json
{
  "captured_at": "<ISO-8601>",
  "runtime_verified": true,
  "tools": [
    {
      "wire_name": "add_to_cart",
      "case": 2,
      "definition_site": "src/agent/tools.ts:41",
      "registration_path": "src/agent/tools.ts:78",
      "existing_stable_key": "",
      "input_schema": { "type": "object", "properties": {}, "required": [] },
      "annotations": { "readOnlyHint": false },
      "availability": [
        { "route": "/product/:sku", "auth": "anonymous", "registered": true },
        { "route": "/product/:sku", "auth": "signed-in", "registered": true },
        { "route": "/account", "auth": "signed-in", "registered": false }
      ],
      "samples": [
        { "input": { "sku": "ABC-1" }, "result": "<verbatim>", "ui_effect": "cart badge 0 → 1" }
      ],
      "evidence": "both"
    }
  ]
}
```

`runtime_verified: false` records that Phase A had no browser. Everything downstream that leans on
runtime evidence — case 4, availability, samples — is then absent rather than assumed, and Phase E
says which claims it could not make.

## Availability is a matrix, not a page list

A tool is available on a **route × auth state** pair, and "absent" is as much a fact as "present".
An account tool that registers for a logged-out visitor is a bug today; if the inventory records
only where the tool appears, the migration can silently widen it and the diff will call that clean.
Record `registered: false` rows explicitly for every route × auth state the tool is *expected* to
be missing from — those rows are the ones that catch a gate lost in the move.

Reuse Phase A's navigation: each route × auth state was already visited once and its tool list
already read. Inventory is that same pass, written down.

## Samples — what makes the diff mean anything

A diff over names and schemas proves the registration layer moved. It does not prove the tool still
*works*. Capture, per tool, at least one invocation:

- **Read-only tools** — invoke with a realistic input; record the verbatim result and the visible
  effect.
- **State-changing tools** — only against a confirmed isolated environment (local, dev, seeded
  data, a test account). If isolation cannot be positively confirmed, **do not invoke**: record
  `samples: []` with the reason, and Phase E marks that tool's behavior claim unproven rather than
  faking it. Never fire a write at production or a third-party service to fill in a baseline.
- **Errors are behavior too.** Where a tool has a cheap, safe failure path (missing required input,
  unknown id), capture that too — the error message and shape are part of what agents consume, and
  a migration that turns a thrown error into a resolved empty value is a behavior change the
  happy-path sample cannot see.

Record the result **verbatim**. A summary of a result is a second chance to be wrong, and Phase E
compares bytes.

## Handler location

The exact workspace-relative POSIX path plus the symbol name, resolved now. Phase D edits exactly
these paths and never searches for a plausible alternative later — the same discipline the Connect
flow applies to the entry module. A finding whose handler cannot be resolved to a path stays case 4
no matter how confident the browser evidence looks.

Record the **entry module** for each registration scope in the same pass: the file that owns the
registration call and, after Phase D, the `registerTools` batch. Connect writes its single tracking
field into exactly that file.

## Before moving on

The inventory is complete when every Phase-A finding has a row, every row's `case` is settled, and
every case-1 and case-2 row has a handler path. Unresolved rows are not carried silently into the
plan: they appear in Phase C as case 3 or case 4 with the reason, which is a legitimate outcome and
an honest one.
