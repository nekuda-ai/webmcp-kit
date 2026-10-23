# WebMCP — the primer

[WebMCP](https://webmachinelearning.github.io/webmcp/) is a draft web standard that lets a page hand
a browser agent typed **tools**. The page registers them on `document.modelContext`; an agent
working in the visitor's tab lists the page's tools and calls them, instead of reading the screen
and clicking through it.

## The model

- **Page-owned.** A tool's `execute` runs in the page, in the visitor's tab, with the visitor's
  session and the app's own client code. There is no server to run and no separate endpoint: the
  site's backend sees the same requests its own front end makes.
- **The visitor is there.** The agent acts for a person who is looking at the same page. A tool
  that acts leaves the page the way the site's own UI would, so the person sees what happened.
- **Per document.** A registration lives as long as its document. A full page load drops every
  tool; client-side routing in a single-page app keeps them. Which tools exist therefore depends on
  the page and its state: signed in or not, the role, a non-empty cart.
- **Chosen by text.** An agent picks a tool by its name and description and fills the input from
  its JSON Schema. Those three are the product; the agent sees nothing else before calling.
- **Two hints.** `readOnlyHint` says the tool writes nothing. `untrustedContentHint` says its answer
  carries content written by users or third parties. A browser agent treats a tool without
  `readOnlyHint` as state-changing and confirms with the visitor before calling it: that is where
  consent lives.
- **A moving draft.** Browsers ship it behind a flag (Chrome 150+) and the surface still changes.
  `@nekuda/webmcp-sdk` tracks it, finds whichever surface the browser exposes, and does nothing
  where WebMCP is missing.

## Compared with what agents do today

- **Against screen-reading and clicking:** the site declares what can be done and how, so calls are
  fast, typed and stable across redesigns, and they go through the app's own logic.
- **Against an MCP server:** nothing runs on a server and nothing new is authenticated. The tool has
  exactly the visitor's access, through the visitor's session.

## Security shape

- A tool can do only what the visitor's page can already do. Registering a tool only for signed-in
  users or admins is presentation; the server still authorizes every request it receives.
- Passwords, card numbers and other credentials are the visitor's to type into the site's own UI.
  A tool takes the visitor to that step and stops there.
