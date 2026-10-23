# Tool roles — what each tool takes, returns and leaves on screen

Every tool has one role. The role fixes its input, its answer and its effect on the page, so an
agent that has used one site's `search_products` knows what another's will do.

## Rules every tool follows

- **Do what the UI does.** A tool that acts goes through the site's own client path and leaves the
  page as the site's UI would: the results rendered, the cart badge updated, the confirmation shown.
  The visitor sees what the agent did.
- **Read quietly where it helps.** When a tool's page effect is a move (to the results page, opening
  the cart drawer), it may take one optional boolean that returns the same data and leaves the page
  alone: cart details without opening the cart. The page effect stays the default.
- **Writes complete.** A tool that changes data performs the change through the site's own path:
  it books the slot, registers the attendee, saves the record. It carries no `readOnlyHint`, so the
  browser agent confirms with the visitor before calling it, and its description states the
  consequence ("Books the slot and sends the confirmation email").
- **Handoff only where the site needs the visitor.** Entering a card, a password or other
  credential, a CAPTCHA, an identity check: those steps are the visitor's own. The tool does every
  step before that one, moves the visitor there with their choices kept, and returns a **handoff
  answer**: the step the visitor now sees (`handoff: { url }`, its heading), what it carries, and a
  `message` saying what is left for them. A tool takes no password, card number or other credential
  as input.
- **Closed sets as the visitor sees them.** A parameter over a fixed set the site offers (a status
  or category filter, tabs, a sort, a select's options) is an `enum` of the labels the visitor sees,
  and the code maps each label to the value the site keeps behind it. Free text (a name, a query, a
  date) and item ids stay open.
- **Ids round-trip.** The `id` a list or search returns is what detail, add and update take.
- **Honest answers.** A read that finds nothing returns `{ items: [], count: 0, message }` saying so,
  never a guess and never "popular" items in its place. A failure, or an input the site does not
  offer, throws a plain error the agent can act on, naming what the site does offer.
- **Annotations.** `readOnlyHint: true` on a tool that writes nothing (showing results or opening a
  page is not a write); writes and handoffs carry none. `untrustedContentHint: true` when the answer
  carries content written by users or third parties (reviews, comments, messages, profiles). Those
  two are the whole vocabulary.
- **Names.** A snake_case verb phrase, `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, unique on the site, in the
  site's own words.
- **Descriptions.** What the tool does, when to use it, what it returns, and any consequence or
  sign-in requirement. An agent picks by this text alone.

## Where a tool lives

- **Everywhere** — registered on every page (`ask_site`, site-wide search, the cart).
- **On pages** — offered only where it makes sense (`pages: ["/products/*"]` in the SDK). A tool
  about "this item" reads the item from the page it is on and takes no id; a listing's tool takes
  the id, because a listing holds many.
- **In a state** — registered while its state holds and removed when it ends: `start_checkout`
  while the cart has items, personal tools while signed in, admin tools for admins. A registration
  left live past its state is a broken promise to the agent.

Registration by auth or role is presentation. Before wrapping a privileged write, confirm the
server authorizes the request itself (`references/wiring.md`).

## The roles

### `ask_site`

On every site, every page and every auth state, dashboards and signed-in apps included.

- **Takes** `query`: the visitor's question in their own words.
- **Answers about the site and its general content:** what the site is and offers, where things
  live (which page holds the posts, the FAQ, the settings, the reports), about, contact, FAQ,
  delivery and returns, policies, its posts and guides, and how sign-in and sign-up work (what the
  pages ask for, where they lead).
- **Returns** the matching sections, best first: `{ items: [{ name, excerpt, path }], count }`, with
  the section's heading as `name`, its own text holding the answer as `excerpt`, and the page it is
  on as `path`. An entry matches when most of the question's meaningful words, compared by stem,
  appear in its heading or text. A question about the site itself is answered by the entry page. A
  question the site does not cover gets `{ items: [], count: 0, message }`, never the home page as
  a fallback. It retrieves; the calling agent composes the answer.
- **Is not a search.** One product's price, a record's status or a slot's availability is the
  search, list and detail tools' answer. It does not query the catalog or the records, and it does
  not replace the site's search.
- **Leaves no trace:** no navigation, storage or write; `readOnlyHint: true`.
- **Builds from what the repo holds.** Content in the repo (pages, markdown posts, policy copy, the
  route map and its headings, translation strings) goes into an index module generated from those
  files. Content that lives in a database or CMS is fetched at call time from the site's own pages
  or content API (same origin), parsed into sections, and matched the same way. No new server or AI
  service.

### Finding

| role | takes | does | returns |
|---|---|---|---|
| `search` | `query`, plus a filter or sort the site's search offers, as an enum | runs the site's own search and leaves the visitor on its results | `{ items, count }`, each with `id`, name, the facts the results show, `url` |
| `list_filter` | the listing's filters as enums, plus an optional `query`; all optional | opens the site's listing with its own filters (the URL its filter controls produce), so the visitor lands on it | `{ items, count }` |
| `detail` | an item's `id`, url or name | reads that item; changes nothing on screen | every fact a deciding visitor sees: name, price, options and their availability, stock, dates, venue, the item's full description; `id`, `url` |
| `content_read` | a post or page's `id`, url or title | reads it; changes nothing on screen | title, main body text (no navigation or footer), date and author where shown, `id`, `url` |
| `availability` | a date, plus the service or resource as an enum where there are several | reads the open slots as the site's calendar shows them | `{ items: [{ time, … }], count }`, or the empty answer for a full day |

### Acting

| role | takes | does | returns |
|---|---|---|---|
| `add_to_cart` | an item's `id` or name, its options as enums, a quantity | adds it through the site's own cart path; the cart shows the change | the cart's item count and the line added |
| `view_cart` | nothing (or the quiet-read flag) | reads the visitor's cart, opening it the way the cart icon does | lines (`id`, name, options, quantity, price) and total; an empty cart is `{ items: [], count: 0, message }` |
| `update_cart` | a line's `id` or name and a new quantity (0 removes it) | changes it through the cart's own path | the cart's lines and total |
| `start_checkout` | the contact, shipping address and delivery option the checkout asks for, the delivery option as an enum of the options it lists (a signed-in visitor's saved details come from the session) | completes each checkout step before payment through the site's own checkout path, then moves the visitor to the card form: a handoff. A checkout that takes no card (pay on delivery, invoice, a free order) places the order and shows the site's confirmation | the handoff answer, with the cart's lines, the delivery and the total; or the order's confirmation; an empty cart throws |
| booking, registration, RSVP, enquiry | the visitor's choices and the details the site's form asks for (a signed-in visitor's come from the session) | completes it through the site's own path and shows the site's confirmation | the confirmation: its reference and what was booked or sent |
| create or update a record | the fields the app's form takes, closed sets as enums | saves through the app's own client path; the app shows the saved record | the saved record (`id` and its fields) |

A step the site needs the visitor for, in any of these, turns that tool into a handoff at that step:
a booking that takes a card deposit completes everything up to the card form and hands over there.
