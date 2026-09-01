import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_LINE_BYTES,
  MAX_REQUEST_BYTES,
  appendDurable,
  parseRecordedEnvelope,
} from "../skills/implement/interactive/protocol";

type Run = {
  version: 1;
  run_id: string;
  capability: string;
  workspace: string;
  port: number;
  pid: number;
  started_at: string;
};

const interactive = join(import.meta.dir, "..", "skills", "implement", "interactive");
const serverEntry = join(interactive, "server.ts");
const ackEntry = join(interactive, "ack-event.ts");
const protocolEntry = join(interactive, "protocol.ts");
const workspaces = new Set<string>();
const processes = new Set<ReturnType<typeof Bun.spawn>>();

// Resolved, because the server resolves the workspace it is given before recording
// it in .run.json and the tests compare the two. On Linux this is the identity; on
// macOS `tmpdir()` is the symlink /var -> /private/var, so an unresolved path here
// fails every such comparison for a reason that has nothing to do with the server.
function temporaryWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "webmcp-interactive-server-")));
  workspaces.add(workspace);
  return workspace;
}

function runFile(workspace: string): string {
  return join(workspace, ".webmcp", ".run.json");
}

function readRun(workspace: string): Run | null {
  try {
    return JSON.parse(readFileSync(runFile(workspace), "utf8")) as Run;
  } catch {
    return null;
  }
}

function query(run: Run): string {
  return new URLSearchParams({ capability: run.capability, run_id: run.run_id }).toString();
}

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  description: string,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function start(
  workspace: string,
  resume = false,
  environment: Record<string, string> = {},
) {
  const proc = Bun.spawn({
    cmd: [process.execPath, serverEntry, workspace, ...(resume ? ["--resume"] : [])],
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.add(proc);
  const run = await waitFor(() => {
    const candidate = readRun(workspace);
    return candidate?.pid === proc.pid ? candidate : null;
  }, "server runtime");
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${run.port}/healthz?${query(run)}`);
      return response.ok ? true : null;
    } catch {
      return null;
    }
  }, "scoped health");
  return { proc, run };
}

async function stop(proc: ReturnType<typeof Bun.spawn>, run: Run): Promise<void> {
  if (proc.exitCode === null) {
    try {
      await fetch(`http://127.0.0.1:${run.port}/shutdown?${query(run)}`, { method: "POST" });
    } catch {
      proc.kill("SIGTERM");
    }
  }
  await proc.exited;
  processes.delete(proc);
}

class SocketInbox {
  readonly messages: Array<Record<string, unknown>> = [];

  constructor(readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      this.messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
  }

  async next(
    predicate: (message: Record<string, unknown>) => boolean,
    description: string,
    timeout = 3000,
  ): Promise<Record<string, unknown>> {
    return waitFor(() => {
      const index = this.messages.findIndex(predicate);
      return index < 0 ? null : (this.messages.splice(index, 1)[0] ?? null);
    }, description, timeout);
  }
}

async function connect(run: Run, role: "page" | "claude"): Promise<SocketInbox> {
  const url = `ws://127.0.0.1:${run.port}/ws?role=${role}&${query(run)}`;
  const socket = new WebSocket(url);
  const inbox = new SocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out connecting ${role}`)), 3000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`failed to connect ${role}`));
    };
  });
  return inbox;
}

function feedback(workspace: string): Array<Record<string, unknown>> {
  const path = join(workspace, ".webmcp", "_feedback.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

afterEach(async () => {
  for (const proc of processes) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
  processes.clear();
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  workspaces.clear();
});

test("health is capability- and run-scoped and clean shutdown clears liveness", async () => {
  const workspace = temporaryWorkspace();
  const leaseEnvironment = {
    WEBMCP_TEST_SERVER_LOCK_LEASE_MS: "500",
    WEBMCP_TEST_SERVER_LOCK_RENEW_MS: "50",
  };
  const { proc, run } = await start(workspace, false, leaseEnvironment);

  expect(run.version).toBe(1);
  expect(run.workspace).toBe(workspace);
  expect(run.run_id).not.toBe(run.capability);
  const initialLease = JSON.parse(
    readFileSync(join(workspace, ".webmcp", ".server.lock"), "utf8"),
  ).lease_expires_at_ms as number;
  await waitFor(() => {
    try {
      const renewed = JSON.parse(
        readFileSync(join(workspace, ".webmcp", ".server.lock"), "utf8"),
      ).lease_expires_at_ms as number;
      return renewed > initialLease ? renewed : null;
    } catch {
      return null;
    }
  }, "server lock lease renewal");
  const response = await fetch(`http://127.0.0.1:${run.port}/healthz?${query(run)}`);
  expect(await response.json()).toEqual({
    service: "webmcp-explorer",
    version: 1,
    run_id: run.run_id,
    workspace,
  });
  for (const suffix of [
    `capability=wrong&run_id=${run.run_id}`,
    `capability=${run.capability}&run_id=${crypto.randomUUID()}`,
    "",
  ]) {
    const rejected = await fetch(`http://127.0.0.1:${run.port}/healthz?${suffix}`);
    expect(rejected.status).toBe(404);
    expect(await rejected.text()).toBe("not found");
  }

  await stop(proc, run);
  expect(existsSync(runFile(workspace))).toBe(false);
  expect(existsSync(join(workspace, ".webmcp", ".port"))).toBe(false);
  expect(readFileSync(join(workspace, ".webmcp", ".gitignore"), "utf8")).toContain(".run.json*");

  const fresh = await start(workspace, false, leaseEnvironment);
  expect(fresh.run.run_id).not.toBe(run.run_id);
  expect(fresh.run.capability).not.toBe(run.capability);
  await stop(fresh.proc, fresh.run);
}, 10_000);

test("validates envelopes, records durably before ack, orders bursts, and relays actionable only", async () => {
  const workspace = temporaryWorkspace();
  mkdirSync(join(workspace, ".webmcp"));
  writeFileSync(
    join(workspace, ".webmcp", "_feedback.ndjson"),
    '{"type":"pick","suggestion":"legacy"}\nnot json\n',
  );
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  const claude = await connect(run, "claude");
  await page.next((message) => message.type === "snapshot", "page snapshot");

  page.socket.send(
    JSON.stringify({ request_id: "bad-1", type: "pick", payload: { suggestion: "a" } }),
  );
  expect(await page.next((message) => message.request_id === "bad-1", "correlated validation error")).toMatchObject({
    type: "error",
    request_id: "bad-1",
  });
  page.socket.send("x".repeat(64 * 1024 + 1));
  expect(await page.next((message) => message.type === "error", "oversize error")).not.toHaveProperty(
    "request_id",
  );

  function submitRequest(requestId: string, totalNoteBytes: number) {
    let remaining = totalNoteBytes;
    const picks = Array.from({ length: 4 }, (_, index) => {
      const bytes = Math.min(16 * 1024, remaining);
      remaining -= bytes;
      return { suggestion: `boundary-${index}`, note: "x".repeat(bytes) };
    });
    return { request_id: requestId, type: "submit", payload: { picks } };
  }
  function journalBytes(request: ReturnType<typeof submitRequest>, order: number): number {
    return Buffer.byteLength(
      JSON.stringify({
        event_id: crypto.randomUUID(),
        run_id: run.run_id,
        order,
        type: request.type,
        ts: new Date().toISOString(),
        payload: request.payload,
      }),
      "utf8",
    );
  }
  let undeliverable: ReturnType<typeof submitRequest> | undefined;
  for (let size = 4 * 16 * 1024; size >= 0; size--) {
    const candidate = submitRequest("line-too-large", size);
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") < MAX_REQUEST_BYTES &&
      journalBytes(candidate, 1) > MAX_JOURNAL_LINE_BYTES
    ) {
      undeliverable = candidate;
      break;
    }
  }
  expect(undeliverable).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(undeliverable), "utf8")).toBeLessThan(
    MAX_REQUEST_BYTES,
  );
  page.socket.send(JSON.stringify(undeliverable));
  expect(
    await page.next((message) => message.request_id === "line-too-large", "journal boundary error"),
  ).toMatchObject({ type: "error", request_id: "line-too-large" });
  expect(feedback(workspace).filter((line) => line.run_id === run.run_id)).toHaveLength(0);

  page.socket.send(
    JSON.stringify({
      request_id: "pick-1",
      type: "pick",
      payload: { suggestion: "search-posts", picked: true },
    }),
  );
  const recordedPick = await page.next(
    (message) => message.type === "recorded" && message.request_id === "pick-1",
    "pick recorded",
  );
  const pickEnvelope = feedback(workspace).at(-1);
  expect(pickEnvelope).toEqual({
    event_id: recordedPick.event_id,
    run_id: run.run_id,
    order: 1,
    type: "pick",
    ts: expect.any(String),
    payload: { suggestion: "search-posts", picked: true },
  });
  expect(claude.messages).toHaveLength(0);

  page.socket.send(
    JSON.stringify({
      request_id: "comment-1",
      type: "comment",
      payload: { suggestion: null, text: "Make it smaller" },
    }),
  );
  const recordedComment = await page.next(
    (message) => message.type === "recorded" && message.request_id === "comment-1",
    "comment recorded",
  );
  const relayed = await claude.next((message) => message.type === "comment", "canonical relay");
  expect(relayed).toEqual(feedback(workspace).at(-1));
  expect(relayed).not.toHaveProperty("request_id");
  expect(recordedComment.order).toBe(2);

  for (let i = 0; i < 20; i++) {
    page.socket.send(
      JSON.stringify({
        request_id: `burst-${i}`,
        type: "pick",
        payload: { suggestion: `suggestion-${i}`, picked: i % 2 === 0 },
      }),
    );
  }
  for (let i = 0; i < 20; i++) {
    const ack = await page.next((message) => message.request_id === `burst-${i}`, `burst ack ${i}`);
    expect(ack.order).toBe(i + 3);
  }
  const envelopes = feedback(workspace).filter((line) => line.run_id === run.run_id);
  expect(envelopes.map((line) => line.order)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));

  let largestDeliverable: ReturnType<typeof submitRequest> | undefined;
  for (let size = 4 * 16 * 1024; size >= 0; size--) {
    const candidate = submitRequest("line-at-boundary", size);
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_REQUEST_BYTES &&
      journalBytes(candidate, 23) <= MAX_JOURNAL_LINE_BYTES
    ) {
      largestDeliverable = candidate;
      break;
    }
  }
  expect(largestDeliverable).toBeDefined();
  page.socket.send(JSON.stringify(largestDeliverable));
  expect(
    await page.next((message) => message.request_id === "line-at-boundary", "boundary record"),
  ).toMatchObject({ type: "recorded", order: 23 });
  await claude.next((message) => message.type === "submit" && message.order === 23, "boundary relay");
  const boundaryEnvelope = feedback(workspace).at(-1);
  expect(Buffer.byteLength(JSON.stringify(boundaryEnvelope), "utf8")).toBeGreaterThan(
    MAX_JOURNAL_LINE_BYTES - 256,
  );
  for (const envelope of feedback(workspace).filter(
    (line) => line.run_id === run.run_id && line.type !== "pick",
  )) {
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(
      MAX_JOURNAL_LINE_BYTES,
    );
  }

  page.socket.close();
  claude.socket.close();
  await stop(proc, run);
}, 15_000);

test("connect decisions are canonical, durable, and actionable", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  const claude = await connect(run, "claude");
  await page.next((message) => message.type === "snapshot", "connect snapshot");

  for (const [requestId, payload] of [
    ["missing-action", {}],
    ["unknown-action", { action: "later" }],
    ["extra-action", { action: "connect", extra: true }],
  ] as const) {
    page.socket.send(JSON.stringify({ request_id: requestId, type: "connect", payload }));
    expect(
      await page.next((message) => message.request_id === requestId, `${requestId} rejected`),
    ).toMatchObject({ type: "error", request_id: requestId });
  }

  page.socket.send(
    JSON.stringify({ request_id: "connect-now", type: "connect", payload: { action: "connect" } }),
  );
  const recorded = await page.next(
    (message) => message.request_id === "connect-now",
    "connect recorded",
  );
  expect(recorded).toMatchObject({ type: "recorded", order: 1 });
  const envelope = await claude.next(
    (message) => message.type === "connect",
    "connect relayed",
  );
  expect(envelope).toEqual({
    event_id: recorded.event_id,
    run_id: run.run_id,
    order: 1,
    type: "connect",
    ts: expect.any(String),
    payload: { action: "connect" },
  });
  expect(feedback(workspace)).toEqual([envelope]);

  page.socket.close();
  claude.socket.close();
  await stop(proc, run);
}, 10_000);

test("aggregate journal ceiling rejects crossing before ack and preserves hook-readable history", async () => {
  const workspace = temporaryWorkspace();
  const testLimit = 1_600;
  const { proc, run } = await start(workspace, false, {
    WEBMCP_TEST_JOURNAL_MAX_BYTES: String(testLimit),
  });
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "aggregate snapshot");

  let recorded = 0;
  let rejected: Record<string, unknown> | undefined;
  for (let index = 0; index < 20; index++) {
    const requestId = `aggregate-${index}`;
    page.socket.send(
      JSON.stringify({
        request_id: requestId,
        type: "comment",
        payload: { suggestion: null, text: `event-${index}-${"x".repeat(100)}` },
      }),
    );
    const response = await page.next(
      (message) => message.request_id === requestId,
      `aggregate response ${index}`,
    );
    if (response.type === "error") {
      rejected = response;
      break;
    }
    expect(response).toMatchObject({ type: "recorded", order: recorded + 1 });
    recorded++;
  }
  expect(recorded).toBeGreaterThan(0);
  expect(rejected).toMatchObject({
    type: "error",
    message: expect.stringContaining("rotate .webmcp/_feedback.ndjson"),
  });

  const journal = join(workspace, ".webmcp", "_feedback.ndjson");
  const beforeRetry = readFileSync(journal);
  page.socket.send(
    JSON.stringify({
      request_id: "aggregate-retry",
      type: "comment",
      payload: { suggestion: null, text: `event-r-${"x".repeat(100)}` },
    }),
  );
  expect(
    await page.next((message) => message.request_id === "aggregate-retry", "aggregate retry"),
  ).toMatchObject({
    type: "error",
    message: expect.stringContaining("rotate .webmcp/_feedback.ndjson"),
  });
  expect(readFileSync(journal)).toEqual(beforeRetry);
  expect(statSync(journal).size).toBeLessThanOrEqual(testLimit);
  expect(statSync(journal).size).toBeLessThanOrEqual(MAX_JOURNAL_BYTES);

  const lines = readFileSync(journal, "utf8").split("\n").filter((line) => line.trim());
  expect(lines).toHaveLength(recorded);
  for (const line of lines) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_JOURNAL_LINE_BYTES);
    expect(parseRecordedEnvelope(JSON.parse(line))).toMatchObject({ run_id: run.run_id });
  }

  const exact = join(workspace, "exact-limit.ndjson");
  const value = { exact: true };
  const exactBytes = Buffer.byteLength(`\n${JSON.stringify(value)}\n`, "utf8");
  appendDurable(exact, value, exactBytes);
  expect(statSync(exact).size).toBe(exactBytes);
  expect(() => appendDurable(exact, value, exactBytes)).toThrow("journal byte limit");
  expect(statSync(exact).size).toBe(exactBytes);

  page.socket.close();
  await stop(proc, run);
}, 15_000);

test("resume retains identity and derives the next order from valid matching-run envelopes", async () => {
  const workspace = temporaryWorkspace();
  const first = await start(workspace);
  const page = await connect(first.run, "page");
  await page.next((message) => message.type === "snapshot", "initial snapshot");
  page.socket.send(JSON.stringify({ request_id: "one", type: "approve", payload: {} }));
  await page.next((message) => message.request_id === "one", "first event");
  page.socket.close();
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  processes.delete(first.proc);
  expect(readRun(workspace)?.run_id).toBe(first.run.run_id);

  appendFileSync(
    join(workspace, ".webmcp", "_feedback.ndjson"),
    [
      "not-json",
      JSON.stringify({
        event_id: crypto.randomUUID(),
        run_id: crypto.randomUUID(),
        order: 100,
        type: "cancel",
        ts: new Date().toISOString(),
        payload: {},
      }),
      JSON.stringify({
        event_id: crypto.randomUUID(),
        run_id: first.run.run_id,
        order: 7,
        type: "cancel",
        ts: new Date().toISOString(),
        payload: {},
      }),
    ].join("\n") + "\n",
  );

  const resumed = await start(workspace, true);
  expect(resumed.run.run_id).toBe(first.run.run_id);
  expect(resumed.run.capability).toBe(first.run.capability);
  expect(resumed.run.started_at).toBe(first.run.started_at);
  const resumedPage = await connect(resumed.run, "page");
  await resumedPage.next((message) => message.type === "snapshot", "resumed snapshot");
  resumedPage.socket.send(JSON.stringify({ request_id: "eight", type: "cancel", payload: {} }));
  expect(await resumedPage.next((message) => message.request_id === "eight", "resumed event")).toMatchObject({
    type: "recorded",
    run_id: first.run.run_id,
    order: 8,
  });

  const competitor = Bun.spawn({
    cmd: [process.execPath, serverEntry, workspace],
    stdout: "pipe",
    stderr: "pipe",
  });
  const competitorOutput = new Response(competitor.stdout).text();
  expect(await competitor.exited).toBe(0);
  expect(await competitorOutput).toContain("already live");
  expect(readRun(workspace)?.pid).toBe(resumed.proc.pid);

  resumedPage.socket.close();
  await stop(resumed.proc, resumed.run);
}, 15_000);

test("an expired live-PID observer cannot evict a fresh lock owner during takeover", async () => {
  const workspace = temporaryWorkspace();
  const stateDir = join(workspace, ".webmcp");
  const barrier = join(workspace, "takeover-barrier");
  mkdirSync(stateDir);
  mkdirSync(barrier);
  writeFileSync(
    join(stateDir, ".server.lock"),
    JSON.stringify({ pid: process.pid, nonce: "stale-owner", lease_expires_at_ms: 0 }),
  );

  const staleObserver = Bun.spawn({
    cmd: [process.execPath, serverEntry, workspace],
    env: { ...process.env, WEBMCP_TEST_STALE_LOCK_BARRIER: barrier },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.add(staleObserver);
  const staleError = new Response(staleObserver.stderr).text();
  await waitFor(
    () => (existsSync(join(barrier, `observed-${staleObserver.pid}`)) ? true : null),
    "stale owner observation",
  );

  const winner = await start(workspace);
  writeFileSync(join(barrier, `release-${staleObserver.pid}`), "release");
  expect(await staleObserver.exited).toBe(1);
  processes.delete(staleObserver);
  expect(await staleError).toContain("server lock changed during stale-owner takeover");
  expect(JSON.parse(readFileSync(join(stateDir, ".server.lock"), "utf8"))).toEqual({
    pid: winner.proc.pid,
    nonce: expect.any(String),
    lease_expires_at_ms: expect.any(Number),
  });
  expect(readRun(workspace)?.pid).toBe(winner.proc.pid);

  const page = await connect(winner.run, "page");
  await page.next((message) => message.type === "snapshot", "winner snapshot");
  page.socket.send(JSON.stringify({ request_id: "winner", type: "approve", payload: {} }));
  expect(await page.next((message) => message.request_id === "winner", "winner record")).toMatchObject({
    type: "recorded",
    order: 1,
  });
  expect(feedback(workspace).filter((line) => line.run_id === winner.run.run_id)).toHaveLength(1);
  page.socket.close();
  await stop(winner.proc, winner.run);
}, 15_000);

test("rejects foreign origin/capability and never follows a feedback symlink", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const foreign = await fetch(`http://127.0.0.1:${run.port}/ws?role=page&${query(run)}`, {
    headers: { origin: "https://attacker.example" },
  });
  expect(foreign.status).toBe(403);
  const wrongCapability = await fetch(
    `http://127.0.0.1:${run.port}/ws?role=page&capability=wrong&run_id=${run.run_id}`,
  );
  expect(wrongCapability.status).toBe(403);
  expect(
    (
      await fetch(`http://127.0.0.1:${run.port}/shutdown?capability=wrong&run_id=${run.run_id}`, {
        method: "POST",
      })
    ).status,
  ).toBe(403);

  const target = join(workspace, "outside.txt");
  writeFileSync(target, "sentinel");
  symlinkSync(target, join(workspace, ".webmcp", "_feedback.ndjson"));
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "snapshot");
  page.socket.send(JSON.stringify({ request_id: "blocked", type: "approve", payload: {} }));
  expect(await page.next((message) => message.request_id === "blocked", "record failure")).toMatchObject({
    type: "error",
    request_id: "blocked",
  });
  expect(readFileSync(target, "utf8")).toBe("sentinel");
  unlinkSync(join(workspace, ".webmcp", "_feedback.ndjson"));
  page.socket.send(JSON.stringify({ request_id: "first", type: "approve", payload: {} }));
  expect(await page.next((message) => message.request_id === "first", "first safe record")).toMatchObject({
    type: "recorded",
    order: 1,
  });
  page.socket.close();
  await stop(proc, run);
}, 10_000);

test("250 ms reconciliation publishes atomic replacements and ack helper is idempotent", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "snapshot");
  const stateDir = join(workspace, ".webmcp");
  const plan = join(stateDir, "plan.json");
  writeFileSync(`${plan}.tmp`, "one");
  renameSync(`${plan}.tmp`, plan);
  await page.next((message) => message.type === "file" && message.name === "plan.json" && message.text === "one", "first plan");
  writeFileSync(`${plan}.tmp`, "two");
  renameSync(`${plan}.tmp`, plan);
  await page.next((message) => message.type === "file" && message.name === "plan.json" && message.text === "two", "replaced plan");

  page.socket.send(JSON.stringify({ request_id: "ack-me", type: "approve", payload: {} }));
  const recorded = await page.next((message) => message.request_id === "ack-me", "record for ack");
  const nonexistent = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, crypto.randomUUID()],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(nonexistent.exitCode).toBe(1);
  expect(new TextDecoder().decode(nonexistent.stderr)).toContain("not a canonical event");

  writeFileSync(
    join(stateDir, ".ack.lock"),
    JSON.stringify({ pid: process.pid, nonce: "crashed-ack-helper", created_at_ms: 0 }),
  );
  const recovered = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(recovered.exitCode).toBe(0);

  page.socket.send(JSON.stringify({ request_id: "ack-concurrently", type: "cancel", payload: {} }));
  const concurrentEvent = await page.next(
    (message) => message.request_id === "ack-concurrently",
    "concurrent ack record",
  );
  const helpers = Array.from({ length: 12 }, () =>
    Bun.spawn({
      cmd: [process.execPath, ackEntry, workspace, run.run_id, String(concurrentEvent.event_id)],
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  expect(await Promise.all(helpers.map((helper) => helper.exited))).toEqual(Array(12).fill(0));
  const acknowledgements = readFileSync(join(stateDir, "_ack.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements.filter((ack) => ack.event_id === recorded.event_id)).toHaveLength(1);
  expect(acknowledgements.filter((ack) => ack.event_id === concurrentEvent.event_id)).toHaveLength(1);
  expect(acknowledgements[0]).toMatchObject({
    run_id: run.run_id,
    event_id: recorded.event_id,
    status: "handled",
  });
  await page.next((message) => message.type === "file" && message.name === "_ack.ndjson", "ack published");

  page.socket.close();
  await stop(proc, run);
}, 15_000);

test("submit acknowledgement requires the durable build-start acceptance effect", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "snapshot");
  page.socket.send(
    JSON.stringify({
      request_id: "submit-effect",
      type: "submit",
      payload: { picks: [{ suggestion: "ask_site", note: "" }] },
    }),
  );
  const recorded = await page.next(
    (message) => message.request_id === "submit-effect",
    "submit recorded",
  );
  const premature = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(premature.exitCode).toBe(1);
  expect(new TextDecoder().decode(premature.stderr)).toContain(
    "submit effect has no durable phase-build and first code-start records",
  );

  appendFileSync(
    join(workspace, ".webmcp", "_status.ndjson"),
    '{"phase":"build"}\n{"suggestion":"ask_site","step":"code","state":"start"}\n',
  );
  const accepted = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(accepted.exitCode).toBe(0);

  page.socket.close();
  await stop(proc, run);
}, 10_000);

test("feedback acknowledgement requires the real module to match its review copy", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "snapshot");
  mkdirSync(join(workspace, "src", "webmcp"), { recursive: true });
  writeFileSync(
    join(workspace, ".webmcp", "plan.json"),
    JSON.stringify({
      suggestions: [{ id: "ask-site", source_module: "src/webmcp/ask-site.ts" }],
    }),
  );
  mkdirSync(join(workspace, "src", "webmcp", "decoy"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "webmcp", "decoy", "ask-site.ts"),
    "export const value = 2;\n",
  );
  writeFileSync(join(workspace, "src", "webmcp", "ask-site.ts"), "export const value = 1;\n");
  writeFileSync(join(workspace, ".webmcp", "ask-site.code.md"), "export const value = 2;\n");
  page.socket.send(
    JSON.stringify({
      request_id: "feedback-effect",
      type: "feedback",
      payload: { suggestion: "ask-site", text: "change the value" },
    }),
  );
  const recorded = await page.next(
    (message) => message.request_id === "feedback-effect",
    "feedback recorded",
  );
  const premature = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(premature.exitCode).toBe(1);
  expect(new TextDecoder().decode(premature.stderr)).toContain(
    "feedback effect must update the suggestion's exact plan.json source_module first",
  );

  writeFileSync(join(workspace, "src", "webmcp", "ask-site.ts"), "export const value = 2;\n");
  const accepted = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(accepted.exitCode).toBe(0);

  page.socket.close();
  await stop(proc, run);
}, 10_000);

test("approval acknowledgement requires relative imports in a public browser graph", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  const page = await connect(run, "page");
  await page.next((message) => message.type === "snapshot", "snapshot");
  mkdirSync(join(workspace, "public", "webmcp"), { recursive: true });
  writeFileSync(
    join(workspace, ".webmcp", "plan.json"),
    JSON.stringify({ entry_module: "public/webmcp/entry.js", suggestions: [] }),
  );
  writeFileSync(
    join(workspace, "public", "webmcp", "entry.js"),
    'import { askSite } from "./ask-site.js";\nvoid askSite;\n',
  );
  writeFileSync(
    join(workspace, "public", "webmcp", "ask-site.js"),
    'import { defineTool } from "@nekuda/webmcp-sdk";\nexport const askSite = defineTool;\n',
  );
  writeFileSync(join(workspace, "public", "index.html"), "<!doctype html><title>Site</title>\n");
  page.socket.send(JSON.stringify({ request_id: "approval-delivery", type: "approve", payload: {} }));
  const recorded = await page.next(
    (message) => message.request_id === "approval-delivery",
    "approval recorded",
  );
  const rejected = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(rejected.exitCode).toBe(1);
  expect(new TextDecoder().decode(rejected.stderr)).toContain(
    'browser-unresolvable bare import "@nekuda/webmcp-sdk" in public/webmcp/ask-site.js',
  );

  writeFileSync(
    join(workspace, "public", "index.html"),
    '<script type="importmap">{"imports":{"@nekuda/webmcp-sdk":"/vendor/webmcp-sdk.js"}}</script>\n',
  );
  const stillRejected = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(stillRejected.exitCode).toBe(1);
  expect(new TextDecoder().decode(stillRejected.stderr)).toContain(
    'browser-unresolvable bare import "@nekuda/webmcp-sdk" in public/webmcp/ask-site.js',
  );

  mkdirSync(join(workspace, "public", "vendor"), { recursive: true });
  writeFileSync(
    join(workspace, "public", "webmcp", "ask-site.js"),
    'import { defineTool } from "../vendor/webmcp-sdk.js";\nexport const askSite = defineTool;\n',
  );
  writeFileSync(join(workspace, "public", "vendor", "webmcp-sdk.js"), "export const defineTool = {};\n");
  const accepted = Bun.spawnSync({
    cmd: [process.execPath, ackEntry, workspace, run.run_id, String(recorded.event_id)],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(accepted.exitCode).toBe(0);

  page.socket.close();
  await stop(proc, run);
}, 10_000);

test("a symlinked state directory is rejected without touching its target", async () => {
  const workspace = temporaryWorkspace();
  const target = temporaryWorkspace();
  writeFileSync(join(target, "sentinel"), "safe");
  symlinkSync(target, join(workspace, ".webmcp"));
  const proc = Bun.spawnSync({
    cmd: [process.execPath, serverEntry, workspace],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(1);
  expect(new TextDecoder().decode(proc.stderr)).toContain("is a symlink");
  expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("safe");
  expect(existsSync(join(target, ".run.json"))).toBe(false);
});

test("portable path checks reject final-path symlink swaps before reading or appending", async () => {
  for (const operation of ["read", "append"] as const) {
    const workspace = temporaryWorkspace();
    const barrier = join(workspace, "path-barrier");
    const victim = join(workspace, "victim.ndjson");
    const outside = join(workspace, "outside.txt");
    mkdirSync(barrier);
    writeFileSync(victim, "inside");
    writeFileSync(outside, "sentinel");
    const source =
      operation === "read"
        ? 'const m=await import(process.argv[1]); console.log(JSON.stringify(m.readRegularText(process.argv[2])));'
        : 'const m=await import(process.argv[1]); try { m.appendDurable(process.argv[2], {unsafe:true}); process.exit(2); } catch { console.log("rejected"); }';
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", source, protocolEntry, victim],
      env: {
        ...process.env,
        WEBMCP_TEST_DISABLE_NOFOLLOW: "1",
        WEBMCP_TEST_PATH_BARRIER: barrier,
        WEBMCP_TEST_PATH_OPERATION: operation,
        WEBMCP_TEST_PATH_TARGET: victim,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    processes.add(proc);
    const stdout = new Response(proc.stdout).text();
    await waitFor(
      () => (existsSync(join(barrier, `${operation}-observed-${proc.pid}`)) ? true : null),
      `${operation} pre-open observation`,
    );
    unlinkSync(victim);
    symlinkSync(outside, victim);
    writeFileSync(join(barrier, `${operation}-release-${proc.pid}`), "release");
    expect(await proc.exited).toBe(0);
    processes.delete(proc);
    expect((await stdout).trim()).toBe(operation === "read" ? "null" : "rejected");
    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  }
}, 15_000);

test("actionable events record waiting delivery evidence only while a claude socket is subscribed", async () => {
  const workspace = temporaryWorkspace();
  const { proc, run } = await start(workspace);
  let serverOutput = "";
  (async () => {
    for await (const chunk of proc.stdout) serverOutput += new TextDecoder().decode(chunk);
  })();
  const delivery = () => {
    const path = join(workspace, ".webmcp", "_delivery.ndjson");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const record = async (inbox: SocketInbox, requestId: string, text: string) => {
    inbox.socket.send(
      JSON.stringify({ request_id: requestId, type: "comment", payload: { suggestion: null, text } }),
    );
    return inbox.next(
      (message) => message.type === "recorded" && message.request_id === requestId,
      `${requestId} recorded`,
    );
  };
  const page = await connect(run, "page");

  const unheard = await record(page, "comment-unheard", "Nobody is listening yet");
  await Bun.sleep(100);
  expect(delivery()).toHaveLength(0);

  const claude = await connect(run, "claude");
  const heard = await record(page, "comment-heard", "The agent is listening");
  await claude.next((message) => message.type === "comment", "claude relay");
  const evidence = await waitFor(
    () => delivery().find((line) => line.event_id === heard.event_id) ?? null,
    "waiting delivery evidence",
  );
  expect(evidence).toEqual({
    ts: expect.any(String),
    run_id: run.run_id,
    event_id: heard.event_id,
    order: heard.order,
    state: "waiting",
  });
  expect(delivery().some((line) => line.event_id === unheard.event_id)).toBe(false);

  claude.socket.close();
  await waitFor(() => (serverOutput.includes("ws close: claude") ? true : null), "claude close observed");
  const afterClose = await record(page, "comment-after-close", "The agent went away");
  await Bun.sleep(100);
  expect(delivery().some((line) => line.event_id === afterClose.event_id)).toBe(false);
});
