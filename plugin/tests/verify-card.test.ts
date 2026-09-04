// foldStatus() is what keeps the verify card honest: during build every tool already
// earns a `verify` step from the static checks, and without the reset at the `verify`
// phase boundary the card opens showing those build-time outcomes as runtime verdicts —
// every row a stale ✓ before the ladder has touched anything. The page has no build
// step, so the check lifts the function out of the source and runs it; a copy here
// would pass while the shipped page rots.
//
// Run: bun test plugin/tests/verify-card.test.ts
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

type Step = { state: string; outcome: string; ts: string; startTs: string };
type Folded = {
  phase: string;
  steps: Map<string, Map<string, Step>>;
  runSteps: Map<string, { state: string }>;
};
const fold = runInNewContext(`(() => {
  ${["safeStr", "foldStatus"].map(lift).join("\n")}
  return foldStatus
})()`) as (events: unknown[]) => Folded;

// One run, replayed the way normalize() replays _status.ndjson: two tools built and
// statically checked (one clean, one not), then the developer approves.
const buildLines = [
  { ts: "2026-08-18T10:00:00Z", phase: "build" },
  { ts: "2026-08-18T10:00:01Z", suggestion: "cart-add", step: "code", state: "start" },
  { ts: "2026-08-18T10:00:30Z", suggestion: "cart-add", step: "code", state: "done" },
  { ts: "2026-08-18T10:00:31Z", suggestion: "cart-add", step: "verify", state: "start" },
  { ts: "2026-08-18T10:00:40Z", suggestion: "cart-add", step: "verify", state: "done", outcome: "verified" },
  { ts: "2026-08-18T10:01:00Z", suggestion: "orders", step: "code", state: "start" },
  { ts: "2026-08-18T10:01:30Z", suggestion: "orders", step: "code", state: "done" },
  { ts: "2026-08-18T10:01:31Z", suggestion: "orders", step: "verify", state: "start" },
  { ts: "2026-08-18T10:01:45Z", suggestion: "orders", step: "verify", state: "done", outcome: "could-not-verify" },
  { ts: "2026-08-18T10:02:00Z", phase: "review" },
];
const approve = { ts: "2026-08-18T10:10:00Z", phase: "verify" };

test("build-time verify steps fold normally, outcome and startTs intact", () => {
  const { phase, steps } = fold(buildLines);
  expect(phase).toBe("review");
  expect(steps.get("cart-add")?.get("verify")).toEqual({
    state: "done", outcome: "verified", ts: "2026-08-18T10:00:40Z", startTs: "2026-08-18T10:00:31Z",
  });
  expect(steps.get("orders")?.get("verify")?.outcome).toBe("could-not-verify");
});

test("entering phase verify clears every verify step but keeps the code steps", () => {
  const { phase, steps } = fold([...buildLines, approve]);
  expect(phase).toBe("verify");
  for (const id of ["cart-add", "orders"]) {
    expect(steps.get(id)?.get("verify")).toBeUndefined();
    expect(steps.get(id)?.get("code")?.state).toBe("done");
  }
});

test("the runtime ladder's fresh lines land after the reset, with their own startTs", () => {
  const { steps } = fold([
    ...buildLines,
    approve,
    { ts: "2026-08-18T10:10:05Z", suggestion: "cart-add", step: "verify", state: "start" },
    { ts: "2026-08-18T10:11:00Z", suggestion: "cart-add", step: "verify", state: "done", outcome: "verified" },
  ]);
  expect(steps.get("cart-add")?.get("verify")).toEqual({
    state: "done", outcome: "verified", ts: "2026-08-18T10:11:00Z", startTs: "2026-08-18T10:10:05Z",
  });
  expect(steps.get("orders")?.get("verify")).toBeUndefined();
});

test("a duplicate phase-verify line does not wipe ladder results already earned", () => {
  const { steps } = fold([
    ...buildLines,
    approve,
    { ts: "2026-08-18T10:10:05Z", suggestion: "cart-add", step: "verify", state: "start" },
    { ts: "2026-08-18T10:11:00Z", suggestion: "cart-add", step: "verify", state: "done", outcome: "verified" },
    { ts: "2026-08-18T10:11:01Z", phase: "verify" },
  ]);
  expect(steps.get("cart-add")?.get("verify")?.outcome).toBe("verified");
});

test("run-level finish steps fold latest-wins", () => {
  const { runSteps } = fold([
    ...buildLines,
    approve,
    { ts: "2026-08-18T10:12:00Z", run: "pr", state: "start" },
    { ts: "2026-08-18T10:12:30Z", run: "pr", state: "done" },
  ]);
  expect(runSteps.get("pr")).toEqual({ state: "done" });
});
