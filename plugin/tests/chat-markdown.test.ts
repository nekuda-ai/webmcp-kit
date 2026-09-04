// mdHtml() renders chat replies as markdown-lite, and reply text is
// attacker-influenceable (a page the agent browsed can plant it) — so it is a
// raw-HTML producer on an untrusted string. The page has no build step, so the
// check lifts the functions out of the source and runs them; a copy here would
// pass while the shipped page rots.
//
// Run: bun test plugin/tests/chat-markdown.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const src = readFileSync(
  join(import.meta.dir, "..", "skills", "implement", "interactive", "explorer.html"),
  "utf8",
);

/** `function <name>(…){…}` from its header to the next `}` at column 0. */
function lift(name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`explorer.html no longer defines ${name}() — update this test`);
  return src.slice(at, src.indexOf("\n}", at) + 2);
}

const render = runInNewContext(`(() => {
  ${src.match(/^var ESCAPES=.*$/m)?.[0]}
  ${["Html", "safeStr", "esc", "inlineMd", "mdHtml"].map(lift).join("\n")}
  return function(text){return mdHtml(text).h}
})()`) as (text: unknown) => string;

test("markup in the reply is escaped, inside spans too", () => {
  expect(render('<img src=x onerror="alert(1)">')).toBe(
    "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
  );
  expect(render("**<b>hi</b>** `<script>`")).toBe(
    "<p><strong>&lt;b&gt;hi&lt;/b&gt;</strong> <code>&lt;script&gt;</code></p>",
  );
});

test("blank lines split paragraphs, dashes make a list, prose ends it", () => {
  expect(render("one\ntwo\n\n- a\n- b\nafter")).toBe(
    "<p>one<br>two</p><ul><li>a</li><li>b</li></ul><p>after</p>",
  );
});

test("unpaired markers stay literal, non-strings render as nothing", () => {
  expect(render("2 ** 3 and ` alone")).toBe("<p>2 ** 3 and ` alone</p>");
  expect(render(undefined)).toBe("");
});
