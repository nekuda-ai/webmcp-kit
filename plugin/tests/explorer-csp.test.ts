// The Explorer pins its inline style and script blocks with CSP sha256 hashes
// (the meta tag in explorer.html). An edit to either block without regenerating
// the hashes ships a page the browser renders unstyled and inert — and the
// Chromium test harness cannot catch it, because it runs with bypassCSP. This
// recomputes the hashes from the shipped file and fails on any mismatch.
//
// Run: bun test plugin/tests/explorer-csp.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "..", "skills", "implement", "interactive", "explorer.html"),
  "utf8",
);

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const meta = source.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
if (!meta) throw new Error("explorer.html no longer carries a CSP meta tag — update this test");

const directive = (name: string): string[] =>
  meta.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `))
    ?.split(/\s+/).slice(1).filter((token) => token.startsWith("'sha256-")) ?? [];

test("every inline style block's hash is pinned in style-src", () => {
  const styles = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  expect(styles.length).toBeGreaterThan(0);
  const pinned = directive("style-src");
  for (const block of styles) expect(pinned).toContain(sha256(block));
  expect(pinned.length).toBe(styles.length);
});

test("every inline script block's hash is pinned in script-src", () => {
  const scripts = [...source.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => !m[1]?.includes("src="))
    .map((m) => m[2]);
  expect(scripts.length).toBeGreaterThan(0);
  const pinned = directive("script-src");
  for (const block of scripts) expect(pinned).toContain(sha256(block));
  expect(pinned.length).toBe(scripts.length);
});
