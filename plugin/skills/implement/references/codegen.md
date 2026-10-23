# Generate with `@nekuda/webmcp-sdk`

Generated code calls the SDK, never `document.modelContext` directly: the SDK tracks the draft
spec, finds whichever surface the browser exposes, and does nothing where WebMCP is missing, so the
same code ships to every browser.

## Install

- **Add the npm package** `@nekuda/webmcp-sdk` with the repo's own package manager (the one its
  lockfile belongs to), so the lockfile records it. It is a browser ES module with types and no
  runtime dependencies. Start the install as a background task the moment generation is approved
  and write tool modules while it runs: only the first typecheck waits for it.
- **Already a dependency:** keep the repo's version when its `dist/index.d.ts` has every field the
  code below uses; otherwise put the upgrade in the plan.
- **No bundler** (server-rendered or static pages loaded as-is): a browser cannot resolve the bare
  package name. Copy the package's built `dist/index.js` (from `npm pack @nekuda/webmcp-sdk` or a
  dev install) into the served tree, for example `public/webmcp/vendor/webmcp-sdk.js`, and import
  it by relative URL. Keep every module of that graph under the same served root. An import map
  is not enough: static review cannot prove the server's CSP lets its inline script run.

## `defineTool(definition)`

Validates eagerly, freezes, and touches no browser: a bad definition throws `TypeError` when the
module loads, so the first static pass or page load catches it. Nothing registers until
`registerTools`. The SDK requires `stableKey`, `description` and `execute`; generated code also
sets every other field marked yes.

| field | generated code | rule |
|---|---|---|
| `stableKey` | yes | Durable identity, `domain.action` in lowercase `[a-z0-9_]` segments joined by dots (`cart.add`, `catalog.search`). Authored once and **never changed on re-runs**: reuse every key found in step 1, and never copy the wire `name`. Never sent to the browser. |
| `name` | yes | The wire name agents see: snake_case `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, unique on the site. Set it explicitly; the SDK would otherwise fall back to the dotted `stableKey`. |
| `description` | yes | Ships verbatim from the approved plan. |
| `inputSchema` | when the tool takes input | `{ type: "object", properties, required, additionalProperties: false }`; a closed set is an `enum` of the labels the visitor sees. |
| `annotations` | per role | `{ readOnlyHint: true }` on a tool that writes nothing; `untrustedContentHint: true` when its answer carries user or third-party content. Writes and handoffs carry no `readOnlyHint`. |
| `source` | yes | Always `"merchant_authored"`: the tool lives in the site's own code. It is what separates a Kit-built or hand-written tool from one a hosted snippet built off a manifest, so never write `scanner_generated`. |
| `intent` | yes | `"answer"` for a read, `"act"` for a write, `"transact"` for a step on the way to payment (checkout, a paid booking). |
| `pages` | for a page-scoped tool | Path patterns where it is offered: `*` within one segment (`/products/*`), `**` across segments (`/docs/**`), hash routes too (`/#/item/*`). Omitted means every page. The SDK adds and removes the tool on navigation, SPA routes included. |
| `title`, `version` | optional | A display name; your own version string. |
| `execute(input)` | yes | The planned wiring path, verbatim. Returns any JSON value, a string, or `{ content: [...] }`. **Throws** an `Error` whose message is written for the agent on failure or a missing anchor; the SDK hands that message to the agent as an error result. A read that finds nothing returns the empty answer with its `message`, never a throw. |

Declare the input as a named `type` (`defineTool<AddToCartInput>`), not an `interface`: an
interface fails the `Record<string, unknown>` constraint on `defineTool<TInput>`.

## `registerTools(tools, options?)`

Returns `{ ready, current(), unregister(), signal }`. `ready` never rejects; each tool settles
`registered`, `unsupported` (no WebMCP in this browser: nothing happened, nothing to do), `aborted`,
or `failed` (the browser refused it; the reason is on `error`). It throws only for two tools in one
call sharing a `name` or `stableKey`, so keep **one batch per registration scope**.

| option | generated code |
|---|---|
| `tracking.builtWith` | Always set, per the stamp below. |
| `tracking.apiKey`, `tracking.endpoint` | Never by hand: Connect writes them (`references/connect.md`). |
| `signal` | An `AbortSignal` lifetime; aborting it equals `unregister()`. |
| `onChange(names)` | Called with the live names after navigation changes them. |
| `tracking.otel`, `tracking.disabled`, `tracking.sessionId`, `telemetry` | The site's own analytics and consent choices; add one only when the developer asks. |

The SDK's anonymous usage telemetry is on by default and independent of Connect; the README that
ships in the package states what it sends and how to turn it off.

## The two-module shape

- **Tool modules** at each planned `source_module`: `defineTool` at module scope, exported, no side
  effects, importable anywhere (tests, server code).
- **One entry module per registration scope** at the planned `entry_module`: it imports the tools
  and calls `registerTools`, and it owns their lifetime. Connect later edits only this module's
  `tracking` option; tool modules never change.
- **The stamp.** Every generated `registerTools` call passes
  `{ tracking: { builtWith: "webmcp-kit/implement@<version>" } }`, where `<version>` is this
  plugin's manifest version, read from whichever host manifest ships beside these skills
  (`.claude-plugin/plugin.json`, else `.codex-plugin/plugin.json`). When this skill came from
  the AgentLane MCP, no manifest ships beside it: `<version>` is then `mcp`
  (`webmcp-kit/implement@mcp`); do not search the machine for a manifest. Write the real value;
  `<version>` is a placeholder in these examples, never something to ship. The skill name is part
  of the stamp, so a site this skill generated and one `connect-existing-tools` migrated stay
  distinguishable. That one string is how the platform counts Kit-built sites without a Connect,
  so never omit it and never invent a version.

Name the app's own modules the way the repo does; these examples spell them `@/…`.

```ts
// <srcroot>/webmcp/tools/site.ts — ask_site over the site's own information
import { defineTool } from "@nekuda/webmcp-sdk";

type Section = { name: string; path: string; text: string; alsoAnswers?: string };

// Generated from the repo's own pages and copy: one entry per section a visitor asks about. The
// entry page answers questions about the site itself, so `alsoAnswers` gives it the words visitors
// call the site by.
const SECTIONS: Section[] = [
  { name: "Welcome", path: "/", text: "A family pottery studio in Leeds, open since 2009.", alsoAnswers: "site website shop store" },
  { name: "Returns policy", path: "/policies/returns", text: "Return unused items within 30 days for a refund." },
  { name: "Sign in", path: "/login", text: "Sign in with your email and password, or with Google." },
];

// Question words, pronouns and short function words: they name no topic.
const STOP_WORDS = new Set([
  "what", "how", "where", "when", "who", "which", "why", "the", "a", "an", "is", "are", "was",
  "do", "does", "did", "can", "could", "i", "me", "my", "you", "your", "we", "our", "us", "it",
  "its", "this", "that", "to", "of", "in", "on", "for", "at", "by", "with", "from", "and", "or",
  "about",
]);
const stems = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ""))
    .filter((stem) => stem.length > 1);

type AskSiteInput = { query: string };

export const askSite = defineTool<AskSiteInput>({
  stableKey: "site.ask",
  name: "ask_site",
  source: "merchant_authored",
  intent: "answer",
  description:
    "Answer a visitor's question about this site from its own pages: what it is and offers, where things are, its policies, FAQ and posts, and how sign-in works. Returns the matching sections with their page paths, best first; an empty list means the site does not cover the question. For products, use search_products.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "The visitor's question, in their words" } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute({ query }) {
    const asked = stems(query);
    const items = SECTIONS.map((section) => {
      const own = new Set(stems(`${section.name} ${section.text} ${section.alsoAnswers ?? ""}`));
      return { section, hits: asked.filter((word) => own.has(word)).length };
    })
      .filter(({ hits }) => hits * 2 > asked.length) // most of the question's words, never half
      .sort((a, b) => b.hits - a.hits)
      .map(({ section }) => ({ name: section.name, excerpt: section.text, path: section.path }));
    if (items.length === 0) return { items, count: 0, message: `Nothing on this site answers "${query}".` };
    return { items, count: items.length };
  },
});
```

```ts
// <srcroot>/webmcp/tools/catalog.ts — a read that does what the search box does
import { defineTool } from "@nekuda/webmcp-sdk";
import { searchProducts as searchCatalog } from "@/lib/catalog"; // the app's own data layer
import { router } from "@/lib/router";

type SearchProductsInput = { query: string; show_results?: boolean };

export const searchProducts = defineTool<SearchProductsInput>({
  stableKey: "catalog.search",
  name: "search_products",
  source: "merchant_authored",
  intent: "answer",
  description:
    "Search the shop's products by keywords and show the results page, as the site's search box does. Returns each match's id, name, price and url. Set show_results to false to get the matches without changing the page.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords, e.g. 'blue mug'" },
      show_results: { type: "boolean", default: true },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute({ query, show_results = true }) {
    const products = await searchCatalog(query);
    if (show_results) router.push(`/search?q=${encodeURIComponent(query)}`);
    if (products.length === 0) return { items: [], count: 0, message: `No products match "${query}".` };
    return { items: products, count: products.length };
  },
});
```

```ts
// <srcroot>/webmcp/tools/cart.ts — a write that completes, and a handoff
import { defineTool } from "@nekuda/webmcp-sdk";
import { getCustomer } from "@/lib/account";
import { addLineItem, getCart } from "@/lib/cart";
import { listDeliveryOptions, setContact, setDeliveryOption, setShippingAddress } from "@/lib/checkout";
import { router } from "@/lib/router";

type AddToCartInput = { product_id: string; quantity?: number };

export const addToCart = defineTool<AddToCartInput>({
  stableKey: "cart.add",
  name: "add_to_cart",
  source: "merchant_authored",
  intent: "act",
  description:
    "Add a product to the visitor's cart, as the product page's Add to cart button does; the cart badge updates. Use the id search_products returns. Returns the cart's item count and the line added.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The id search_products returns" },
      quantity: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["product_id"],
    additionalProperties: false,
  },
  async execute({ product_id, quantity = 1 }) {
    const cart = await addLineItem(product_id, quantity); // the same call the button makes
    const line = cart.lines.find((entry: { productId: string }) => entry.productId === product_id);
    if (!line) throw new Error(`The cart did not accept product ${product_id}.`);
    return { item_count: cart.itemCount, line };
  },
});

type Address = { name: string; line1: string; city: string; postcode: string; country: "United Kingdom" | "Ireland" };
type StartCheckoutInput = {
  email?: string;
  shipping_address?: Address;
  delivery_option: "Standard delivery" | "Express delivery";
};

// The checkout's country select: the label the visitor sees, and the code the store keeps.
const COUNTRY_CODES = { "United Kingdom": "gb", Ireland: "ie" } as const;

export const startCheckout = defineTool<StartCheckoutInput>({
  stableKey: "checkout.start",
  name: "start_checkout",
  source: "merchant_authored",
  intent: "transact",
  description:
    "Check out the visitor's cart up to payment, as the checkout's own steps do: saves their email, shipping address and delivery option, then opens the payment step, where the visitor enters their card themselves. A signed-in visitor's saved email and address are used when left out. Returns the payment step the visitor now sees, with the cart, the delivery and the total.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "For the order confirmation; leave out for a signed-in visitor" },
      shipping_address: {
        type: "object",
        description: "Leave out to use a signed-in visitor's saved address",
        properties: {
          name: { type: "string" },
          line1: { type: "string" },
          city: { type: "string" },
          postcode: { type: "string" },
          country: { type: "string", enum: ["United Kingdom", "Ireland"] },
        },
        required: ["name", "line1", "city", "postcode", "country"],
        additionalProperties: false,
      },
      delivery_option: { type: "string", enum: ["Standard delivery", "Express delivery"] },
    },
    required: ["delivery_option"],
    additionalProperties: false,
  },
  async execute({ email, shipping_address, delivery_option }) {
    const cart = await getCart();
    if (cart.itemCount === 0) throw new Error("The cart is empty, so there is nothing to check out.");
    const customer = await getCustomer(); // the signed-in visitor, or null
    const contact = email ?? customer?.email;
    const address = shipping_address
      ? { ...shipping_address, country: COUNTRY_CODES[shipping_address.country] }
      : customer?.shippingAddress;
    if (!contact || !address) throw new Error("Checkout needs the visitor's email and shipping address.");
    // The calls the checkout's own contact, address and delivery steps make, in their order.
    await setContact(contact);
    await setShippingAddress(address);
    const options = await listDeliveryOptions(); // what the delivery step offers for this address
    const option = options.find((entry: { label: string }) => entry.label === delivery_option);
    if (!option) {
      const offered = options.map((entry: { label: string }) => entry.label).join(", ");
      throw new Error(`"${delivery_option}" is not offered for this address. Offered: ${offered}.`);
    }
    const checkout = await setDeliveryOption(option.id);
    // A checkout that takes no card places the order here instead and returns its confirmation.
    router.push("/checkout/payment");
    return {
      handoff: { url: "/checkout/payment", heading: "Payment" },
      cart: { lines: checkout.lines, delivery: delivery_option, total: checkout.total },
      message: "Email, address and delivery are saved. The visitor enters their card on the payment step.",
    };
  },
});
```

## Entry modules — one per registration scope

Resolve the exact workspace-relative entry-module path while planning. In an Explorer run it is
`plan.json.entry_module`, and each tool's module is that suggestion's `source_module`; generate and
revise exactly those files, and derive the Explorer's review copy from them, never the reverse.
Connect later edits this recorded path and never searches for another `registerTools` call.

**React SPA / Vite** — a provider at the app root; the effect owns the lifetime:

```tsx
// <srcroot>/webmcp/WebmcpProvider.tsx
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { addToCart } from "./tools/cart";
import { searchProducts } from "./tools/catalog";
import { askSite } from "./tools/site";

export function WebmcpProvider() {
  useEffect(() => {
    const reg = registerTools([askSite, searchProducts, addToCart], {
      tracking: { builtWith: "webmcp-kit/implement@<version>" },
    });
    return () => reg.unregister();
  }, []);
  return null;
}
```

**State- and auth-gated tools** register only while their state holds — a non-empty cart, a
signed-in user, a role — on an effect keyed on the app's existing state, and unregister when it
goes away:

```tsx
// <srcroot>/webmcp/CheckoutTools.tsx
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { useCart } from "@/lib/cart";
import { startCheckout } from "./tools/cart";

export function CheckoutTools() {
  const hasItems = useCart().itemCount > 0;
  useEffect(() => {
    if (!hasItems) return;
    const reg = registerTools([startCheckout], { tracking: { builtWith: "webmcp-kit/implement@<version>" } });
    return () => reg.unregister();
  }, [hasItems]);
  return null;
}
```

**Next App Router** — the registrar is a client component (`"use client"`) mounted in
`app/layout.tsx`; `registerTools` runs only in the browser, never in a server component:

```tsx
// <srcroot>/webmcp/registrar.tsx
"use client";
import { useEffect } from "react";
import { registerTools } from "@nekuda/webmcp-sdk";
import { askSite } from "./tools/site";

export function WebmcpRegistrar() {
  useEffect(() => {
    const reg = registerTools([askSite], { tracking: { builtWith: "webmcp-kit/implement@<version>" } });
    return () => reg.unregister();
  }, []);
  return null;
}
```

**Server-templated pages with a bundler** — one module loaded with `<script type="module">` from the
shared layout; register on load, unregister on `pagehide`:

```ts
// <srcroot>/webmcp/entry.ts
import { registerTools } from "@nekuda/webmcp-sdk";
import { askSite } from "./tools/site";

const reg = registerTools([askSite], { tracking: { builtWith: "webmcp-kit/implement@<version>" } });
addEventListener("pagehide", () => reg.unregister(), { once: true });
```

**No bundler** — the entry module is the browser-served file itself (for example
`public/webmcp/entry.js`), importing the copied SDK and the tool modules by relative URL. After a
cold server restart, load a declared page and require every module request in that graph to return
2xx before claiming registration.

Match the repo: TypeScript → `.ts`/`.tsx`; JavaScript → `.js`/`.jsx` without type annotations.
Follow its lint and format config, path aliases, and where its other client modules live.
