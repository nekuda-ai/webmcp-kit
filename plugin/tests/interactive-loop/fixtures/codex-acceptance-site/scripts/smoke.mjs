import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "reading-room-smoke-"));
const stateFile = join(temporaryDirectory, "state.json");
const publicDirectory = join(temporaryDirectory, "public");
await cp(join(ROOT, "public"), publicDirectory, { recursive: true });
await mkdir(join(publicDirectory, "webmcp"));
await mkdir(join(publicDirectory, "webmcp", "tools"));
await writeFile(
  join(publicDirectory, "webmcp", "entry.js"),
  'import { generated } from "./tools/read.mjs";\nexport { generated };\n',
);
await writeFile(join(publicDirectory, "webmcp", "tools", "read.mjs"), 'export const generated = "served";\n');
const indexPath = join(publicDirectory, "index.html");
await writeFile(
  indexPath,
  (await readFile(indexPath, "utf8")).replace(
    "</head>",
    '    <script type="module" src="/webmcp/entry.js"></script>\n  </head>',
  ),
);

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      PUBLIC_DIR: publicDirectory,
      STATE_FILE: stateFile,
    },
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
  assert.match(
    homepageResponse.headers.get("content-security-policy") || "",
    /(?:^|;\s*)connect-src 'self' https:\/\/ingest\.agentlane\.dev(?:;|$)/,
  );
  assert.match(homepage, /<h1[^>]*>Useful things for/);
  console.log("ok: browser entry page permits SDK telemetry ingest");

  const entryPath = /<script type="module" src="([^"]*webmcp[^"]*)"><\/script>/.exec(homepage)?.[1];
  assert.equal(entryPath, "/webmcp/entry.js");
  const entryResponse = await fetch(new URL(entryPath, base));
  assert.equal(entryResponse.status, 200);
  assert.match(entryResponse.headers.get("content-type") || "", /^text\/javascript/);
  const entrySource = await entryResponse.text();
  const importedPath = /from "([^"]+)"/.exec(entrySource)?.[1];
  assert.equal(importedPath, "./tools/read.mjs");
  const importedResponse = await fetch(new URL(importedPath, entryResponse.url));
  assert.equal(importedResponse.status, 200);
  assert.match(importedResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.equal(await importedResponse.text(), 'export const generated = "served";\n');
  console.log("ok: the browser-visible generated module graph is served");

  const malformedResponse = await fetch(`${base}/bad%`);
  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), { error: "URL path has malformed percent encoding" });
  console.log("ok: malformed static paths fail with 400");

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
