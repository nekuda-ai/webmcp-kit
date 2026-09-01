# Phase D — migrate the registration layer

Goal: the same tools, registered through `@nekuda/webmcp-sdk`, behaving identically.

## Invariants

- Handler body, schema, business logic, and visible effect are preserved. Only registration moves.
- `name` is set **explicitly** to the original wire name. The SDK defaults `name` to `stableKey`,
  so omitting it silently renames the tool for every agent that already calls it.
- `stableKey` follows `stable-keys.md`. An existing one is immutable.
- `source: "merchant_authored"` on adopted definitions.
- Registration moves into `registerTools` batches at the entry-module seam — one entry module per
  registration scope, exactly as the `implement` skill's two-module shape describes.
- A duplicate `name` or `stableKey` within a batch is a hard SDK error. Resolve it with the
  developer before registering, never by renaming a wire name.
- Cases 3 and 4 from `detection.md` are not migrated. They are reported plainly: the current SDK
  cannot reliably connect that tool, and here is what it is.

## Order of work

1. Install the SDK per the `implement` skill's `references/sdk.md` — the **resolved name** rule
   applies here too, and a workspace that already vendors the SDK under a legacy alias keeps that
   alias. Start the install as a background task; the rewrites below do not need it, only the first
   typecheck does.
2. Rewrite case-2 definitions (below), one file at a time, leaving handlers untouched.
3. Move registration to the entry-module seam.
4. Delete the now-dead native registration calls — and nothing else.
5. Static pass (the repo's own typecheck/lint/build) before Phase E touches a browser.

Case-1 tools skip steps 2–4 entirely: they are already registered through the SDK, so the only work
is the connection.

## Case 2 — native `modelContext`, rewritten

Before:

```ts
// src/agent/tools.ts
navigator.modelContext.registerTool({
  name: "add_to_cart",
  description: "Add a product to the cart by SKU.",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  async execute({ sku }) {
    const res = await fetch("/cart/add", { method: "POST", body: JSON.stringify({ sku }) });
    if (!res.ok) throw new Error(`add to cart failed: HTTP ${res.status}`);
    return await res.json();
  },
});
```

After — the definition is wrapped, not rewritten:

```ts
// src/agent/tools.ts
import { defineTool } from "@nekuda/webmcp-sdk";

export const addToCart = defineTool({
  stableKey: "adopted.add_to_cart",   // derived per stable-keys.md; immutable from here on
  name: "add_to_cart",                // EXPLICIT — the original wire name, unchanged
  source: "merchant_authored",
  description: "Add a product to the cart by SKU.",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  async execute({ sku }: { sku: string }) {
    const res = await fetch("/cart/add", { method: "POST", body: JSON.stringify({ sku }) });
    if (!res.ok) throw new Error(`add to cart failed: HTTP ${res.status}`);
    return await res.json();
  },
});
```

The `execute` body moved character-for-character. If it did not — if a type annotation had to be
invented, an argument destructured differently, an `await` added — that is a rewrite, and it needs
the developer's approval as a named change in the Phase-C plan, not a quiet edit inside a migration.

`defineTool` validates eagerly and throws `TypeError` at module load on a bad definition, so a
definition that does not survive the move fails at the first static pass rather than in a visitor's
browser. Keep `defineTool` at **module scope** — never inside a component or an effect.

Field mapping, exhaustively: `name` → `name` (verbatim), `description` → `description` (verbatim),
`inputSchema` → `inputSchema` (verbatim), `execute` → `execute` (verbatim), `annotations` →
`annotations` (verbatim). A field the native call carried that has no `defineTool` equivalent is not
dropped silently: it is raised in Phase C as a named question, because dropping it *is* a behavior
change.

Two fields `defineTool` is stricter about than the native surface, so check both in Phase B and put
either one to the developer in Phase C rather than discovering it at module load:

- **`description` is required.** `defineTool` rejects a missing or blank one; the native
  `registerTool` treats it as optional. A tool that has none cannot be migrated until the developer
  supplies one — and that new text is a named change in the plan, not a sentence invented mid-edit.
- **`name` must match `[A-Za-z0-9_.-]{1,128}`.** A wire name outside it cannot be adopted, because
  the only way to satisfy the pattern is to rename the tool, which this skill never does. Report it
  as *needs manual migration* with the reason.

Neither is a soft failure: `defineTool` throws at module evaluation, and one bad definition takes
down the whole entry module's registration — every tool in the batch, including the ones that
migrated cleanly. Typecheck and lint do not evaluate module bodies, so the static pass in
`verify-connection.md` will not catch it either.

## Registration moves to the entry module

The native call registered at import time. The SDK registers in a batch whose lifetime the entry
module owns — and the gate recorded in the inventory moves with it, unchanged:

```tsx
// src/webmcp/WebmcpProvider.tsx
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { addToCart } from "../agent/tools";

export function WebmcpProvider({ signedIn }: { signedIn: boolean }) {
  useEffect(() => {
    if (!signedIn) return;                       // the SAME gate the native call had
    const reg = registerTools([addToCart]);
    return () => reg.unregister();
  }, [signedIn]);
  return null;
}
```

The framework-specific shapes — React/Vite provider, the Next App Router `"use client"` registrar,
the server-templated MPA `pagehide` module, the unbundled static case — are the `implement` skill's
`references/codegen.md`, unchanged. Read them there; do not re-derive a seam here.

Two failure modes worth naming, because both diff clean on names alone:

- **A lost gate.** A tool that registered only when signed in, or only with a non-empty cart, and
  now registers unconditionally, has been widened. The inventory's `registered: false` rows are
  what catch this — keep them in the Phase-E diff.
- **A lost unregister.** The native code may have called `unregisterTool` on some exit. The SDK's
  only mechanism is `unregister()` or aborting the batch's `signal`; wire the same exit to it.

One batch per registration scope. Splitting one native scope across two batches, or merging two
scopes into one, changes which tools are present together — that is a behavior change too.

## Cases 3 and 4 — report, never guess

Do not rewrite. Do not import the third-party SDK and "adapt" it. Do not reconstruct a handler from
a schema the browser reported. The report for each is three lines: the wire name, where it lives
(file and line, or *browser-observed only*), and the reason it cannot be connected automatically —
an unrecognized registration path, or no locatable defining source. Then the one thing the developer
can do about it: point at the source, or migrate it by hand using the case-2 recipe above.

A run whose entire finding list is cases 3 and 4 ends with that report and nothing written. That is
a correct outcome, not a failed one.

## Connect

Connect is not re-specified here. It defers to the `implement` skill's
`references/connect.md` — login, provisioning, the readiness gate, the entry-module seam edit, and
the rule that a non-interactive run skips it. Read that file, and follow it as written, with the
one multi-scope amendment stated below.

Two things it assumes, which this skill must have already done: every migrated tool is registered
through `registerTools` (Connect writes `tracking` into *existing* batches — it never creates one),
and the entry module's exact workspace-relative path was recorded in the inventory. Connect resolves
that recorded path and never searches for another plausible `registerTools` call.

**Once per registration scope, not once per run.** That flow writes `tracking` into every
`registerTools` batch in *one* approved entry module and is explicitly forbidden from substituting
another path that also calls `registerTools`. This skill routinely produces more than one entry
module — one per registration scope, above — so run it once for each entry module the inventory
recorded, and prove arrival (`verify-connection.md`) once per scope. A run that connects one scope
and reports the rest as **connected** is claiming attribution for tools whose batches carry no
`tracking` at all: those tools send nothing to the collect endpoint, so nothing later contradicts
the claim. Scopes left unconnected are reported **migrated, not attributed**.

**The amendment: scope each run's success gate to the scope it connected.** `connect.md` step 5
reads success off the CLI status report's **top-level** `tracking_api_key_present`,
`tracking_api_key_matches` and `tracking_endpoint_matches`. Those fields are computed across
*every* `registerTools` batch the CLI finds anywhere in the workspace, which is the right gate for
a single-scope site and the wrong one here: after the first of two scopes is written, the second
scope's batches still carry no `tracking`, so all three read false, step 6 restores the first
scope's bytes, and no run can ever leave any scope connected. Read the per-batch
`registration_batches[]` array instead, and for each run require, of exactly the batches whose
`path` equals the entry module that run approved: `tracking_api_key` true,
`tracking_api_key_matches` true, `tracking_endpoint_matches` true. Everything else in step 5 —
the same tools registering, no `key_revoked` flag, the reload and the re-run of the registration
rung — is unchanged, and so is step 6's rollback on failure, which still restores only that run's
entry module. The top-level three are the **final** check, after the last scope: they are what
distinguishes "every scope connected" from "the ones we got to". On a site with exactly one
registration scope the two gates are the same check, so follow `connect.md` as written.

## Rollback

Preserve the exact bytes of every file before touching it, and restore them all on any failure —
the entry modules **and** the tool modules. This differs deliberately from the `implement` skill's
rule, where tool modules are never rollback candidates: there they are the new work, here they are
the developer's existing, working code. A half-migrated tree is never a terminal state; a tool that
registered before this skill ran registers after it fails.
