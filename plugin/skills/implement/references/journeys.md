# Journeys — the 7-category digest

Distilled from the WebMCP Kit templates. Journeys are the coverage unit; the tool shapes below are guidance, not a fixed schema.

## First principles
1. **Journeys, not endpoints.** A tool completes a step of a user journey (find product → in cart → paid), never wraps a REST route.
2. **Description is the product.** The agent picks tools by name + description alone. A pickable description says what it does, when to use it, what it returns, and any consequence.
3. **Consolidation over proliferation.** One goal-shaped tool with parameters beats near-duplicates — one `search_products` with filters, never `search_by_color`/`_size`. Live sites converge on 3–10 tools; every extra tool dilutes selection.
4. **`ask_site` is the universal must-have** (below).

## Method
Put a concrete visitor on concrete pages (landing, one product/listing/course page). List what they'd **ask** ("what's your return policy?", "do these fit a low nose bridge?") and what they'd **ask for** ("add the black one in medium"). That list is the spec: content questions define what `ask_site` reaches; action requests define the other tools. Instantiate to the repo's real domain objects and CTAs — a "book a demo" site gets `book_demo`, not `request_quote`.

## Category match (pick primary by homepage/nav/CTA prominence)

| category | applies_when | count band | must-have journeys (beyond `ask_site`) | great-to-have |
|---|---|---|---|---|
| **ecom** | product catalog + purchase path (cart/checkout or engine equivalent — Shopify, Magento, Woo, Medusa, Saleor) | 5–7 | search products, product details, add to cart, checkout | manage cart, order status |
| **directory-reservations** | many venues/vehicles/properties with per-entity availability + reserve flow (openresto, bookcars, OpenTable-alikes) | 4–7 | search directory, entity details, reserve | modify/cancel, reviews |
| **services-appointments** | services with durations/providers, booking against availability (Easy!Appointments, cal-style, clinics) | 4–6 | list services, check availability, book appointment | reschedule/cancel, provider profiles |
| **courses-education** | courses/lessons with enroll or start-learning (learnhouse, courselit, egghead-style) | 4–7 | browse courses, course details, enroll (free path must complete) | continue learning, my progress, instructor profiles |
| **events-rsvp** | events with dates/venues + attendee registration (Hi.Events, luma-clones, gathio) | 4–6 | browse events, event details, register/RSVP | cancel RSVP, my tickets |
| **b2b-quote-leadgen** | shows products/services but the core CTA is request-a-quote / book-a-demo / structured lead form (b2b-starter-medusa, SaaS marketing, consulting) | 2–5 | browse offering, submit the site's core intake (quote/demo/lead) | pricing inquiry, collateral (spec sheets/case studies) |
| **thin-content-control** | blog, portfolio, docs, brochure — content to read, nothing to book/buy/register; a lead/newsletter form disqualifies it | 1–2 | none — `ask_site` and stop | — |

**No template's `applies_when` matches → tell the customer; never draft against the nearest category.**

Hybrids: declare one primary + optional secondary categories. A secondary's must-haves downgrade to great-to-have unless that journey is a main path on the site. Register ONE `ask_site` over the union of content.

**thin-content is the over-proposal control.** Inventing transactional tools on a brochure (a cart, a booking tool) is the failure these rows exist to catch. Read-only proliferation is the same failure: nav/search/open-page tools on a thin-content site just re-skin `ask_site` — the band stays 1–2 = `ask_site` and stop. Stay minimal.

## `ask_site` — read-only, on every site
Answers visitor questions from the site's own content (FAQ, guides, blog, product/service info, policies). It is **retrieval, not answer generation**: return relevant content sections + source paths and let the calling agent compose the answer — the site needs no AI infra. Available everywhere. Implementation ladder (any rung = one tool; a search+fetch pair counts once):
1. Build-time content bundle, keyword-matched client-side (thin/static sites, zero backend).
2. Wrap the site's existing search API; return cleaned text + source URLs.
3. Dedicated retrieval endpoint — only if the site already has one; never build new AI infra.

## Per-tool rubric dimensions (decide before any code)

**Availability — where the tool lives.** Tools register per page document; a **full page navigation** destroys them; there is no site-wide scope. Declare each tool:
- **everywhere** — every page re-registers it (in an SPA, the app-root registration persists across client-side routes). `ask_site` is the model.
- **contextual** — specific pages/states. The same tool registers *differently* per page: a product page bakes the viewed product into the registration (no `product_id` param); a results page requires an id because results are plural.
In an SPA, client-side navigation does **not** tear down registrations, so a contextual tool that bakes in an entity must actively re-register (unregister the old, register the new) on route/param change — otherwise it keeps targeting the previous product. Track state generally: unregister a registration with no valid target — empty-cart checkout, a sold-out event with no waitlist. A stale registration is a broken contract with the agent.

**Auth is page state (UX, not security).** Personal / account-write tools register **on login** and abort **on logout**; role-gated tools also key on role. `execute` rides the page's existing session — the agent never sees credentials; signing in stays a user action in the UI. An unconditionally registered "my orders" is a broken contract. Registration gating is only UX: before wrapping a privileged mutation, confirm the route enforces authn/authz **server-side** — never expose a mutation guarded only by a hidden client button (see `references/wiring.md`). **Exception — the conversion-entry tool** (enroll, book, register, checkout) stays registered logged-out; the anonymous visitor is the journey start. Two-stage: logged-out registration guides sign-in (description states the requirement; `execute` returns guidance, optionally navigating to login); post-login registration completes the action. Guidance with no working post-login tool is not coverage. Guest lookup (order status by id + email) is fine when it mirrors the site's pattern — a reference id plus a corroborating key; a single guessable key invites enumeration.

**Response — data + UI in one call.**
- **data** — enough to complete the current step and choose the next action; never a full entity dump, never just "done".
- **ui_effect** — the page visibly changes so the user sees what the agent did (results render, cart badge updates, navigate to checkout). `none` only for pure content reads. Conversion tools that hand off to payment first create the repo-native handoff state (checkout session, pending order, registration intent) with the user's selections preserved — bare navigation is not coverage.

**Irreversible/cost-bearing writes stop at a reversible boundary.** A payment, cancellation, or delete must not complete in a single agent call. The tool creates the pending/handoff state and hands the final, irreversible step to the app's own payment/confirm UI (human-in-the-loop), or uses a prepare→confirm two-call shape where the confirm call requires a token the prepare call returned. This is an architectural boundary, not an in-tool modal. Record the boundary per write tool in the plan (`references/plan-template.md`).

**Annotations.** Pure read → `readOnlyHint: true`. Returns user/third-party content (reviews, comments) → `untrustedContentHint: true`. No destructive hint exists — write consequences go in the description.

## Tiering
- **must_have** — the site's core purpose is unreachable for an agent without it (a shop with no checkout fails).
- **great_to_have** — a great build adds it; bonus, never offsets a missing must_have. Drop a great-to-have the repo's features/data can't support.
- **Bloat is penalized** — too many tools lowers quality; balance is judged, not raw presence.
