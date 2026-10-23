# Wiring — safe call paths, placement, confidence

## Safe call path: client-reachable only

`execute` runs in the visitor's browser on the page's session. For each tool take the **highest
available rung** and name the concrete path (file and function):

1. **The app's own client data layer** — its API client, hooks or store actions. It rides the
   session and keeps the UI in sync. Preferred.
2. **A same-origin HTTP route the client already calls** — `fetch` to the app's own API.
3. **The app's own client-side actions** — router navigation, the app's existing form handler.
4. **A content index generated from the repo** — `ask_site` over content the repo holds.

Server-only imports (database clients, secrets, server actions the client cannot reach),
third-party endpoints, and scraping the app's own DOM when a data path exists are not call paths.

**Privileged writes:** a route that enforces authorization only by hiding a button in the client is
not a safe path, because wrapping it exposes the write to any agent. Wrap a privileged write only
when its route authorizes the request server-side; otherwise list it as *needs developer wiring*.

**No safe client path for a user-agent journey →** list it in the plan as *needs developer wiring*,
with the reason. A tool returning invented data, or calling something that cannot work, covers nothing.

## Placement — registration scopes and entry modules

Resolve, while planning, the exact workspace-relative path of each registration scope's entry module
and of each tool's module. In an Explorer run they become `plan.json.entry_module` and each
suggestion's `source_module`; in a chat or non-interactive run they are written into the plan.
Generation, review and Connect reuse exactly these paths.

| stack | everywhere and page-scoped tools | state- and auth-gated tools |
|---|---|---|
| **React SPA / Vite** | one provider component at the app root registers them in a `useEffect`; page-scoped tools carry `pages` | a component whose effect is keyed on the app's existing session, role or cart state |
| **Next App Router** | a `"use client"` registrar mounted in the root `layout.tsx`; page-scoped tools carry `pages` | the registrar reads the app's client session hook; its effect depends on auth and role |
| **Server-templated pages / static** | a `<script type="module">` in the shared layout registers on load | include the script only for the server-rendered auth state, or gate inside it on the client session |

Code for each shape is in `references/codegen.md`.

## Confidence rule: decided or needs your input

Every tool is in the reviewed plan. Within it, mark each tool:

- **decided** — both hold: (a) its user-agent journey is a must-have for this site, and (b) a rung-1
  or rung-2 path exists with **corroborating evidence**: the route, its handler and a UI element all
  agree on the same operation.
- **needs your input** — anything else: ambiguous domain meaning, competing flows for the same
  user-agent journey, a great-to-have, an uncertain kind of site, or only a rung-3/4 path. Give a
  **specific question** and a **stated default**, so the developer can approve fast or redirect.
