# @nekuda/webmcp-sdk v0.4.0 — exact API surface

**Resolved name — the rule for every specifier.** Wire and import the SDK under the
name the **installed package's own `package.json` declares**, never a name copied
from these docs or inferred from a date. A workspace may vendor a source-exporting
copy under a legacy alias such as `@nekuda/webmcp`, or install the built registry
package as `@nekuda/webmcp-sdk`. Every dependency
entry, generated import, import-map key and bundler config uses that one resolved
name. Examples in these references spell it `@nekuda/webmcp-sdk`.

## Wiring
- **Vendored source copy:** local dependency — npm/pnpm `file:<vendor-dir>`, yarn
  berry `portal:./<vendor-dir>`, yarn 1 `link:./<vendor-dir>`. These copies export TS
  source (`exports "."` → `src/index.ts`), so a Next.js consumer must add
  `transpilePackages: ["<resolved name>"]`; other bundlers need the equivalent
  transpile opt-in for a source-exporting dependency.
- **Built registry package:** a normal `@nekuda/webmcp-sdk` dependency — ships a
  prebuilt ESM bundle (`dist/index.js`) plus types, so no transpile step.
- **No bundler (PHP/static MPA):** serve the package's `dist/index.js` and map the
  resolved name to it with `<script type="importmap">`.

## API
`defineTool<TInput>` requires `TInput extends Record<string, unknown>` — declare the input shape as a `type`, not an `interface` (interfaces have no implicit index signature and fail the constraint).
```ts
import { defineTool, registerTools } from "@nekuda/webmcp-sdk";

const tool = defineTool({        // validates eagerly + freezes; NO side effects
  stableKey: "cart.add",         // REQUIRED durable id, dot-namespaced domain.action;
                                 // authored once, never changed on re-runs; never sent to browser
  name: "add_to_cart",           // optional wire name, 1-128 of [A-Za-z0-9_.-]; defaults to stableKey
  title: "Add to cart",          // optional display name
  description: "…",              // REQUIRED non-empty
  inputSchema: { type: "object", /* JSON Schema */ },  // optional plain object
  annotations: { readOnlyHint: true },                 // optional
  async execute(input) { /* page-owned; THROW on failure or missing anchors */ },
});                              // invalid definition throws TypeError at module eval

const reg = registerTools([tool], {
  signal,                        // optional AbortSignal lifetime; abort == unregister
  // tracking: { … }             // opt-in analytics; omit unless asked
});
// reg: { ready: Promise<ToolRegistrationResult[]>, unregister(): void, signal: AbortSignal }
// per-tool state: "registered" | "unsupported" (no WebMCP surface — graceful no-op)
//               | "aborted" | "failed" (e.g. duplicate name). `ready` never rejects.
```

## Rules
- Two-module shape (React): register in `useEffect`, cleanup `return () => reg.unregister()` —
  the entry module owns the lifetime.
- Never touch `document.modelContext` / `navigator.modelContext` directly — the wrapper pins the spec.
- One batch per scope; a duplicate `name` or `stableKey` within a batch throws (fails the whole `registerTools` call).
- `execute` may return any JSON value, a string, or `{ content: [...] }` — the SDK normalizes.
