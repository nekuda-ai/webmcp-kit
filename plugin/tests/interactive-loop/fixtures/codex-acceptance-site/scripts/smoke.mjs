import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "reading-room-smoke-"));
const stateFile = join(temporaryDirectory, "state.json");

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", STATE_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timed out\n${stderr}`)), 5_000);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before ready (${code})\n${stderr}`));
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not stop after SIGTERM")), 3_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${options?.method || "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

let running;
try {
  running = startServer();
  let base = await running.ready;

  const health = await json(base, "/health");
  assert.deepEqual(health, { status: "ok", service: "reading-room-supply", stateVersion: 1 });
  console.log("ok: health endpoint");

  const homepageResponse = await fetch(base);
  const homepage = await homepageResponse.text();
  assert.equal(homepageResponse.status, 200);
  assert.match(homepageResponse.headers.get("content-type") || "", /^text\/html/);
  assert.match(homepage, /<h1[^>]*>Useful things for/);
  console.log("ok: browser entry page");

  const initial = await json(base, "/api/catalog?q=warm&available=true");
  assert.equal(initial.products.length, 1);
  assert.equal(initial.products[0].id, "aurora-lamp");
  assert.equal(initial.products[0].available, 4);
  console.log("ok: catalog read and filtering");

  const created = await json(base, "/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "aurora-lamp", quantity: 2 }),
  });
  assert.equal(created.reservation.quantity, 2);
  assert.equal(created.available, 2);
  const reservations = await json(base, "/api/reservations");
  assert.equal(reservations.reservations.length, 1);
  assert.equal(reservations.reservations[0].productName, "Aurora task lamp");
  console.log("ok: reservation mutation");

  await stopServer(running.child);
  running = startServer();
  base = await running.ready;
  const afterRestart = await json(base, "/api/catalog?q=Aurora");
  assert.equal(afterRestart.products[0].available, 2);
  assert.equal(afterRestart.summary.reservationCount, 1);
  console.log("ok: state persists across restart");

  const reset = await json(base, "/api/reset", { method: "POST" });
  assert.equal(reset.reset, true);
  assert.equal(reset.reservationCount, 0);
  const restored = await json(base, "/api/catalog?q=Aurora");
  assert.equal(restored.products[0].available, 4);
  assert.equal((await json(base, "/api/reservations")).reservations.length, 0);
  console.log("ok: reset restores starting inventory and clears reservations");

  console.log("PASS: acceptance fixture smoke test");
} finally {
  if (running) await stopServer(running.child).catch(() => running.child.kill("SIGKILL"));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
