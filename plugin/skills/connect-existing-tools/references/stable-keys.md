# Durable identity — choosing a `stableKey`

A `stableKey` is the tool's durable identity across renames and redeploys. `name` may change
freely; `stableKey` may not. The SDK requires `/^[a-z0-9_]+(\.[a-z0-9_]+)+$/` — dot-namespaced,
at least two segments. It does **not** compare `stableKey` against `name`: a wire name that
happens to satisfy that pattern (`get.order`) is accepted verbatim as a key. Keeping the two
distinct is this skill's job, not a guarantee the SDK enforces.

## Rules

- **Existing keys are immutable.** A `stableKey` already in source is adopted as found. A re-run
  never renames one.
- **Default derivation is deterministic:** `adopted.` + the wire name lowercased with every
  `[^a-z0-9_]` run collapsed to a single `_` and the edges trimmed.
- **The developer may choose better.** A key chosen at adoption time is recorded in source and
  becomes immutable from then on.
- **Ambiguity is surfaced, never guessed.** Runtime-computed names, browser-only tools with no
  locatable source, renames between runs, and the same wire name on different pages or auth
  states are put to the developer as explicit decisions.

## The derivation, step by step

1. Start from the **wire name** as inventoried, not from a filename, symbol, or title.
2. Lowercase it.
3. Replace every run of characters outside `[a-z0-9_]` with a single `_`.
4. Trim leading and trailing `_`.
5. Prefix `adopted.`.

Step 5 is what satisfies the two-segment requirement, and it is also what keeps the derived key
from being a bare copy of the wire name — the thing the SDK does not check for. `adopted.` is a
namespace no wire name carries, so a derived key is distinct from its `name` by construction.

| wire name | derived `stableKey` |
|---|---|
| `add_to_cart` | `adopted.add_to_cart` |
| `search-blog-posts` | `adopted.search_blog_posts` |
| `Get.Order.Status` | `adopted.get_order_status` |
| `checkout__v2` | `adopted.checkout__v2` |
| `--tool--` | `adopted.tool` |

6. Check the result against the keys already derived for **every other tool in the inventory**, not
   just the ones sharing a batch.

Three edge cases end in a developer decision rather than a key:

- The wire name reduces to the empty string (every character was outside the set). There is nothing
  deterministic left to derive from; ask.
- The result exceeds the SDK's 1024-character cap. A wire name that long is itself worth a
  question; ask rather than truncating, since a truncation is a silent identity choice.
- **Two different wire names derive the same key.** Step 3 collapses runs, so `add-to-cart`,
  `add_to_cart` and `Add To Cart` all reduce to `adopted.add_to_cart`. That is the same-wire-name
  decision below in everything but appearance, and it is the more dangerous form: nothing catches
  it. The SDK rejects duplicate keys only *within one batch*, so two tools in different registration
  scopes take the same durable identity silently — the one outcome `stableKey` exists to prevent.
  Ask the "one identity or two?" question, with the same two-keys default.

## `adopted.` is a fine key, not a placeholder

It is tempting to "improve" the derived key later into a `domain.action` shape. Do not. A key is
immutable from the moment it lands in source, so a second run that prefers `cart.add` to
`adopted.add_to_cart` would break the identity the first run established — which is exactly the
failure `stableKey` exists to prevent. If a better key is wanted, it is chosen **at adoption time**,
in Phase C, before anything is written.

## Decision prompts

Each of these is presented in the Phase-C plan with the specific question and a stated default. In a
`--non-interactive` run the stated default is taken and recorded in the report; it is never taken
silently in an interactive one.

**Runtime-computed name** — the wire name is built at runtime (`` `get_${entity}` ``, a name read
from config or a loop over a list). There is no single wire name to derive from.
*Ask:* which literal keys should these tools carry?
*Default:* do not migrate; report as needing a developer decision. A derivation over a name that
does not exist until runtime is not deterministic, and writing one would be a guess wearing a rule's
clothes.

**Same wire name in two places** — the same name registered on different routes or auth states,
from different definitions. They are two tools sharing a label.
*Ask:* one identity or two?
*Default:* two keys, disambiguated by the scope they register in (`adopted.add_to_cart__checkout`),
because merging two distinct handlers under one identity is unrecoverable, while splitting one is
not. Note that duplicate `name`s across *different batches* are legal — the SDK only rejects
duplicates within one batch (see below).

**Renamed since a previous run** — source carries a `stableKey` whose derived form no longer matches
the current wire name. This is the system working: the name changed, the identity did not.
*Ask:* nothing.
*Default:* keep the existing key. Never re-derive.

**Browser-observed only** — case 4 in `detection.md`. There is no source to record a decision in, so
any key chosen would be lost before the next run.
*Ask:* nothing.
*Default:* not migrated; reported as needing manual migration.

## Duplicates within a batch

`registerTools` throws on a duplicate `name` **or** a duplicate `stableKey` inside one batch, and
the throw fails the whole call — every tool in that batch, not just the offender. Resolve it before
registering, with the developer:

- Duplicate `stableKey`, distinct tools → the same-wire-name decision above.
- Duplicate `name` → **never** resolved by renaming a wire name; that is the one thing this skill
  promises not to do. Either the two tools belong in different registration scopes (which is what
  the original code was doing, and the batching lost it), or they are the same tool registered
  twice and one registration is dead. Both are developer decisions.

## The honest caveat

Idempotency and determinism **cannot be guaranteed in all cases**. Where the ambiguities above
apply, a second run cannot know what the first run intended unless the decision was written into
source. Say this plainly rather than implying a guarantee the derivation does not have.

What *is* guaranteed: a tool with a literal wire name and a locatable definition derives the same
key on every run, and any key already in source is adopted unchanged. Those two together are what
make a re-run on a half-migrated repo propose only the remaining tools — the migrated ones already
carry their answer.
