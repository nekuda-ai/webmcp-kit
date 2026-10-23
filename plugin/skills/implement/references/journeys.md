# User-agent journeys — what to build

A **user-agent journey** is a goal a visitor asks an AI agent to accomplish on this site, with the
decisions and actions that support it: find a suitable product, answer a question about it, add the
chosen variant to the cart, book a slot. It is a goal, not a click path: tools carry it, and one
tool often serves several. `references/tool-roles.md` says what each tool takes, returns and leaves
on screen.

## Method

Put concrete visitors on concrete pages: an anonymous visitor on the entry page and on one listing
and one item page, then each signed-in role on the page it lands on. For each, list what they
**ask** ("what's your return policy?", "where do I change my plan?") and what they **ask for** ("add
the black one in medium", "mark ticket 1042 as resolved"). That list is the spec. Name the
tools in the site's own words and after its own calls to action: a site whose button says "Book a
demo" gets `book_demo`, not `request_quote`.

Every site gets `ask_site`, on every page and in every auth state, dashboards and signed-in apps
included.

## Kinds of site

Where to look, not a checklist. A site can be several kinds: the most prominent one (by its
navigation and calls to action) sets the must-haves, and another kind's user-agent journeys are
great-to-have unless they are a main path on this site too. A site that fits none of these still
gets its user-agent journeys from the method above.

| kind | recognise it by | user-agent journeys that usually matter |
|---|---|---|
| shop | a catalog with a cart and checkout | find products (search, list and filter), product detail, add to cart, view and change the cart, start checkout; order status |
| directory and reservations | many venues, vehicles or properties, each with availability and a reserve flow | search and list, detail, availability, reserve; change or cancel |
| services and appointments | services with durations or providers, booked against open slots | list services, availability, book; reschedule or cancel |
| courses | courses or lessons with enrol or start-learning | browse, course detail, enrol, read a lesson; progress |
| events | dated events with venues and registration | list events, event detail, register or RSVP; my tickets |
| lead generation | the main call to action is a quote, demo or contact form | browse the offering, submit the site's own intake form |
| content | blog, docs, portfolio, brochure: content to read | `ask_site`; finding and reading content through the site's own search, listings and pages where it has them |
| app or dashboard | signed-in people working on their own records (admin panels, internal tools, back office) | find, list and filter records, read one, create and update them the way the app's forms do, the app's own reports |

A tool for something the site does not do (a cart on a brochure site, a booking tool with nothing to
book) is noise that makes the real tools harder to pick.

## Who is visiting

- **Anonymous first.** Most user-agent journeys start signed out. When one needs an account, an
  entry tool stays registered for the signed-out visitor: its description says sign-in is needed,
  and it takes the visitor to the sign-in page. Once they are signed in, the tool that completes
  the goal registers. A signed-out guide with no signed-in tool behind it carries nothing.
- **Signed in.** Personal tools (my orders, my bookings, account changes) register only while the
  visitor is signed in.
- **Roles.** Each role gets the tools for its own work (an admin's tools only for admins), checked
  on the page as each role.
- **Guest lookups** (an order by its number plus the email) where the site itself offers them.

## Must-have or great-to-have

- **must-have** — without it the site's main purpose is out of an agent's reach (a shop no agent can
  check out of).
- **great-to-have** — a great build adds it when the repo's features and data support it; it never
  stands in for a missing must-have.

One goal-shaped tool with parameters beats near-duplicates: `search_products` with filters, never
`search_by_color` beside `search_by_size`. An agent chooses among tools by their descriptions, and
every overlapping pair is a coin it has to flip.
