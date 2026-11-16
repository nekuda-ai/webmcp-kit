# Tool patterns — when a description is not enough

**Rule: the description first.** The agent is a capable reader: a clear description of the tool
and of each input often tells it what to call and in which order. Reach for structure only when
a description cannot do the job: the tool cannot work in the page's current state, or the agent
cannot see what it needs (a tool on a different page). The SDK README's *Designing tools* section
holds the same patterns with code.

## A tool on every page

Leave `pages` out and the tool is on every page, so one definition serves the whole site
(`ask_site` is the usual one). Give a page-scoped tool its `pages` list (`codegen.md`). On a site
that loads a new page for each link, the entry module loads from the shared layout so the SDK
runs on every page. The agent sees only the tools of the page it is on.

## A tool that needs data from another tool

Example: product details needs a product id that search returns. Keep the tool registered all
the time, because the agent may already have the id. Make the input required, and say in its
description what it is and where it comes from: "The product id, as search_products returns it."

## A tool that is correct only in some states

Example: checkout with an empty cart. Keep the tool registered.

- A tool that reads gives the true state: "The cart is empty" is a correct answer.
- A tool that acts, and cannot work now, throws a message that says what to do first; the SDK
  turns it into an error result the agent reads (README → *Designing tools*).

## A search that opens a different site

A tool's call ends when its page leaves for another site, and that site has none of these tools.

1. Best: fetch the results from the search service inside `execute` and return them. This works
   only when the service accepts requests from this site.
2. Otherwise: return the results address first, then open it after `execute` has returned (README
   → *Designing tools* has the code). The caller gets the result before the page changes; how
   each agent then reads the new page is not yet proven, so say so in the plan.
3. When the developer owns both sites, the SDK goes on both.

Name the option chosen, and its reason, in the plan.
