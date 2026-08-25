import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pluginRoot = join(import.meta.dir, "..");
const hook = join(pluginRoot, "com.openai", "hooks", "webmcp-feedback.ts");
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const EVENT_ONE = "11111111-1111-4111-8111-111111111111";
const EVENT_TWO = "22222222-2222-4222-8222-222222222222";
const EVENT_THREE = "33333333-3333-4333-8333-333333333333";
const EVENT_OVERSIZED = "44444444-4444-4444-8444-444444444444";
const EVENT_DELAYED = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

type Fixture = {
  root: string;
  workspace: string;
  stateDir: string;
  pluginData: string;
  runId: string;
  capability: string;
  port: number;
};

type LaunchFixture = Pick<Fixture, "root" | "workspace" | "stateDir" | "pluginData">;

type HookResult = {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "webmcp-codex-hook-"));
  roots.push(root);
  return root;
}

function startHealth(workspace: string, runId: string, capability: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/healthz" ||
        url.searchParams.get("run_id") !== runId ||
        url.searchParams.get("capability") !== capability
      ) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json({
        service: "webmcp-explorer",
        version: 1,
        run_id: runId,
        workspace,
      });
    },
  });
  servers.push(server);
  return server;
}

function launchIntentPath(pluginData: string, workspace: string): string {
  const binding = new Bun.CryptoHasher("sha256").update(workspace).digest("hex");
  return join(pluginData, "webmcp-feedback-v1", `launch-${binding}.json`);
}

function runStatePath(pluginData: string, workspace: string, runId: string): string {
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${workspace}\0${runId}`)
    .digest("hex");
  return join(pluginData, "webmcp-feedback-v1", `${binding}.json`);
}

function seedLaunchIntent(
  pluginData: string,
  workspace: string,
  sessionId = "session-a",
  nowMs = Date.now(),
) {
  const path = launchIntentPath(pluginData, workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      session_id: sessionId,
      workspace,
      created_at: new Date().toISOString(),
      expires_at_ms: nowMs + 60_000,
      resume_run_id: null,
      resume_capability: null,
    })}\n`,
  );
}

function fixture(): Fixture {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const stateDir = join(workspace, ".webmcp");
  const pluginData = join(root, "plugin-data");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(pluginData);
  const canonical = realpathSync(workspace);
  seedLaunchIntent(pluginData, canonical);
  const runId = crypto.randomUUID();
  const capability = crypto.randomUUID();
  const server = startHealth(canonical, runId, capability);
  const value = {
    version: 1,
    run_id: runId,
    capability,
    workspace: canonical,
    port: server.port,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, ".run.json"), `${JSON.stringify(value)}\n`);
  return { root, workspace: canonical, stateDir, pluginData, runId, capability, port: server.port };
}

function launchFixture(): LaunchFixture {
  const root = temporaryRoot();
  const workspacePath = join(root, "workspace");
  const pluginData = join(root, "plugin-data");
  mkdirSync(workspacePath);
  mkdirSync(pluginData);
  const workspace = realpathSync(workspacePath);
  return { root, workspace, stateDir: join(workspace, ".webmcp"), pluginData };
}

function activateRuntime(target: LaunchFixture): Fixture {
  mkdirSync(target.stateDir, { recursive: true });
  const runId = crypto.randomUUID();
  const capability = crypto.randomUUID();
  const server = startHealth(target.workspace, runId, capability);
  writeFileSync(
    join(target.stateDir, ".run.json"),
    `${JSON.stringify({
      version: 1,
      run_id: runId,
      capability,
      workspace: target.workspace,
      port: server.port,
      pid: process.pid,
      started_at: new Date().toISOString(),
    })}\n`,
  );
  return { ...target, runId, capability, port: server.port };
}

function reactivateRuntime(target: Fixture): Fixture {
  const server = startHealth(target.workspace, target.runId, target.capability);
  writeRunFile(target, { ...runFile(target), port: server.port, pid: process.pid });
  return { ...target, port: server.port };
}

function stopLatestHealth(): void {
  servers.pop()?.stop(true);
}

function launchInput(target: LaunchFixture, sessionId: string, resume = false) {
  const serverPath = join(pluginRoot, "skills", "implement", "interactive", "server.ts");
  return input(target, "PreToolUse", {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command:
        `bun ${JSON.stringify(serverPath)} ${JSON.stringify(target.workspace)}` +
        (resume ? " --resume" : ""),
    },
  });
}

function defaultPayload(type: string) {
  if (type === "comment" || type === "feedback") return { suggestion: null, text: "Test note" };
  if (type === "submit") return { picks: [] };
  if (type === "connect") return { action: "connect" };
  return {};
}

function event(
  runId: string,
  eventId: string,
  order: number,
  type = "comment",
  payload: Record<string, unknown> = defaultPayload(type),
) {
  return {
    event_id: eventId,
    run_id: runId,
    order,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}

function appendEvent(target: Fixture, value: unknown) {
  appendFileSync(join(target.stateDir, "_feedback.ndjson"), `${JSON.stringify(value)}\n`);
}

function runFile(target: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(join(target.stateDir, ".run.json"), "utf8"));
}

function writeRunFile(target: Fixture, value: Record<string, unknown>) {
  writeFileSync(join(target.stateDir, ".run.json"), `${JSON.stringify(value)}\n`);
}

function acknowledge(target: Fixture, eventId: string) {
  appendFileSync(
    join(target.stateDir, "_ack.ndjson"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      run_id: target.runId,
      event_id: eventId,
      status: "handled",
    })}\n`,
  );
}

function input(target: Pick<Fixture, "workspace">, eventName: "PreToolUse" | "Stop", extra = {}) {
  return {
    session_id: "session-a",
    cwd: target.workspace,
    hook_event_name: eventName,
    ...extra,
  };
}

async function invoke(
  mode: "pre-tool-use" | "stop",
  hookInput: Record<string, unknown>,
  pluginData: string,
  extraEnv: Record<string, string> = {},
): Promise<HookResult> {
  const started = performance.now();
  const proc = Bun.spawn(["bun", hook, mode], {
    cwd: dirname(hookInput.cwd as string),
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginData,
      WEBMCP_HOOK_HEALTH_TIMEOUT_MS: "200",
      ...extraEnv,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(hookInput));
  proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, elapsedMs: performance.now() - started };
}

function outputJson(result: HookResult): Record<string, any> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function delivery(target: Fixture): Record<string, any>[] {
  return readFileSync(join(target.stateDir, "_delivery.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("no active run exits quickly and silently", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const pluginData = join(root, "plugin-data");
  mkdirSync(workspace);
  mkdirSync(pluginData);

  const result = await invoke("pre-tool-use", input({ workspace }, "PreToolUse"), pluginData);

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(result.elapsedMs).toBeLessThan(1_000);
});

test("a foreign hook racing before creator Stop cannot take an empty run", async () => {
  const pending = launchFixture();
  const launch = await invoke(
    "pre-tool-use",
    launchInput(pending, "session-a"),
    pending.pluginData,
  );
  expect(launch).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(JSON.parse(readFileSync(launchIntentPath(pending.pluginData, pending.workspace), "utf8")))
    .toMatchObject({ session_id: "session-a", workspace: pending.workspace });

  const target = activateRuntime(pending);
  const raced = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse", { session_id: "session-b" }),
    target.pluginData,
  );
  expect(raced).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);

  const creator = await invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });
  expect(creator).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(
    JSON.parse(readFileSync(runStatePath(target.pluginData, target.workspace, target.runId), "utf8")),
  ).toMatchObject({ session_id: "session-a", claim: null });
  expect(existsSync(launchIntentPath(target.pluginData, target.workspace))).toBe(false);
});

test("launch intent is first-writer-wins until it expires", async () => {
  const pending = launchFixture();
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData);
  await invoke("pre-tool-use", launchInput(pending, "session-b"), pending.pluginData);
  expect(JSON.parse(readFileSync(launchIntentPath(pending.pluginData, pending.workspace), "utf8")))
    .toMatchObject({ session_id: "session-a" });

  const target = activateRuntime(pending);
  const foreign = await invoke(
    "stop",
    input(target, "Stop", { session_id: "session-b" }),
    target.pluginData,
  );
  expect(foreign.stdout).toBe("");
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);

  await invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });
  expect(
    JSON.parse(readFileSync(runStatePath(target.pluginData, target.workspace, target.runId), "utf8")),
  ).toMatchObject({ session_id: "session-a" });
});

// Released Codex (<= 0.148.0) hands hooks a PLUGIN_DATA path it never creates
// (NEK-779), so the transport creates it — but a symlinked path stays rejected.
test("a PLUGIN_DATA the host never created is created privately; a symlinked one is refused", async () => {
  const pending = launchFixture();
  const ghost = join(pending.root, "host-never-made", "plugin-data");
  await invoke("pre-tool-use", launchInput(pending, "session-a"), ghost);
  expect(lstatSync(ghost).isDirectory()).toBe(true);
  expect(lstatSync(ghost).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(launchIntentPath(ghost, pending.workspace), "utf8"))).toMatchObject(
    { session_id: "session-a" },
  );

  const real = join(pending.root, "real-data");
  mkdirSync(real);
  const alias = join(pending.root, "alias-data");
  symlinkSync(real, alias);
  const viaSymlink = await invoke("pre-tool-use", launchInput(pending, "session-b"), alias);
  expect(viaSymlink).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(launchIntentPath(real, pending.workspace))).toBe(false);
  expect(existsSync(launchIntentPath(alias, pending.workspace))).toBe(false);
});

test("same-session launch retries cover the runtime after the refreshed TTL expires", async () => {
  const pending = launchFixture();
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1000",
  });
  const intentPath = launchIntentPath(pending.pluginData, pending.workspace);
  const original = JSON.parse(readFileSync(intentPath, "utf8"));
  expect(original).toMatchObject({
    session_id: "session-a",
    created_at: new Date(1000).toISOString(),
    expires_at_ms: 2000,
  });

  // The creator retries inside its live window after a failed/blocked launch.
  // A foreign canonical command racing afterward cannot replace or extend it.
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1500",
  });
  await invoke("pre-tool-use", launchInput(pending, "session-b"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1600",
  });
  expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({
    session_id: "session-a",
    created_at: new Date(1000).toISOString(),
    expires_at_ms: 2500,
  });

  const target = activateRuntime(pending);
  writeRunFile(target, {
    ...runFile(target),
    started_at: new Date(2000).toISOString(),
  });

  // Stop arrives long after the retry TTL. The runtime timestamp proves it was
  // created inside A's intent window, so B still cannot steal the empty run.
  const foreign = await invoke(
    "stop",
    input(target, "Stop", { session_id: "session-b" }),
    target.pluginData,
    { WEBMCP_HOOK_STOP_WAIT_MS: "25", WEBMCP_HOOK_TEST_NOW_MS: "4000" },
  );
  expect(foreign).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
  expect(existsSync(intentPath)).toBe(true);

  await invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
    WEBMCP_HOOK_TEST_NOW_MS: "4000",
  });
  expect(
    JSON.parse(readFileSync(runStatePath(target.pluginData, target.workspace, target.runId), "utf8")),
  ).toMatchObject({ session_id: "session-a", claim: null });
  expect(existsSync(intentPath)).toBe(false);
});

test("an expired intent cannot bind a runtime that started after its launch window", async () => {
  const pending = launchFixture();
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1000",
  });
  const intentPath = launchIntentPath(pending.pluginData, pending.workspace);
  const target = activateRuntime(pending);
  writeRunFile(target, {
    ...runFile(target),
    started_at: new Date(2001).toISOString(),
  });

  const result = await invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
    WEBMCP_HOOK_TEST_NOW_MS: "3000",
  });
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
  expect(existsSync(intentPath)).toBe(false);
});

test("a live replacement intent cannot claim the prior creator's runtime", async () => {
  const pending = launchFixture();
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1000",
  });
  const target = activateRuntime(pending);
  writeRunFile(target, { ...runFile(target), started_at: new Date(1500).toISOString() });

  // A's server has written its identity but is temporarily not healthy. Once
  // A's intent expires, B may record a new canonical attempt for a future run.
  stopLatestHealth();
  await invoke("pre-tool-use", launchInput(target, "session-b"), target.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "2500",
  });
  const intentPath = launchIntentPath(target.pluginData, target.workspace);
  expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({
    session_id: "session-b",
    created_at: new Date(2500).toISOString(),
    expires_at_ms: 3500,
    resume_run_id: null,
    resume_capability: null,
  });

  // A becomes healthy again. B's intent is live, but A's started_at predates
  // B's window, so B cannot claim A's event or establish private ownership.
  const liveA = reactivateRuntime(target);
  appendEvent(liveA, event(liveA.runId, EVENT_ONE, 1));
  const result = await invoke(
    "pre-tool-use",
    input(liveA, "PreToolUse", { session_id: "session-b" }),
    liveA.pluginData,
    { WEBMCP_HOOK_TEST_NOW_MS: "2600" },
  );
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(liveA.pluginData, liveA.workspace, liveA.runId))).toBe(false);
  expect(existsSync(intentPath)).toBe(false);
  expect(delivery(liveA).at(-1)).toMatchObject({
    state: "conflict",
    session_id: "session-b",
    event_id: EVENT_ONE,
  });
});

test("a stale launch intent is recoverable by a new canonical launcher", async () => {
  const pending = launchFixture();
  await invoke("pre-tool-use", launchInput(pending, "session-a"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "1000",
  });
  await invoke("pre-tool-use", launchInput(pending, "session-b"), pending.pluginData, {
    WEBMCP_HOOK_LAUNCH_INTENT_MS: "1000",
    WEBMCP_HOOK_TEST_NOW_MS: "2001",
  });
  expect(JSON.parse(readFileSync(launchIntentPath(pending.pluginData, pending.workspace), "utf8")))
    .toMatchObject({ session_id: "session-b", expires_at_ms: 3001 });

  const target = activateRuntime(pending);
  writeRunFile(target, { ...runFile(target), started_at: new Date(2002).toISOString() });
  const staleCreator = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse", { session_id: "session-a" }),
    target.pluginData,
    { WEBMCP_HOOK_TEST_NOW_MS: "2002" },
  );
  expect(staleCreator.stdout).toBe("");
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);

  await invoke("stop", input(target, "Stop", { session_id: "session-b" }), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
    WEBMCP_HOOK_TEST_NOW_MS: "2002",
  });
  expect(
    JSON.parse(readFileSync(runStatePath(target.pluginData, target.workspace, target.runId), "utf8")),
  ).toMatchObject({ session_id: "session-b" });
});

test("ordinary empty hooks and noncanonical commands never create ownership", async () => {
  const noncanonical = launchFixture();
  const serverPath = join(pluginRoot, "skills", "implement", "interactive", "server.ts");
  await invoke(
    "pre-tool-use",
    input(noncanonical, "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: `echo bun ${serverPath} ${noncanonical.workspace}` },
    }),
    noncanonical.pluginData,
  );
  expect(existsSync(launchIntentPath(noncanonical.pluginData, noncanonical.workspace))).toBe(false);

  const target = activateRuntime(noncanonical);
  const ordinary = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse"),
    target.pluginData,
  );
  expect(ordinary).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
});

test("a resumed existing run consumes its intent before a normal run rotates to a new owner", async () => {
  const original = fixture();
  await invoke("stop", input(original, "Stop"), original.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });
  expect(
    JSON.parse(
      readFileSync(runStatePath(original.pluginData, original.workspace, original.runId), "utf8"),
    ),
  ).toMatchObject({ session_id: "session-a" });

  stopLatestHealth();
  await invoke("pre-tool-use", launchInput(original, "session-a", true), original.pluginData);
  expect(JSON.parse(readFileSync(launchIntentPath(original.pluginData, original.workspace), "utf8")))
    .toMatchObject({
      session_id: "session-a",
      resume_run_id: original.runId,
      resume_capability: original.capability,
    });

  const resumed = reactivateRuntime(original);
  const resumedHook = await invoke(
    "pre-tool-use",
    input(resumed, "PreToolUse"),
    resumed.pluginData,
  );
  expect(resumedHook).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(launchIntentPath(resumed.pluginData, resumed.workspace))).toBe(false);

  stopLatestHealth();
  await invoke("pre-tool-use", launchInput(resumed, "session-b"), resumed.pluginData);
  expect(JSON.parse(readFileSync(launchIntentPath(resumed.pluginData, resumed.workspace), "utf8")))
    .toMatchObject({ session_id: "session-b" });

  const rotated = activateRuntime(resumed);
  await invoke("stop", input(rotated, "Stop", { session_id: "session-b" }), rotated.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });
  expect(
    JSON.parse(
      readFileSync(runStatePath(rotated.pluginData, rotated.workspace, rotated.runId), "utf8"),
    ),
  ).toMatchObject({ session_id: "session-b" });
  expect(existsSync(launchIntentPath(rotated.pluginData, rotated.workspace))).toBe(false);
  expect(
    JSON.parse(
      readFileSync(runStatePath(original.pluginData, original.workspace, original.runId), "utf8"),
    ),
  ).toMatchObject({ session_id: "session-a" });
});

test("resume intent requires the exact established session", async () => {
  const unboundPending = launchFixture();
  const unbound = activateRuntime(unboundPending);
  stopLatestHealth();
  await invoke("pre-tool-use", launchInput(unbound, "session-a", true), unbound.pluginData);
  expect(existsSync(launchIntentPath(unbound.pluginData, unbound.workspace))).toBe(false);

  const established = fixture();
  await invoke("stop", input(established, "Stop"), established.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });
  stopLatestHealth();
  await invoke(
    "pre-tool-use",
    launchInput(established, "session-b", true),
    established.pluginData,
  );
  expect(existsSync(launchIntentPath(established.pluginData, established.workspace))).toBe(false);
});

test("resume ownership rejects run or capability rotation", async () => {
  for (const rotate of ["run", "capability"] as const) {
    const original = fixture();
    await invoke("stop", input(original, "Stop"), original.pluginData, {
      WEBMCP_HOOK_STOP_WAIT_MS: "25",
    });
    stopLatestHealth();
    await invoke(
      "pre-tool-use",
      launchInput(original, "session-a", true),
      original.pluginData,
    );

    const runId = rotate === "run" ? crypto.randomUUID() : original.runId;
    const capability = rotate === "capability" ? crypto.randomUUID() : original.capability;
    const server = startHealth(original.workspace, runId, capability);
    writeRunFile(original, {
      version: 1,
      run_id: runId,
      capability,
      workspace: original.workspace,
      port: server.port,
      pid: process.pid,
      started_at: new Date().toISOString(),
    });

    const rotated = { ...original, runId, capability, port: server.port };
    appendEvent(rotated, event(runId, EVENT_ONE, 1));
    const result = await invoke("pre-tool-use", input(rotated, "PreToolUse"), rotated.pluginData);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const rotatedStatePath = runStatePath(rotated.pluginData, rotated.workspace, runId);
    if (rotate === "run") {
      expect(existsSync(rotatedStatePath)).toBe(false);
    } else {
      expect(JSON.parse(readFileSync(rotatedStatePath, "utf8"))).toMatchObject({
        session_id: "session-a",
        capability: original.capability,
        claim: null,
      });
    }
    expect(existsSync(launchIntentPath(rotated.pluginData, rotated.workspace))).toBe(false);
  }
});

test("existing run cleanup never consumes a foreign launch intent", async () => {
  const original = fixture();
  await invoke("stop", input(original, "Stop"), original.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "25",
  });

  stopLatestHealth();
  await invoke("pre-tool-use", launchInput(original, "session-b"), original.pluginData);
  const resumed = reactivateRuntime(original);
  await invoke("pre-tool-use", input(resumed, "PreToolUse"), resumed.pluginData);

  expect(JSON.parse(readFileSync(launchIntentPath(resumed.pluginData, resumed.workspace), "utf8")))
    .toMatchObject({ session_id: "session-b" });
});

test("oversized hook input exits silently before run discovery", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));

  const result = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse", { padding: "x".repeat(300_000) }),
    target.pluginData,
  );

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
});

test("run discovery rejects extra keys and non-distinct or non-UUID capabilities", async () => {
  const mutations = [
    (target: Fixture) => ({ ...runFile(target), extra: true }),
    (target: Fixture) => ({ ...runFile(target), capability: target.runId }),
    (target: Fixture) => ({ ...runFile(target), capability: "not-a-uuid-secret" }),
    (target: Fixture) => {
      const { pid: _pid, ...withoutPid } = runFile(target);
      return withoutPid;
    },
  ];

  for (const mutate of mutations) {
    const target = fixture();
    writeRunFile(target, mutate(target));
    const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
  }
});

test("PreToolUse delivers additional context without a tool decision", async () => {
  const target = fixture();
  appendEvent(
    target,
    event(target.runId, EVENT_ONE, 1, "comment", { suggestion: null, text: "Please rename it" }),
  );

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  const output = outputJson(result);

  expect(output).toHaveProperty("hookSpecificOutput.hookEventName", "PreToolUse");
  expect(output.hookSpecificOutput.additionalContext).toContain(`"event_id":"${EVENT_ONE}"`);
  expect(output.hookSpecificOutput.additionalContext).toContain(
    join(pluginRoot, "skills", "implement", "interactive", "ack-event.ts"),
  );
  expect(output.hookSpecificOutput.additionalContext).not.toContain("$PLUGIN_ROOT");
  expect(output.hookSpecificOutput.additionalContext).not.toContain("append one NDJSON");
  expect(output.hookSpecificOutput.additionalContext).not.toContain("_ack.ndjson");
  expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  expect(result.stdout).not.toContain(target.capability);
  expect(delivery(target).at(-1)).toMatchObject({
    run_id: target.runId,
    event_id: EVENT_ONE,
    state: "claimed",
  });
});

test("PreToolUse delivers a canonical Connect decision", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1, "connect", { action: "connect" }));

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  const context = outputJson(result).hookSpecificOutput.additionalContext as string;

  expect(context).toContain(`"event_id":"${EVENT_ONE}"`);
  expect(context).toContain('"type":"connect"');
  expect(context).toContain('"action":"connect"');
  expect(delivery(target).at(-1)).toMatchObject({
    run_id: target.runId,
    event_id: EVENT_ONE,
    state: "claimed",
  });
});

test("Stop delivers the continuation schema and honors stop_hook_active", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1, "submit", { picks: [] }));

  const stopped = await invoke("stop", input(target, "Stop"), target.pluginData);
  expect(outputJson(stopped)).toMatchObject({ decision: "block" });
  expect(JSON.parse(stopped.stdout).reason).toContain(`"event_id":"${EVENT_ONE}"`);

  const active = await invoke(
    "stop",
    input(target, "Stop", { stop_hook_active: true, session_id: "session-b" }),
    target.pluginData,
    { WEBMCP_HOOK_ACTIVE_STOP_WAIT_MS: "25" },
  );
  expect(active).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(active.elapsedMs).toBeLessThan(1_000);
});

test("an active Stop repeatedly catches submit recorded just after the prior acknowledgement", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1, "comment"));
  const first = await invoke("stop", input(target, "Stop"), target.pluginData);
  expect(outputJson(first)).toMatchObject({ decision: "block" });
  acknowledge(target, EVENT_ONE);

  for (let order = 2; order <= 21; order += 1) {
    const eventId = crypto.randomUUID();
    const continued = invoke(
      "stop",
      input(target, "Stop", { stop_hook_active: true }),
      target.pluginData,
      {
        WEBMCP_HOOK_ACTIVE_STOP_WAIT_MS: "250",
        WEBMCP_HOOK_POLL_MS: "10",
      },
    );
    await Bun.sleep(20);
    appendEvent(target, event(target.runId, eventId, order, "submit", { picks: [] }));
    const delivered = await continued;
    expect(outputJson(delivered)).toMatchObject({ decision: "block" });
    expect(JSON.parse(delivered.stdout).reason).toContain(`"event_id":"${eventId}"`);
    acknowledge(target, eventId);
  }

  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(21);
}, 20_000);

test("an active Stop continuation delivers the next already-queued action", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1, "comment"));

  const first = await invoke("stop", input(target, "Stop"), target.pluginData);
  expect(outputJson(first)).toMatchObject({ decision: "block" });
  acknowledge(target, EVENT_ONE);
  appendEvent(target, event(target.runId, EVENT_TWO, 2, "submit", { picks: [] }));

  const continued = await invoke(
    "stop",
    input(target, "Stop", { stop_hook_active: true }),
    target.pluginData,
  );
  expect(outputJson(continued)).toMatchObject({ decision: "block" });
  expect(JSON.parse(continued.stdout).reason).toContain(`"event_id":"${EVENT_TWO}"`);
  expect(delivery(target).at(-1)).toMatchObject({
    state: "claimed",
    event_id: EVENT_TWO,
    order: 2,
  });
});

test("private state binds one immutable session to the canonical workspace and run", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  appendEvent(target, event(target.runId, EVENT_TWO, 2));

  const first = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  expect(outputJson(first).hookSpecificOutput.additionalContext).toContain(EVENT_ONE);

  const competing = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse", { session_id: "session-b" }),
    target.pluginData,
  );
  expect(competing.stdout).toBe("");

  const stateDir = join(target.pluginData, "webmcp-feedback-v1");
  const statePath = new Bun.Glob("*.json").scanSync(stateDir).next().value;
  expect(statePath).toBeDefined();
  let state = JSON.parse(readFileSync(join(stateDir, statePath!), "utf8"));
  expect(state).toMatchObject({
    session_id: "session-a",
    workspace: target.workspace,
    run_id: target.runId,
    capability: target.capability,
    claim: { event_id: EVENT_ONE },
  });

  acknowledge(target, EVENT_ONE);
  const rebound = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse", { session_id: "session-b" }),
    target.pluginData,
  );
  expect(rebound.stdout).toBe("");
  state = JSON.parse(readFileSync(join(stateDir, statePath!), "utf8"));
  expect(state).toMatchObject({ session_id: "session-a", claim: { event_id: EVENT_ONE } });
  expect(
    delivery(target)
      .filter((entry) => entry.state === "conflict")
      .map((entry) => entry.event_id),
  ).toEqual([EVENT_ONE, EVENT_TWO]);

  const resumed = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  expect(outputJson(resumed).hookSpecificOutput.additionalContext).toContain(EVENT_TWO);
  state = JSON.parse(readFileSync(join(stateDir, statePath!), "utf8"));
  expect(state).toMatchObject({ session_id: "session-a", claim: { event_id: EVENT_TWO } });
});

test("corrupt private state records an event-specific delivery error", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  const privateDir = join(target.pluginData, "webmcp-feedback-v1");
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, `${binding}.json`), "not-json\n");

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(delivery(target).at(-1)).toMatchObject({
    state: "error",
    run_id: target.runId,
    event_id: EVENT_ONE,
    order: 1,
  });
});

test("a busy private lock records an event-specific conflict", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  const privateDir = join(target.pluginData, "webmcp-feedback-v1");
  const lockDir = join(privateDir, `${binding}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      created_at_ms: Date.now(),
    })}\n`,
  );

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    WEBMCP_HOOK_LOCK_WAIT_MS: "25",
  });

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(delivery(target).at(-1)).toMatchObject({
    state: "conflict",
    run_id: target.runId,
    event_id: EVENT_ONE,
    order: 1,
  });
});

test("a crash after claim replays only after the lease expires", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const leasedTime = { WEBMCP_HOOK_LEASE_MS: "50", WEBMCP_HOOK_TEST_NOW_MS: "1000" };

  const crashed = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    ...leasedTime,
    WEBMCP_HOOK_TEST_CRASH_AFTER_CLAIM: "1",
  });
  expect(crashed.code).toBe(86);
  expect(crashed.stdout).toBe("");

  const leased = await invoke(
    "pre-tool-use",
    input(target, "PreToolUse"),
    target.pluginData,
    leasedTime,
  );
  expect(leased.stdout).toBe("");

  const replay = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    ...leasedTime,
    WEBMCP_HOOK_TEST_NOW_MS: "1051",
  });
  expect(outputJson(replay).hookSpecificOutput.additionalContext).toContain(EVENT_ONE);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(2);
});

test("a crash before lock publication cannot strand the canonical lock", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));

  const crashed = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    WEBMCP_HOOK_TEST_CRASH_AFTER_LOCK_CANDIDATE: "1",
  });
  expect(crashed).toMatchObject({ code: 87, stdout: "", stderr: "" });

  const recovered = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  expect(outputJson(recovered).hookSpecificOutput.additionalContext).toContain(EVENT_ONE);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(1);
});

test("concurrent hook processes create one logical delivery", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));

  const results = await Promise.all([
    invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData),
    invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData),
  ]);

  expect(results.filter((result) => result.stdout !== "")).toHaveLength(1);
  expect(results.every((result) => result.code === 0 && result.stderr === "")).toBe(true);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(1);
  expect(
    delivery(target)
      .filter((entry) => entry.event_id === EVENT_ONE)
      .map((entry) => entry.state),
  ).toEqual(["claimed"]);
});

test("an abandoned exclusive lock is recovered without losing the pending event", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  const lockDir = join(target.pluginData, "webmcp-feedback-v1", `${binding}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: crypto.randomUUID(),
      pid: 9_000_000,
      created_at_ms: Date.now() - 1_000,
    })}\n`,
  );

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);

  expect(outputJson(result).hookSpecificOutput.additionalContext).toContain(EVENT_ONE);
  expect(existsSync(lockDir)).toBe(false);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(1);
});

test("a lock beyond the hook lifetime is recovered even when its PID is live", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  const lockDir = join(target.pluginData, "webmcp-feedback-v1", `${binding}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      created_at_ms: Date.now() - 40_000,
    })}\n`,
  );

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    WEBMCP_HOOK_LOCK_MAX_AGE_MS: "36000",
  });

  expect(outputJson(result).hookSpecificOutput.additionalContext).toContain(EVENT_ONE);
  expect(existsSync(lockDir)).toBe(false);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(1);
});

test("concurrent processes recover an ownerless crash lock exactly once", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  const lockDir = join(target.pluginData, "webmcp-feedback-v1", `${binding}.lock`);
  mkdirSync(lockDir, { recursive: true });
  const stale = new Date(Date.now() - 5_000);
  utimesSync(lockDir, stale, stale);

  const results = await Promise.all([
    invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData),
    invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData),
  ]);

  expect(results.filter((result) => result.stdout !== "")).toHaveLength(1);
  expect(results.every((result) => result.code === 0 && result.stderr === "")).toBe(true);
  expect(delivery(target).filter((entry) => entry.state === "claimed")).toHaveLength(1);
});

test("invalid PLUGIN_ROOT fails quietly before claiming an event", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 1));

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData, {
    PLUGIN_ROOT: join(target.root, "missing-plugin"),
  });

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(runStatePath(target.pluginData, target.workspace, target.runId))).toBe(false);
  expect(existsSync(join(target.stateDir, "_delivery.ndjson"))).toBe(false);
});

test("bursts are numeric-order sorted and duplicate IDs keep their first valid event", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_THREE, 30));
  appendEvent(
    target,
    event(target.runId, EVENT_ONE, 10, "comment", { suggestion: null, text: "first" }),
  );
  appendEvent(target, event(target.runId, EVENT_TWO, 20));
  appendEvent(
    target,
    event(target.runId, EVENT_ONE, 1, "comment", { suggestion: null, text: "duplicate" }),
  );

  for (const eventId of [EVENT_ONE, EVENT_TWO, EVENT_THREE]) {
    const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
    const context = outputJson(result).hookSpecificOutput.additionalContext as string;
    expect(context).toContain(`"event_id":"${eventId}"`);
    if (eventId === EVENT_ONE) {
      expect(context).toContain('"text":"first"');
      expect(context).not.toContain('"text":"duplicate"');
    }
    acknowledge(target, eventId);
  }
});

test("malformed and oversized lines do not advance event identity", async () => {
  const target = fixture();
  const journal = join(target.stateDir, "_feedback.ndjson");
  appendFileSync(journal, "not-json\n");
  appendFileSync(journal, `${"[".repeat(1_500)}${"]".repeat(1_500)}\n`);
  appendFileSync(
    journal,
    `${JSON.stringify({ ...event(target.runId, EVENT_ONE, 1), order: "wrong" })}\n`,
  );
  appendEvent(target, { ...event(target.runId, EVENT_ONE, 1), extra: true });
  appendEvent(target, { ...event(target.runId, EVENT_ONE, 1), order: 0 });
  appendEvent(target, { ...event(target.runId, EVENT_ONE, 1), payload: {} });
  appendEvent(target, event(target.runId, "not-a-uuid", 1));
  appendFileSync(
    journal,
    `${JSON.stringify(
      event(target.runId, EVENT_OVERSIZED, 1, "comment", {
        suggestion: null,
        text: "x".repeat(70_000),
      }),
    )}\n`,
  );
  appendEvent(
    target,
    event(target.runId, EVENT_ONE, 2, "comment", { suggestion: null, text: "valid" }),
  );

  const result = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  const context = outputJson(result).hookSpecificOutput.additionalContext as string;
  expect(context).toContain(`"event_id":"${EVENT_ONE}"`);
  expect(context).toContain('"text":"valid"');
});

test("run, journal, and private-state symlinks are never followed", async () => {
  const noRunRoot = temporaryRoot();
  const noRunWorkspace = join(noRunRoot, "workspace");
  const noRunState = join(noRunWorkspace, ".webmcp");
  const noRunData = join(noRunRoot, "plugin-data");
  mkdirSync(noRunState, { recursive: true });
  mkdirSync(noRunData);
  const plantedRun = join(noRunRoot, "planted-run.json");
  writeFileSync(plantedRun, "{}\n");
  symlinkSync(plantedRun, join(noRunState, ".run.json"));
  const runResult = await invoke(
    "pre-tool-use",
    input({ workspace: noRunWorkspace }, "PreToolUse"),
    noRunData,
  );
  expect(runResult.stdout).toBe("");

  const target = fixture();
  const plantedFeedback = join(target.root, "planted-feedback.ndjson");
  writeFileSync(plantedFeedback, `${JSON.stringify(event(target.runId, EVENT_ONE, 1))}\n`);
  symlinkSync(plantedFeedback, join(target.stateDir, "_feedback.ndjson"));
  const journalResult = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  expect(journalResult.stdout).toBe("");

  rmSync(join(target.stateDir, "_feedback.ndjson"));
  appendEvent(target, event(target.runId, EVENT_ONE, 1));
  const privateDir = join(target.pluginData, "webmcp-feedback-v1");
  mkdirSync(privateDir, { recursive: true });
  const plantedState = join(target.root, "planted-state.json");
  writeFileSync(plantedState, "outside\n");
  const binding = new Bun.CryptoHasher("sha256")
    .update(`${target.workspace}\0${target.runId}`)
    .digest("hex");
  symlinkSync(plantedState, join(privateDir, `${binding}.json`));
  const privateResult = await invoke("pre-tool-use", input(target, "PreToolUse"), target.pluginData);
  expect(privateResult.stdout).toBe("");
  expect(readFileSync(plantedState, "utf8")).toBe("outside\n");
  expect(lstatSync(join(privateDir, `${binding}.json`)).isSymbolicLink()).toBe(true);

  const deliveryTarget = fixture();
  const plantedDelivery = join(deliveryTarget.root, "planted-delivery.ndjson");
  writeFileSync(plantedDelivery, "outside\n");
  symlinkSync(plantedDelivery, join(deliveryTarget.stateDir, "_delivery.ndjson"));
  appendEvent(deliveryTarget, event(deliveryTarget.runId, EVENT_ONE, 1));
  const deliveryResult = await invoke(
    "pre-tool-use",
    input(deliveryTarget, "PreToolUse"),
    deliveryTarget.pluginData,
  );
  expect(deliveryResult.stdout).toBe("");
  expect(readFileSync(plantedDelivery, "utf8")).toBe("outside\n");
});

test("Stop catches an action that arrives during its bounded wait", async () => {
  const target = fixture();
  const pending = invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "600",
    WEBMCP_HOOK_POLL_MS: "20",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if (delivery(target).some((entry) => entry.state === "waiting")) break;
    } catch {}
    await Bun.sleep(10);
  }
  expect(delivery(target).some((entry) => entry.state === "waiting")).toBe(true);
  expect(delivery(target).find((entry) => entry.state === "waiting")).toMatchObject({
    queue_depth: 0,
    last_order: 0,
  });
  appendEvent(target, event(target.runId, EVENT_DELAYED, 1, "approve"));

  const result = await pending;
  expect(outputJson(result)).toMatchObject({ decision: "block" });
  expect(JSON.parse(result.stdout).reason).toContain(`"event_id":"${EVENT_DELAYED}"`);
  expect(delivery(target).map((entry) => entry.state)).toContainAllValues(["waiting", "claimed"]);
});

test("Stop timeout is visible and exits without continuing the turn", async () => {
  const target = fixture();
  appendEvent(target, event(target.runId, EVENT_ONE, 7));
  acknowledge(target, EVENT_ONE);
  const result = await invoke("stop", input(target, "Stop"), target.pluginData, {
    WEBMCP_HOOK_STOP_WAIT_MS: "80",
    WEBMCP_HOOK_POLL_MS: "20",
  });

  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  const statuses = delivery(target).map((entry) => entry.state);
  expect(statuses[0]).toBe("waiting");
  expect(statuses.at(-1)).toBe("timeout");
  expect(delivery(target)[0]).toMatchObject({ queue_depth: 0, last_order: 7 });
  expect(delivery(target).at(-1)).toMatchObject({ queue_depth: 0, last_order: 7 });
});
