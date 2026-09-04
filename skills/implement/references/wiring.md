# Wiring — safe call paths, placement, confidence

## Safe call path = client-reachable only
`execute` runs in the visitor's browser on the page's session. Pick the **highest available rung** per tool:

1. **The app's own client data layer** — its API client, hooks, or store actions. Rides the session and keeps the UI in sync. Preferred.
2. **A same-origin HTTP route the client already calls** — `fetch` to the app's own API.
3. **The app's own client-side actions for ui_effect** — router navigation, invoking the app's existing form handler.
4. **Build-time content bundle** — the `ask_site` rung-1 path for static content.

**Never:** server-only imports (DB clients, secrets, non-exposed server actions), third-party endpoints, or DOM-scraping the app's own UI when a data path exists.

**Privileged mutations:** a route that enforces authn/authz only by hiding a client button is not a safe path — wrapping it exposes the mutation to any agent. Wrap a privileged write only when its route enforces authorization **server-side**; otherwise list it as `needs developer wiring`.

**No safe client path for a journey → list it in the plan as `needs developer wiring`. Never fake it** with invented data or a dead call.

## Registration placement (stack-neutral — no stack is privileged)

| stack | everywhere-tools | contextual tools | auth/state-conditioned |
|---|---|---|---|
| **React SPA / Vite** | one provider component at app root; `useEffect(() => { const reg = registerTools([...]); return () => reg.unregister(); }, [])` | per-route/per-page component; `useEffect` keyed on the route/params so it re-registers with the current entity baked in | effect keyed on the session/cart state the app already exposes; register on state-true, `reg.unregister()` on state-false |
| **Next App Router** | a `"use client"` registrar component mounted in the root `layout.tsx` | per-page `"use client"` component that bakes in the page's params | registrar reads the client session hook; effect deps include auth/role |
| **Server-templated MPA / static (PHP, etc.)** | a `<script type="module">` include in the shared layout that calls `registerTools` on load | per-template page module included only on the relevant templates | conditionally include the script by the server-rendered auth state, or gate inside it on a client session check |

Auth/state-conditioned registration is an effect on the app's **existing** session/cart/role state: register when the condition is true, `unregister()` when it goes false. A registration left live past its valid target is a broken contract.

## Confidence rule (decided vs needs-your-input)
Every tool passes through the Phase-D plan review regardless. Within the plan, mark each tool:

- **decided** — BOTH hold: (a) the journey is a **must-have of the matched category**, AND (b) a **rung-1 or rung-2** wiring path exists with **corroborating evidence** — the route, its handler, and a UI element all agree on the same operation.
- **needs your input** — anything else: ambiguous domain semantics, competing flows for the same journey, a great-to-have, an uncertain category match, or only a rung-3/4 path. State a **specific question** and a **stated default** so the developer can approve fast or redirect.
