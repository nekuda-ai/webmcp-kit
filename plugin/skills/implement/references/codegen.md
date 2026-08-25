# Codegen — `@nekuda/webmcp-sdk` v0.5.0 (contract v1)

Add the SDK dependency per `references/sdk.md` and use the **resolved name** it defines — the installed package's own declared name — in every import and config below; the samples here spell it `@nekuda/webmcp-sdk`. Generated code imports **only** `defineTool` / `registerTools` — never the raw browser surface, never a bundled polyfill. The SDK owns surface detection (which global the browser exposes) and no-ops gracefully when unsupported, so generated code makes no browser-surface claims of its own. (The concrete surface names live only in `references/verify.md`.)

**No JS bundler / package manager** (a PHP or static MPA with no `package.json`): a bare `import { … } from "<resolved name>"` will not resolve in the browser. Deliver the SDK as a pinned local ESM asset the page can load — vendor its ESM build into the repo and reference it via an **import map** (`<script type="importmap">` mapping the resolved name to that file), or pre-bundle the entry module. Never inject a bare specifier a browser can't resolve, and never pull it from an untrusted CDN at runtime.

## `defineTool(definition)` → validated, frozen tool
Side-effect-free: validates eagerly and throws `TypeError` at module load on a bad definition (an authoring bug), not on a visitor's browser. Nothing registers until `registerTools`.

| field | required | rule |
|---|---|---|
| `stableKey` | yes | Durable identity, dot-namespaced `domain.action` (`cart.add`). **Authored once, never changed on re-runs** — the platform keys on it later; reuse any `stableKey` inventoried in Phase A rather than minting a new one for the same tool. `name` may change freely; this may not. Never sent to the browser. |
| `name` | yes | WebMCP wire name, 1–128 chars of `[A-Za-z0-9_.-]`, snake_case verb phrase, unique across the site. |
| `title` | no | Human-readable display name. |
| `description` | yes, non-empty | The product — the agent picks by name + description. Ships **verbatim** from the approved plan. Also state any consequence ("places an order"). |
| `inputSchema` | no | Plain JSON Schema object: `{ type: "object", properties, required, additionalProperties: false }`. |
| `annotations` | no | `{ readOnlyHint?, untrustedContentHint? }`. Pure reads → `readOnlyHint: true`. User/third-party content → `untrustedContentHint: true`. No destructive hint exists. |
| `execute(input)` | yes | Page-owned; the Phase-C wiring path verbatim. Return any JSON value, a string, or `{ content: [...] }` — the SDK normalizes. **Throw on failure and on missing anchors/data** — never succeed-on-missing (a silent success poisons the drift signal). Thrown errors propagate to the agent. A read that finds nothing is not a failure: return the empty result plus an explicit note field saying the site has no matching content — never throw, never a bare `[]`. |

## `registerTools(tools, { signal? })` → `{ ready, unregister, signal }`
- Registers the batch immediately. **Unregister only** via `unregister()` or by aborting `signal` — the spec's sole (AbortSignal) mechanism. No `unregisterTool` / `provideContext`.
- `ready`: `Promise<result[]>`; never rejects. Per-tool `state` is `registered` | `unsupported` | `aborted` | `failed`.
- No WebMCP surface → graceful no-op (`unsupported`); generated code runs unconditionally.
- Duplicate `name` or `stableKey` in one batch throws — **one batch per registration scope**.

## Two-module shape (the connect-later guarantee)
The SDK's documented anonymous usage observations are default-on and independent of Connect.
Connecting the site to the platform later changes only the entry-module wrapper config, adding
`tracking.apiKey` to its existing `registerTools` options; tool modules never change. Do **not**
add that publishable key during tool generation — the optional post-build flow in
`references/connect.md` owns it after Connect reports the edge ready and the CLI confirms
readiness.

```ts
// <srcroot>/webmcp/tools/cart.ts  — generated tool module (no side effects)
import { defineTool } from "@nekuda/webmcp-sdk";

export const addToCart = defineTool({
  stableKey: "cart.add",
  name: "add_to_cart",
  title: "Add to cart",
  description: "Add a product to the shopping cart by SKU. Updates the cart badge.",
  inputSchema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Product SKU" },
      quantity: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["sku"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
  async execute({ sku, quantity }: { sku: string; quantity?: number }) {
    const res = await fetch("/cart/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku, quantity: quantity ?? 1 }),
    });
    if (!res.ok) throw new Error(`add to cart failed: HTTP ${res.status}`);
    return await res.json();
  },
});
```

## Irreversible/cost-bearing writes — stop at a reversible boundary
A payment, cancellation, or delete must not complete in one agent call. Design the tool to stop at a reversible handoff and let the human finish, e.g. a checkout tool that creates the pending order/session and navigates to the payment UI — it never charges:

```ts
async execute() {
  const session = await createCheckoutSession(); // repo's own client data layer
  location.assign(session.paymentUrl);           // human completes payment here
  return { checkoutSessionId: session.id, status: "pending_payment" };
}
```

For a delete/cancel with no payment step, use a **prepare→confirm** pair: `prepare_cancel` returns what will be affected plus a short-lived token; a separate `confirm_cancel` requires that token. One agent call can never do the irreversible thing alone. The plan's `Confirmation` line records which boundary each write tool uses.

## Entry modules — one per registration scope

Resolve the exact workspace-relative entry-module path during Phase C. In an interactive run,
record it as `plan.json.entry_module` before proposal and create or update exactly that path after
submit. Connect later reuses this recorded path; it never searches the workspace for a plausible
`registerTools` call.

Resolve each tool module at the same time and record its workspace-relative POSIX path as that
suggestion's `source_module`. Generate and revise exactly that file, then derive the Explorer's
review copy from it; never treat `.webmcp/<id>.code.md` as an authoring source.

**React SPA / Vite** — a provider at app root; lifetime tied to the component:
```tsx
// <srcroot>/webmcp/WebmcpProvider.tsx
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { addToCart } from "./tools/cart";

export function WebmcpProvider() {
  useEffect(() => {
    const reg = registerTools([addToCart]);
    return () => reg.unregister();
  }, []);
  return null;
}
```

**Next App Router** — the registrar **must be a client component** (`"use client"`): `registerTools` runs only in the browser. Never call it from a server component or module-scope in a server-rendered file — it would run during SSR (no browser surface) or never reach the client. Mount the `"use client"` registrar in `app/layout.tsx` for everywhere-tools; a separate per-page client component bakes in page params for contextual tools:
```tsx
// <srcroot>/webmcp/registrar.tsx
"use client";
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { askSite } from "./tools/site";

export function WebmcpRegistrar() {
  useEffect(() => {
    const reg = registerTools([askSite]);
    return () => reg.unregister();
  }, []);
  return null;
}
```

**Server-templated MPA / static** — a module included via `<script type="module">` in the shared layout; register on load, unregister on `pagehide`:
```ts
// <srcroot>/webmcp/entry.ts
import { registerTools } from "@nekuda/webmcp-sdk";
import { askSite } from "./tools/site";

const reg = registerTools([askSite]);
addEventListener("pagehide", () => reg.unregister(), { once: true });
```

For an unbundled static site, `entry_module` is the browser-served module itself (for example,
`public/webmcp/entry.js`), not an authoring module left outside the served asset root. Keep every
relative import in that browser graph beneath the same served root. After a cold server restart,
load the declared page and require every module request in the graph to return 2xx before claiming
registration verification.

Auth/role-gated scopes: put the register/unregister on an effect (or conditional include) keyed on the app's existing session/role state — see `references/wiring.md`.

State-gated tools (e.g. `update_cart_item`, `start_checkout`) register **only when their required state exists** — a non-empty cart, a selected entity. Gate them at the entry-module registrar the same way (effect/include keyed on that state); registering them unconditionally is a broken contract with the agent.

Match the repo: TypeScript → `.ts`/`.tsx`; JavaScript → `.js`/`.jsx` (drop type annotations). Honor the repo's lint/format config, path aliases, and where its other client modules live.
