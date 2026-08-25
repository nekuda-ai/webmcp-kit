// The map's scope grouping is a review surface: a tool is either site-wide or
// page-specific — those are the only scopes — and a registration condition
// ("cart has items") is a property of the tool, never a group. A suggestion
// without a valid `availability` must normalize to "Scope not declared" rather
// than silently reading as site-wide. The grouping logic is lifted from the
// shipped page (a copy here would let the page regress while the test stayed
// green). The rendered-DOM half of this contract lives in
// explorer-delivery.test.ts, which already owns the Chromium harness.
//
// Run: bun test plugin/tests/explorer-scope.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "..", "skills", "implement", "interactive", "explorer.html"),
  "utf8",
);

/** `function <name>(…){…}` from its header to the next `}` at column 0. */
function lift(name: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`explorer.html no longer defines ${name}() — update this test`);
  return source.slice(at, source.indexOf("\n}", at) + 2);
}
function liftVar(name: string): string {
  const m = source.match(new RegExp(`^var ${name}=.*$`, "m"));
  if (!m) throw new Error(`explorer.html no longer defines ${name} — update this test`);
  return m[0];
}

type Availability = { scope: string; where: string; when: string; note: string } | null;
type Entry = { id: string; availability: Availability };

const lifted = new Function(`
  ${["SCOPE_KINDS", "SCOPE_ORDER"].map(liftVar).join("\n")}
  ${["safeStr", "normAvailability", "scopeKind", "scopeLabel", "scopeGroups"].map(lift).join("\n")}
  return { normAvailability, scopeGroups, scopeLabel };
`)() as {
  normAvailability: (v: unknown) => Availability;
  scopeGroups: (list: Entry[]) => Array<{ kind: string; label: string; tools: Entry[] }>;
  scopeLabel: (s: Entry) => string;
};

describe("normAvailability", () => {
  test.each<[string, unknown, Availability]>([
    ["everywhere", { scope: "everywhere" }, { scope: "everywhere", where: "", when: "", note: "" }],
    ["everywhere drops a stray where", { scope: "everywhere", where: "/cart" }, { scope: "everywhere", where: "", when: "", note: "" }],
    ["page keeps where", { scope: "page", where: "/events/[id]" }, { scope: "page", where: "/events/[id]", when: "", note: "" }],
    ["a condition rides along on everywhere", { scope: "everywhere", when: "cart has items", note: "unregisters when the cart empties" }, { scope: "everywhere", where: "", when: "cart has items", note: "unregisters when the cart empties" }],
    ["a condition rides along on page", { scope: "page", where: "/checkout", when: "order pending" }, { scope: "page", where: "/checkout", when: "order pending", note: "" }],
    ["where, when and note are trimmed", { scope: "page", where: "  /shop  ", when: " full ", note: " n " }, { scope: "page", where: "/shop", when: "full", note: "n" }],
  ])("normalizes %s", (_name, input, expected) => {
    expect(lifted.normAvailability(input)).toEqual(expected);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["a string", "page"],
    ["an array", [{ scope: "page", where: "/x" }]],
    ["an unknown scope", { scope: "global", where: "/x" }],
    ["the retired state scope", { scope: "state", where: "cart has items" }],
    ["page without where", { scope: "page" }],
    ["page with a blank where", { scope: "page", where: "   " }],
    ["a prototype-chain scope", { scope: "toString", where: "/x" }],
  ])("rejects %s", (_name, input) => {
    expect(lifted.normAvailability(input)).toBeNull();
  });
});

describe("scopeGroups", () => {
  const entry = (id: string, availability: unknown): Entry => ({
    id,
    availability: lifted.normAvailability(availability),
  });

  test("orders site-wide → page → undeclared; conditions never form a group", () => {
    const groups = lifted.scopeGroups([
      entry("checkout", { scope: "everywhere", when: "cart has items" }),
      entry("rsvp", { scope: "page", where: "/events/[id]" }),
      entry("mystery", undefined),
      entry("ask", { scope: "everywhere" }),
      entry("cancel-rsvp", { scope: "page", where: "/events/[id]" }),
    ]);
    expect(
      groups.map((g) => ({ kind: g.kind, label: g.label, tools: g.tools.map((t) => t.id) })),
    ).toEqual([
      { kind: "everywhere", label: "Site-wide", tools: ["checkout", "ask"] },
      { kind: "page", label: "/events/[id]", tools: ["rsvp", "cancel-rsvp"] },
      { kind: "undeclared", label: "Scope not declared", tools: ["mystery"] },
    ]);
  });

  test("distinct page labels stay distinct groups", () => {
    const groups = lifted.scopeGroups([
      entry("a", { scope: "page", where: "/checkout" }),
      entry("b", { scope: "page", where: "/cart" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["/checkout", "/cart"]);
  });
});
