// Browser-facing durability contract for the shipped Explorer page. This runs the real
// inline script in Chromium against a fake WebSocket; copied helper logic would let the
// page regress while the test stayed green.
//
// Run: bun test plugin/tests/explorer-delivery.test.ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const source = readFileSync(
  join(import.meta.dir, "..", "skills", "implement", "interactive", "explorer.html"),
  "utf8",
);
const mainScript = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((script) => script.includes("/* ── Live wire"));
if (!mainScript) throw new Error("could not locate the Explorer inline script");

const markup = source
  .replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g, "")
  .replace(/<link rel="stylesheet"[^>]*>/g, "");

let browser: Browser;
const pages: Page[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => {
  while (pages.length) await pages.pop()?.context().close();
});
afterAll(async () => { await browser?.close(); });

type Harness = {
  page: Page;
  snapshot: (files: Record<string, string>) => Promise<void>;
  emit: (message: unknown) => Promise<void>;
  lastRequest: () => Promise<Record<string, any>>;
  reload: () => Promise<void>;
  reconnect: () => Promise<void>;
  sentCount: () => Promise<number>;
};

async function harness(): Promise<Harness> {
  const context = await browser.newContext({ bypassCSP: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  pages.push(page);
  await page.addInitScript(() => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      url: string;
      readyState = 1;
      sent: string[] = [];
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | (() => void) = null;
      onerror: null | (() => void) = null;
      constructor(url: string) {
        this.url = url;
        (globalThis as any).__explorerSocketCount = ((globalThis as any).__explorerSocketCount ?? 0) + 1;
        (globalThis as any).__explorerSocket = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(value: string) { this.sent.push(value); }
      close() { this.readyState = 3; this.onclose?.(); }
      emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    (globalThis as any).WebSocket = FakeWebSocket;
  });
  await page.route("http://localhost:4312/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: markup,
  }));
  await page.goto("http://localhost:4312/?capability=capability-a&run_id=run-a");
  const boot = async () => {
    await page.addScriptTag({ content: mainScript });
    await page.waitForFunction(() => !!(globalThis as any).__explorerSocket);
  };
  await boot();
  const emit = async (message: unknown) => {
    await page.evaluate((value) => (globalThis as any).__explorerSocket.emit(value), message);
  };
  return {
    page,
    emit,
    snapshot: async (files) => {
      await emit({ type: "snapshot", files });
      // The page coalesces file bursts behind `setTimeout(…, 16)` (`queueFiles`) and
      // renders synchronously when that timer fires. Waiting a wall-clock 30ms was a
      // race a loaded machine loses: the assertions then read the PREVIOUS render and
      // report a copy mismatch that is indistinguishable from a real regression.
      //
      // This waits on ORDER instead of duration. The page's timer was scheduled while
      // the message was delivered, i.e. strictly before this one, and both ask for the
      // same delay — so the page's task is queued first and has already run (render
      // included) by the time this resolves, however far behind the event loop is.
      // The page's own state is not reachable from here: `addScriptTag` does not put
      // the script's top-level `var`s on `window`.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 16)));
    },
    lastRequest: () => page.evaluate(() => {
      const sent = (globalThis as any).__explorerSocket.sent;
      return JSON.parse(sent.at(-1));
    }),
    reload: async () => { await page.reload(); await boot(); },
    reconnect: async () => {
      const count = await page.evaluate(() => (globalThis as any).__explorerSocketCount);
      await page.evaluate(() => (globalThis as any).__explorerSocket.close());
      await page.waitForFunction((before) => (globalThis as any).__explorerSocketCount > before, count);
    },
    sentCount: () => page.evaluate(() => (globalThis as any).__explorerSocket.sent.length),
  };
}

const plan = JSON.stringify({
  journey: "A visitor searches the docs",
  site: "example.test",
  suggestions: [
    { id: "search", name: "Search", description: "Search docs", why: "Visitors need answers.", status: "proposed", params: [] },
  ],
});

test("socket and requests carry the canonical capability/run envelope", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });

  const wsUrl = await h.page.evaluate(() => (globalThis as any).__explorerSocket.url);
  const url = new URL(wsUrl);
  expect(url.pathname).toBe("/ws");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    role: "page", capability: "capability-a", run_id: "run-a",
  });

  await h.page.locator("#convInput").fill("Rename the search tool");
  await h.page.locator("#convSend").click();
  const sent = await h.lastRequest();
  expect(Object.keys(sent).sort()).toEqual(["payload", "request_id", "type"]);
  expect(sent).toMatchObject({
    type: "comment", payload: { suggestion: null, text: "Rename the search tool" },
  });
  expect(await h.page.locator("#convInput").inputValue()).toBe("Rename the search tool");
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saving…");
  expect(await h.page.locator("#toast").textContent()).toBe("");
});

test("the post-build card records Connect and renders run-level success with locked copy", async () => {
  const h = await harness();
  const connectedPlan = JSON.stringify({
    journey: "A visitor searches the docs",
    site: "example.test",
    suggestions: [
      { id: "search", name: "Search", description: "Search docs", why: "Visitors need answers.", status: "approved", params: [] },
      { id: "reserve", name: "Reserve", description: "Reserve an item", why: "Visitors need to act.", status: "approved", params: [] },
    ],
  });
  const offer = [
    { ts: "2026-08-21T12:00:00.000Z", phase: "verify" },
    { ts: "2026-08-21T12:00:01.000Z", run: "connect", state: "offer" },
  ];
  await h.snapshot({
    "plan.json": connectedPlan,
    "_status.ndjson": `${offer.map((line) => JSON.stringify(line)).join("\n")}\n`,
  });

  const card = h.page.locator("#connectStage");
  expect(await card.isVisible()).toBe(true);
  expect(await h.page.locator("#connectTitle").textContent()).toBe(
    "Connect WebMCP Kit to AgentLane",
  );
  expect(await h.page.locator("#startConnect").textContent()).toBe("Connect to AgentLane");
  expect(await h.page.locator("#skipConnect").textContent()).toBe("Skip for now");
  expect(await h.page.locator("#connectCopy").textContent()).toBe(
    "See registered tools and their activity in AgentLane. Your built tools stay in this project.",
  );
  expect((await card.textContent()) ?? "").not.toMatch(
    /\b(?:mint|token|scope|telemetry|api[ -]?key|origin)\b/i,
  );

  await h.page.locator("#startConnect").click();
  const request = await h.lastRequest();
  expect(request).toMatchObject({ type: "connect", payload: { action: "connect" } });
  await h.emit({
    type: "recorded",
    request_id: request.request_id,
    event_id: "connect-a",
    run_id: "run-a",
    order: 1,
  });
  expect(await h.page.locator("#startConnect").isDisabled()).toBe(true);

  await h.snapshot({
    "plan.json": connectedPlan,
    "_status.ndjson": `${offer.map((line) => JSON.stringify(line)).join("\n")}\n${JSON.stringify({ ts: "2026-08-21T12:00:02.500Z", run: "connect", state: "start" })}\n`,
  });
  expect(await h.page.locator("#startConnect").textContent()).toBe("Connecting…");
  expect(await h.page.locator("#connectStage").getAttribute("aria-busy")).toBe("true");
  expect(await h.page.locator("#connectCopy").textContent()).toContain(
    "Finish the secure browser sign-in",
  );

  const decision = JSON.stringify({
    event_id: "connect-a",
    run_id: "run-a",
    order: 1,
    type: "connect",
    ts: "2026-08-21T12:00:02.000Z",
    payload: { action: "connect" },
  });
  await h.snapshot({
    "plan.json": connectedPlan,
    "_status.ndjson": `${offer.map((line) => JSON.stringify(line)).join("\n")}\n${JSON.stringify({ ts: "2026-08-21T12:00:02.500Z", run: "connect", state: "start" })}\n${JSON.stringify({ ts: "2026-08-21T12:00:03.000Z", run: "connect", state: "done" })}\n`,
    "_feedback.ndjson": `${decision}\n`,
    "_ack.ndjson": `${JSON.stringify({ ts: "2026-08-21T12:00:04.000Z", run_id: "run-a", event_id: "connect-a", status: "handled" })}\n`,
  });
  expect(await h.page.locator("#connectTitle").textContent()).toBe(
    "Connected — 2 tools ready",
  );
  expect(await h.page.locator("#connectActions").isHidden()).toBe(true);
});

test("Skip for now is a durable connect decision and closes the card", async () => {
  const h = await harness();
  const status = [
    { ts: "2026-08-21T12:00:00.000Z", phase: "verify" },
    { ts: "2026-08-21T12:00:01.000Z", run: "connect", state: "offer" },
  ];
  await h.snapshot({
    "plan.json": plan.replace('"proposed"', '"approved"'),
    "_status.ndjson": `${status.map((line) => JSON.stringify(line)).join("\n")}\n`,
  });
  await h.page.locator("#skipConnect").click();
  expect(await h.lastRequest()).toMatchObject({
    type: "connect",
    payload: { action: "skip" },
  });
  await h.snapshot({
    "plan.json": plan.replace('"proposed"', '"approved"'),
    "_status.ndjson": `${status.map((line) => JSON.stringify(line)).join("\n")}\n${JSON.stringify({ ts: "2026-08-21T12:00:02.000Z", run: "connect", state: "skipped" })}\n`,
  });
  await h.page.locator("#connectStage").waitFor({ state: "hidden" });
  expect(await h.page.locator("#connectStage").isHidden()).toBe(true);
});

test("a pick changes only after recorded and a rejected request can be retried", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  const pick = h.page.locator('#tools [data-toggle="search"]');
  expect(await pick.getAttribute("class")).toContain("on");
  await pick.click();
  const pickRequest = await h.lastRequest();
  expect(await pick.getAttribute("class")).toContain("on");
  await h.emit({ type: "recorded", request_id: pickRequest.request_id, event_id: "pick-a", run_id: "run-a", order: 1 });
  expect(await pick.getAttribute("class")).not.toContain("on");

  await h.page.locator("#convInput").fill("Retry this message");
  await h.page.locator("#convSend").click();
  const first = await h.lastRequest();
  await h.emit({ type: "error", request_id: first.request_id, message: "The event could not be recorded." });
  expect(await h.page.locator("#convInput").inputValue()).toBe("Retry this message");
  expect(await h.page.locator("#toast").textContent()).toContain("Try again");
  await h.page.locator("#convSend").click();
  const retry = await h.lastRequest();
  expect(retry.request_id).not.toBe(first.request_id);
  await h.emit({ type: "recorded", request_id: retry.request_id, event_id: "comment-a", run_id: "run-a", order: 2 });
  expect(await h.page.locator("#convInput").inputValue()).toBe("");
});

test("recorded clears the input, delivery still waits, and handled needs an ack", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.locator("#convInput").fill("Keep the result read-only");
  await h.page.locator("#convSend").click();
  const sent = await h.lastRequest();
  await h.emit({ type: "recorded", request_id: sent.request_id, event_id: "event-a", run_id: "run-a", order: 7 });
  expect(await h.page.locator("#convInput").inputValue()).toBe("");
  const savedCopy = await h.page.locator("#statusBox").textContent() ?? "";
  expect(savedCopy).toContain("terminal session that started this run");
  expect(savedCopy).toContain("fresh session can pick it up");
  expect(savedCopy).not.toContain("waiting for this run");
  expect(savedCopy).not.toContain("/hooks");
  expect(await h.page.locator("#toast").textContent()).toBe("");

  const feedback = `${JSON.stringify({
    event_id: "event-a", run_id: "run-a", order: 7, type: "comment",
    ts: "2026-08-18T12:00:00.000Z", payload: { suggestion: null, text: "Keep the result read-only" },
  })}\n`;
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": feedback,
    "_delivery.ndjson": `${JSON.stringify({ run_id: "run-a", event_id: "event-a", status: "claimed" })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s agent task");

  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": feedback,
    "_delivery.ndjson": `${JSON.stringify({ run_id: "run-a", event_id: "event-a", status: "claimed" })}\n`,
    "_ack.ndjson": `${JSON.stringify({ ts: "2026-08-18T12:00:01.000Z", run_id: "run-a", event_id: "event-a", status: "handled" })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Handled by the agent");
  expect(await h.page.locator("#toast").textContent()).toBe("");
});

test("submit and approval show Saving until recorded, with no celebration", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.locator("#primaryAction").click();
  let sent = await h.lastRequest();
  expect(sent.type).toBe("submit");
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Saving…");
  await h.emit({ type: "recorded", request_id: sent.request_id, event_id: "submit-a", run_id: "run-a", order: 1 });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Plan submitted");

  await h.snapshot({
    "plan.json": plan.replace('"proposed"', '"review"'),
    "_status.ndjson": '{"phase":"review"}\n',
    "_ack.ndjson": `${JSON.stringify({ ts: "2026-08-18T12:00:00.000Z", run_id: "run-a", event_id: "submit-a", status: "handled" })}\n`,
  });
  await h.page.locator("#primaryAction").click();
  sent = await h.lastRequest();
  expect(sent).toMatchObject({ type: "approve", payload: {} });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Saving…");
  expect(await h.page.locator(".confetti").count()).toBe(0);
  await h.emit({ type: "recorded", request_id: sent.request_id, event_id: "approve-a", run_id: "run-a", order: 2 });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approval saved");
  expect(source).not.toContain("confetti-fall");
});

test("a recorded approval remains disabled and truthful after a real page reload", async () => {
  const h = await harness();
  const reviewPlan = plan.replace('"proposed"', '"review"');
  await h.snapshot({ "plan.json": reviewPlan, "_status.ndjson": '{"phase":"review"}\n' });
  await h.page.locator("#primaryAction").click();
  const request = await h.lastRequest();
  await h.emit({ type: "recorded", request_id: request.request_id, event_id: "approve-reload", run_id: "run-a", order: 3 });
  const approval = {
    event_id: "approve-reload", run_id: "run-a", order: 3, type: "approve",
    ts: new Date().toISOString(), payload: {},
  };
  const files = {
    "plan.json": reviewPlan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(approval)}\n`,
  };
  await h.snapshot(files);
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approval saved");
  expect(await h.page.locator("#primaryAction").isDisabled()).toBe(true);

  await h.reload();
  await h.snapshot(files);
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approval saved");
  expect(await h.page.locator("#primaryAction").isDisabled()).toBe(true);
  expect(await h.sentCount()).toBe(0);
  expect(await h.page.locator("#statusBox").textContent()).toContain("terminal session that started this run");

  await h.snapshot({
    ...files,
    "_ack.ndjson": `${JSON.stringify({
      ts: new Date().toISOString(), run_id: "run-a", event_id: "approve-reload", status: "handled",
    })}\n`,
  });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approved");
  expect(await h.page.locator("#statusBox").textContent()).toContain("Approval handled by the agent");
});

test("a submit appended before disconnect reconciles only from an exact refreshed journal", async () => {
  const h = await harness();
  const baseline = {
    event_id: "baseline", run_id: "run-a", order: 4, type: "comment",
    ts: "2000-01-01T00:00:00.000Z", payload: { suggestion: null, text: "Earlier note" },
  };
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": `${JSON.stringify(baseline)}\n`,
  });
  await h.page.locator("#primaryAction").click();
  const request = await h.lastRequest();
  await h.reconnect();
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Save unconfirmed");

  const future = new Date(Date.now() + 1_000).toISOString();
  const unsafe = [
    baseline,
    { event_id: "same-order", run_id: "run-a", order: 4, type: "submit", ts: future, payload: request.payload },
    { event_id: "wrong-payload", run_id: "run-a", order: 5, type: "submit", ts: future, payload: { picks: [] } },
    { event_id: "stale-time", run_id: "run-a", order: 6, type: "submit", ts: "2000-01-01T00:00:00.000Z", payload: request.payload },
  ];
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": `${unsafe.map((event) => JSON.stringify(event)).join("\n")}\n`,
  });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Checking save…");
  expect(await h.page.locator("#statusBox").textContent()).toContain("Checking the refreshed journal");

  const recorded = {
    event_id: "submit-reconciled", run_id: "run-a", order: 7, type: "submit", ts: future, payload: request.payload,
  };
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": `${[...unsafe, recorded].map((event) => JSON.stringify(event)).join("\n")}\n`,
  });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Plan submitted");
  expect(await h.page.locator("#statusBox").textContent()).toContain("terminal session that started this run");
});

test("a genuinely lost submit becomes explicitly retryable after bounded reconciliation", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.locator("#primaryAction").click();
  const lost = await h.lastRequest();
  await h.reconnect();
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Save unconfirmed");

  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Checking save…");
  expect(await h.page.locator("#primaryAction").isDisabled()).toBe(true);
  await h.page.waitForTimeout(900);
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Retry submit");
  expect(await h.page.locator("#primaryAction").isEnabled()).toBe(true);
  expect(await h.page.locator("#statusBox").textContent()).toBe("The action was not recorded. It is safe to retry.");

  await h.page.locator("#primaryAction").click();
  const retry = await h.lastRequest();
  expect(retry.request_id).not.toBe(lost.request_id);
  expect(retry).toMatchObject({ type: "submit", payload: lost.payload });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Saving…");
});

test("a boundary-delayed approval update is drained before retry can duplicate it", async () => {
  const h = await harness();
  const reviewPlan = plan.replace('"proposed"', '"review"');
  await h.snapshot({ "plan.json": reviewPlan, "_status.ndjson": '{"phase":"review"}\n' });
  await h.page.locator("#primaryAction").click();
  const request = await h.lastRequest();
  await h.reconnect();
  await h.snapshot({ "plan.json": reviewPlan, "_status.ndjson": '{"phase":"review"}\n' });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Checking save…");

  const approval = {
    event_id: "approve-delayed", run_id: "run-a", order: 1, type: "approve",
    ts: new Date(Date.now() + 1_000).toISOString(), payload: request.payload,
  };
  const boundary = await h.page.evaluate(async (event) => {
    // Stretch only queueFiles' 16ms coalescing delay so the boundary ordering is
    // deterministic: the journal update is pending when reconciliation expires.
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) =>
      nativeSetTimeout(callback, delay === 16 ? 400 : delay, ...args)) as typeof setTimeout;
    await new Promise((resolve) => setTimeout(resolve, 700));
    (globalThis as any).__explorerSocket.emit({
      type: "file", name: "_feedback.ndjson", text: `${JSON.stringify(event)}\n`,
    });
    await new Promise((resolve) => setTimeout(resolve, 136));
    const button = document.querySelector<HTMLButtonElement>("#primaryAction")!;
    const label = document.querySelector("#primaryLabel")?.textContent;
    button.click();
    globalThis.setTimeout = nativeSetTimeout;
    return {
      label,
      disabled: button.disabled,
      sent: (globalThis as any).__explorerSocket.sent.length,
    };
  }, approval);
  expect(boundary).toEqual({ label: "Checking save…", disabled: true, sent: 0 });
  await h.page.waitForFunction(() => document.querySelector("#primaryLabel")?.textContent === "Approval saved");
  await h.page.waitForTimeout(850);
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approval saved");
  expect(await h.page.locator("#primaryAction").isDisabled()).toBe(true);
  expect(await h.sentCount()).toBe(0);
});

test("an approval appended before disconnect reconciles on the refreshed journal", async () => {
  const h = await harness();
  const reviewPlan = plan.replace('"proposed"', '"review"');
  await h.snapshot({ "plan.json": reviewPlan, "_status.ndjson": '{"phase":"review"}\n' });
  await h.page.locator("#primaryAction").click();
  const request = await h.lastRequest();
  await h.reconnect();
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Save unconfirmed");

  const approval = {
    event_id: "approve-reconciled", run_id: "run-a", order: 1, type: "approve",
    ts: new Date(Date.now() + 1_000).toISOString(), payload: request.payload,
  };
  await h.snapshot({
    "plan.json": reviewPlan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(approval)}\n`,
  });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approval saved");
  expect(await h.page.locator("#primaryAction").isDisabled()).toBe(true);
  expect(await h.page.locator("#statusBox").textContent()).toContain("terminal session that started this run");
});

test("a run-level timeout applies to later actions until delivery supersedes it", async () => {
  const h = await harness();
  const envelope = {
    event_id: "event-timeout", run_id: "run-a", order: 8, type: "feedback",
    ts: "2026-08-18T12:00:00.000Z", payload: { suggestion: "search", text: "Use a shorter label" },
  };
  const waiting = { run_id: "run-a", state: "waiting", queue_depth: 0, last_order: 7 };
  const timeout = { run_id: "run-a", state: "timeout", queue_depth: 0, last_order: 7 };
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(envelope)}\n`,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(timeout)}\n`,
  });
  let status = await h.page.locator("#statusBox").textContent() ?? "";
  expect(status).toContain("Saved safely");
  expect(status).toContain("that original task");
  expect(status).toContain("If /hooks there lists this plugin");

  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(envelope)}\n`,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(timeout)}\n${JSON.stringify({
      run_id: "run-a", event_id: "event-timeout", state: "claimed", order: 8,
    })}\n`,
  });
  status = await h.page.locator("#statusBox").textContent() ?? "";
  expect(status).toBe("Saved — waiting for this run’s agent task");

  const later = {
    event_id: "event-later", run_id: "run-a", order: 10, type: "comment",
    ts: "2026-08-18T12:00:02.000Z", payload: { suggestion: null, text: "One more note" },
  };
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(envelope)}\n${JSON.stringify(later)}\n`,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(timeout)}\n${JSON.stringify({
      run_id: "run-a", state: "waiting", queue_depth: 0, last_order: 9,
    })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s agent task");
});

test("an eventless run error overrides waiting without replacing event-specific delivery", async () => {
  const h = await harness();
  const event = {
    event_id: "event-after-wait", run_id: "run-a", order: 8, type: "comment",
    ts: "2026-08-18T12:00:00.000Z", payload: { suggestion: null, text: "Please continue" },
  };
  const waiting = { run_id: "run-a", state: "waiting", queue_depth: 0, last_order: 7 };
  const failed = { run_id: "run-a", state: "error" };
  const files = {
    "plan.json": plan,
    "_status.ndjson": '{"phase":"review"}\n',
    "_feedback.ndjson": `${JSON.stringify(event)}\n`,
  };
  await h.snapshot({
    ...files,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(failed)}\n`,
  });
  let status = await h.page.locator("#statusBox").textContent() ?? "";
  expect(status).toContain("automatic delivery needs attention");
  expect(status).toContain("original agent task");

  await h.snapshot({
    ...files,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(failed)}\n${JSON.stringify({
      run_id: "run-a", event_id: "event-after-wait", order: 8, state: "claimed",
    })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s agent task");

  const later = {
    event_id: "event-after-new-wait", run_id: "run-a", order: 10, type: "comment",
    ts: "2026-08-18T12:00:01.000Z", payload: { suggestion: null, text: "A later action" },
  };
  await h.snapshot({
    ...files,
    "_feedback.ndjson": `${JSON.stringify(event)}\n${JSON.stringify(later)}\n`,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(failed)}\n${JSON.stringify({
      run_id: "run-a", state: "waiting", queue_depth: 0, last_order: 9,
    })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s agent task");
});

test("reduced motion leaves every ongoing activity indicator static", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.locator("#convInput").fill("Keep the progress copy short");
  await h.page.locator("#convSend").click();
  const comment = await h.lastRequest();
  await h.emit({ type: "recorded", request_id: comment.request_id, event_id: "comment-motion", run_id: "run-a", order: 1 });

  await h.page.locator("#primaryAction").click();
  expect(await h.page.locator("#primaryAction").evaluate((element) =>
    getComputedStyle(element, "::before").animationName)).toBe("none");

  const submit = await h.lastRequest();
  await h.emit({ type: "recorded", request_id: submit.request_id, event_id: "submit-motion", run_id: "run-a", order: 2 });
  await h.snapshot({
    "plan.json": plan.replace('"proposed"', '"building"'),
    "_status.ndjson": '{"phase":"build"}\n',
  });

  for (const selector of [".agent-spinner", ".tool-status.st-building", ".msg.typing .dots i"]) {
    const indicator = h.page.locator(selector).first();
    expect(await indicator.isVisible()).toBe(true);
    expect(await indicator.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  }
});

test("journal envelopes render by server order while legacy lines still render", async () => {
  const h = await harness();
  const lines = [
    { type: "comment", ts: "2026-08-18T11:59:00.000Z", suggestion: null, text: "Legacy message" },
    { event_id: "event-2", run_id: "run-a", order: 2, type: "comment", ts: "2026-08-18T12:00:00.000Z", payload: { suggestion: null, text: "Second recorded" } },
    { event_id: "event-1", run_id: "run-a", order: 1, type: "comment", ts: "2026-08-18T12:00:00.000Z", payload: { suggestion: null, text: "First recorded" } },
  ];
  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  });
  expect(await h.page.locator(".msg.you p").allTextContents()).toEqual([
    "Legacy message", "First recorded", "Second recorded",
  ]);
});

test("disconnect distinguishes uncertain sends from durable recorded actions", async () => {
  const h = await harness();
  await h.snapshot({ "plan.json": plan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.locator("#convInput").fill("Pending locally");
  await h.page.locator("#convSend").click();
  await h.page.evaluate(() => (globalThis as any).__explorerSocket.close());
  expect(await h.page.locator("#statusBox").textContent()).toBe(
    "Disconnected — locally pending sends may not be saved. Already recorded actions remain durable.",
  );
  expect(await h.page.locator("#convInput").inputValue()).toBe("Pending locally");
});

// ── Scope grouping (rendered-DOM half; pure grouping logic: explorer-scope.test.ts) ──
// Where a tool registers is part of the reviewed contract: the map must group
// tools under scope nodes, outline rows must carry a scope chip, and a missing
// `availability` must surface as "Scope not declared" — never a silent site-wide.
const scopedPlan = JSON.stringify({
  journey: "A visitor shops and RSVPs",
  site: "example.test",
  suggestions: [
    { id: "ask", name: "ask_site", description: "Answer questions", why: "Visitors ask.", status: "proposed", availability: { scope: "everywhere" }, params: [] },
    { id: "rsvp", name: "rsvp_to_event", description: "Hold seats", why: "Events fill.", status: "proposed", availability: { scope: "page", where: "/events/[id]", note: "always books the event being viewed" }, params: [] },
    { id: "checkout", name: "start_checkout", description: "Go to checkout", why: "Carts convert.", status: "proposed", availability: { scope: "everywhere", when: "cart has items", note: "unregisters when the cart empties" }, params: [] },
    { id: "mystery", name: "mystery_tool", description: "Does something", why: "Unclear.", status: "proposed", params: [] },
  ],
});

async function scopedHarness(): Promise<Harness> {
  const h = await harness();
  await h.snapshot({ "plan.json": scopedPlan, "_status.ndjson": '{"phase":"propose"}\n' });
  await h.page.waitForSelector("#tools .scope-node");
  return h;
}

test("the map renders one scope node per group with its tools underneath", async () => {
  const h = await scopedHarness();
  const grouped = await h.page.evaluate(() =>
    Array.from(document.querySelectorAll("#tools .scope-group"))
      .filter((g) => g.querySelector(".scope-node")) // the ghost "Request tool" row borrows the grid
      .map((g) => ({
      label: g.querySelector(".scope-label")?.textContent,
      count: g.querySelector(".page-count")?.textContent,
      tools: Array.from(g.querySelectorAll(".scope-tools .tool[data-suggestion]"))
        .map((t) => t.getAttribute("data-suggestion")),
    })),
  );
  expect(grouped).toEqual([
    { label: "Site-wide", count: "2", tools: ["ask", "checkout"] },
    { label: "/events/[id]", count: "1", tools: ["rsvp"] },
    { label: "Scope not declared", count: "1", tools: ["mystery"] },
  ]);
  // A condition never forms a group — the conditional tool sits under its scope
  // with a marker on the card instead.
  expect(await h.page.locator('#tools .tool[data-suggestion="checkout"] .cond-mark').count()).toBe(1);
  expect(await h.page.locator("#tools .cond-mark").count()).toBe(1);
  // Every tool still gets a connector, now via its scope node: 3 site→scope,
  // 4 scope→tool. Links draw on requestAnimationFrame, so wait for the frame
  // rather than counting immediately.
  await h.page.waitForFunction(() => document.querySelectorAll("#mapLinks path").length === 7);
});

test("outline cards group rows by scope and the detail pane states where the tool lives", async () => {
  const h = await scopedHarness();
  await h.page.locator('[data-view="outline"]').click();
  // Scope is the card a row sits in: everywhere-tools under the Global card,
  // page tools under their route's card, undeclared under its own card.
  expect((await h.page.locator('#outline .outline-card.tg-everywhere .outline-card-title').textContent())?.trim())
    .toBe("Global");
  expect(await h.page.locator('#outline .outline-card.tg-everywhere [data-suggestion="checkout"]').count()).toBe(1);
  expect((await h.page.locator('#outline .outline-card.tg-page:has([data-suggestion="rsvp"]) .outline-route').textContent())?.trim())
    .toBe("/events/[id]");
  expect(await h.page.locator('#outline .outline-card.tg-undeclared [data-suggestion="mystery"]').count()).toBe(1);

  await h.page.locator('#outline [data-suggestion="rsvp"]').click();
  const detail = (await h.page.locator("#content .scope-field").textContent()) ?? "";
  expect(detail).toContain("Where it lives");
  expect(detail).toContain("/events/[id]");
  expect(detail).toContain("always books the event being viewed");

  await h.page.locator('#outline [data-suggestion="checkout"]').click();
  const conditional = (await h.page.locator("#content .scope-field").textContent()) ?? "";
  expect(conditional).toContain("Only while cart has items");
  expect(conditional).toContain("unregisters when the cart empties");

  await h.page.locator('#outline [data-suggestion="mystery"]').click();
  const undeclared = (await h.page.locator("#content .scope-field").textContent()) ?? "";
  expect(undeclared).toContain("does not declare where this tool registers");
});

test("availability is a first-class field, not an extras dump", async () => {
  const h = await scopedHarness();
  await h.page.locator('#tools .tool[data-suggestion="rsvp"]').click();
  const content = (await h.page.locator("#content").textContent()) ?? "";
  expect(content).not.toContain('"scope"');
  expect(content).not.toContain("availability:");
});
