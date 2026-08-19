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
      await page.waitForTimeout(30);
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
  expect(await h.page.locator("#toast").textContent()).toBe("Saving…");
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
  const savedCopy = await h.page.locator("#toast").textContent() ?? "";
  expect(savedCopy).toContain("original Codex task");
  expect(savedCopy).toContain("different task must reconcile it manually");
  expect(savedCopy).not.toContain("waiting for Codex");
  expect(savedCopy).not.toContain("/hooks");

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
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s Codex task");

  await h.snapshot({
    "plan.json": plan,
    "_status.ndjson": '{"phase":"propose"}\n',
    "_feedback.ndjson": feedback,
    "_delivery.ndjson": `${JSON.stringify({ run_id: "run-a", event_id: "event-a", status: "claimed" })}\n`,
    "_ack.ndjson": `${JSON.stringify({ ts: "2026-08-18T12:00:01.000Z", run_id: "run-a", event_id: "event-a", status: "handled" })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Handled by Codex");
  expect(await h.page.locator("#toast").textContent()).toBe("Handled by Codex");
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
  expect(await h.page.locator("#statusBox").textContent()).toContain("original Codex task");

  await h.snapshot({
    ...files,
    "_ack.ndjson": `${JSON.stringify({
      ts: new Date().toISOString(), run_id: "run-a", event_id: "approve-reload", status: "handled",
    })}\n`,
  });
  expect(await h.page.locator("#primaryLabel").textContent()).toBe("Approved");
  expect(await h.page.locator("#statusBox").textContent()).toContain("Approval handled by Codex");
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
  expect(await h.page.locator("#statusBox").textContent()).toContain("original Codex task");
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
  expect(await h.page.locator("#statusBox").textContent()).toContain("original Codex task");
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
  expect(status).toBe("Saved — waiting for this run’s Codex task");

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
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s Codex task");
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
  expect(status).toContain("original Codex task");

  await h.snapshot({
    ...files,
    "_delivery.ndjson": `${JSON.stringify(waiting)}\n${JSON.stringify(failed)}\n${JSON.stringify({
      run_id: "run-a", event_id: "event-after-wait", order: 8, state: "claimed",
    })}\n`,
  });
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s Codex task");

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
  expect(await h.page.locator("#statusBox").textContent()).toBe("Saved — waiting for this run’s Codex task");
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
