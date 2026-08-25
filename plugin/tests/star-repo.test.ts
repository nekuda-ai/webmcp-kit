// star-repo.sh drives the post-PR star ask: --eligible decides whether the
// flows may ASK at all (gh installed + authenticated + not already starred),
// and the default mode performs the star the user consented to. A fake `gh`
// on PATH scripts each scenario; the log proves which API calls were made.
//
// Run: bun test plugin/tests/star-repo.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "skills", "implement", "scripts", "star-repo.sh");

type FakeGh = { auth: "ok" | "fail"; starred: boolean; put: "ok" | "fail" } | "missing";

function run(args: string[], gh: FakeGh) {
  const dir = mkdtempSync(join(tmpdir(), "star-repo-"));
  const log = join(dir, "gh.log");
  if (gh !== "missing") {
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${log}"`,
        'case "$1" in',
        `  auth) [ "${gh.auth}" = "ok" ] && exit 0 || exit 1;;`,
        "  api)",
        `    if [ "$2" = "-X" ]; then [ "${gh.put}" = "ok" ] && exit 0 || exit 1; fi`,
        `    [ "${gh.starred}" = "true" ] && exit 0 || exit 1;;`,
        "esac",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...args], {
    env: { ...process.env, PATH: gh === "missing" ? dir : `${dir}:${process.env.PATH}` },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString().trim(),
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

const authed = { auth: "ok", put: "ok" } as const;

test.each([
  { scenario: "gh missing", gh: "missing" as FakeGh, code: 1 },
  { scenario: "gh unauthenticated", gh: { ...authed, auth: "fail", starred: false } as FakeGh, code: 1 },
  { scenario: "repo already starred", gh: { ...authed, starred: true } as FakeGh, code: 1 },
  { scenario: "authenticated and unstarred", gh: { ...authed, starred: false } as FakeGh, code: 0 },
])("--eligible with $scenario exits $code and stays silent", ({ gh, code }) => {
  const r = run(["--eligible"], gh);
  expect(r.code).toBe(code);
  expect(r.out).toBe("");
});

test("star mode PUTs the repo star and thanks the user", () => {
  const r = run([], { ...authed, starred: false });
  expect(r.code).toBe(0);
  expect(r.out).toContain("Starred https://github.com/nekuda-ai/webmcp-kit");
  expect(r.calls).toContain("api -X PUT user/starred/nekuda-ai/webmcp-kit");
});

test("star mode on an already-starred repo says so without a PUT", () => {
  const r = run([], { ...authed, starred: true });
  expect(r.code).toBe(0);
  expect(r.out).toContain("already starred");
  expect(r.calls.some((c) => c.includes("-X PUT"))).toBe(false);
});

test.each([
  { scenario: "gh missing", gh: "missing" as FakeGh, message: "gh is not installed" },
  { scenario: "gh unauthenticated", gh: { ...authed, auth: "fail", starred: false } as FakeGh, message: "gh is not authenticated" },
  { scenario: "the PUT rejected", gh: { ...authed, put: "fail", starred: false } as FakeGh, message: "Could not star" },
])("star mode with $scenario reports the skip and fails", ({ gh, message }) => {
  const r = run([], gh);
  expect(r.code).toBe(1);
  expect(r.out).toContain(message);
});
