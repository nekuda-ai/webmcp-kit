// Interactive-loop relay server (NEK-693, ported from spike NEK-672). Bun, zero deps.
// Folder-as-truth: watches the state folder `<root>/.webmcp/` and pushes changed files to
// Explorer clients; appends page events to _feedback.ndjson and relays the actionable ones
// to Claude's Monitor. Run: bun server.ts [repo root]   (default: cwd)
import {
  watch, readdirSync, readFileSync, lstatSync, openSync, writeSync, closeSync,
  linkSync, renameSync, unlinkSync, mkdirSync, constants,
} from "node:fs";
import { join } from "node:path";

const HEALTH = "webmcp-explorer";
const ACTIONABLE = new Set(["comment", "submit", "feedback", "approve"]);
const MAX_EVENT_BYTES = 64 * 1024;
const stateDir = join(process.argv[2] ?? process.cwd(), ".webmcp");
const portFile = join(stateDir, ".port");
// .port is the live claim and is released on shutdown; .port.last survives it, so a
// restart can rebind the same port. One origin across restarts keeps the page's
// localStorage (tour dismissal, theme) and any open tab or printed URL valid (NEK-735).
const lastPortFile = join(stateDir, ".port.last");
const gitignoreFile = join(stateDir, ".gitignore");
let ownPortFile = false;

// The state folder must be a real directory: a repo can ship `.webmcp -> /elsewhere` and
// every read and write below would go through it.
function stateDirIsReal(): boolean {
  try {
    return !lstatSync(stateDir).isSymbolicLink();
  } catch {
    return false; // absent
  }
}
try {
  if (lstatSync(stateDir).isSymbolicLink()) {
    console.error(`refusing to start: ${stateDir} is a symlink; the state folder must be a real directory`);
    process.exit(1);
  }
} catch {} // absent — mkdir creates a real directory
mkdirSync(stateDir, { recursive: true });

// .webmcp/ is git-tracked, so its contents are untrusted input: a port is only a port if
// it is a regular file holding a plain decimal port number.
function portNumberIn(file: string): number | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const raw = readFileSync(file, "utf8").trim();
    if (!/^[0-9]{1,5}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
function portFileValue(): number | null {
  return portNumberIn(portFile);
}

// The port this run should try first: a stale .port (unclean death), else .port.last
// (clean shutdown). 0 when neither exists or another live loop holds it.
async function reusablePort(): Promise<number> {
  const prev = portFileValue() ?? portNumberIn(lastPortFile);
  if (prev === null) return 0;
  if (await liveLoopOn(prev)) return 0; // a live loop owns that origin — stay off it
  return prev;
}

function recordLastPort(port: number): void {
  // Same untrusted-input rule as .port: never write through a planted non-file.
  try {
    if (!lstatSync(lastPortFile).isFile()) return;
    unlinkSync(lastPortFile);
  } catch {} // absent — fine
  try {
    writeFileExclusive(lastPortFile, String(port));
  } catch {}
}

async function liveLoopOn(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return (await res.text()) === HEALTH;
  } catch {
    return false;
  }
}

const rand = () => crypto.randomUUID().slice(0, 8);

// Write the whole buffer through an exclusively created, never-followed descriptor.
function writeFileExclusive(path: string, text: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    const buf = Buffer.from(text, "utf8");
    if (writeSync(fd, buf, 0, buf.length) !== buf.length) throw new Error("short write");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A claim staged by a process that no longer exists is litter in a git-tracked folder.
function scavengeStagedClaims(): void {
  let names: string[] = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^\.port\.stale\./.test(name)) {
      try {
        unlinkSync(join(stateDir, name)); // an evicted claim its evictor never got to delete
      } catch {}
      continue;
    }
    const owner = /^\.port\.(\d+)\./.exec(name);
    if (!owner) continue;
    try {
      process.kill(Number(owner[1]), 0);
      continue; // owner is alive (or not ours to judge) — leave it
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    try {
      unlinkSync(join(stateDir, name));
    } catch {}
  }
}

// No eviction: another interactive loop may be live in the same repo. Claim .port with its
// content in one publish — stage an exclusive, unguessable file, then link(2) it into place,
// which fails if the name exists. If a live loop already holds it, leave the file to it and
// warn — Claude sees this in the Bash output.
async function claimPortFile(port: number): Promise<void> {
  const stake = (): "claimed" | "taken" | "failed" => {
    const tmp = `${portFile}.${process.pid}.${rand()}`;
    try {
      writeFileExclusive(tmp, String(port));
      linkSync(tmp, portFile);
      return "claimed";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "taken"; // someone else holds .port
      console.log(`warning: could not write .webmcp/.port (${code ?? err}); the port printed below is authoritative`);
      return "failed";
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  };
  // Evict a stale claim by renaming it aside: only one racer's rename can win, so the losers
  // never delete a file the winner has already replaced. `judged` is the value that was found
  // stale — if .port changed while it was being probed, re-loop instead of evicting.
  // The re-check → rename window is a deliberate TOCTOU, not an oversight: reaching it needs
  // two starters racing a stale claim, and the worst case is a stranded `.port.stale.*` that
  // the next start scavenges. The stdout port is authoritative (references/interactive.md),
  // so nothing here is worth a lock file.
  const evictStale = (judged: number | null): void => {
    if (portFileValue() !== judged) return;
    const aside = `${portFile}.stale.${rand()}`;
    try {
      renameSync(portFile, aside);
    } catch {
      return; // another starter got there first
    }
    try {
      unlinkSync(aside);
    } catch {}
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = stake();
    if (outcome === "claimed") {
      ownPortFile = true;
      ensurePortIgnored();
      return;
    }
    if (outcome === "failed") return; // already warned
    const held = portFileValue();
    if (held === null) {
      // Not a regular file (e.g. a planted symlink) or unreadable — never write through it.
      try {
        if (!lstatSync(portFile).isFile()) {
          console.log(`warning: .webmcp/.port is not a plain port file — leaving it untouched; ` +
            `use the port printed below`);
          return;
        }
      } catch {
        continue; // vanished — retry the claim
      }
    } else if (held === port) {
      // Our own port — a previous life's stale claim. Nothing else can be live
      // there (we just bound it), so probing would answer our own /healthz and
      // misread it as another loop. Evict and re-stake.
    } else if (await liveLoopOn(held)) {
      console.log(`warning: another interactive loop is already live on port ${held} ` +
        `(.webmcp/.port stays its); this one serves on a separate port`);
      return;
    }
    evictStale(held); // stale: unparseable, or nothing alive behind it
  }
  console.log("warning: .webmcp/.port stayed contended; this server did not claim it, " +
    "so use the port printed below");
}

function ensurePortIgnored(): void {
  try {
    writeFileExclusive(gitignoreFile, ".port*\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      console.log(`warning: could not write .webmcp/.gitignore (${(err as NodeJS.ErrnoException).code ?? err})`);
    }
  }
}

// Read per request so editing the Explorer page doesn't need a server restart.
function page(): string {
  try {
    return readFileSync(join(import.meta.dir, "explorer.html"), "utf8");
  } catch {
    return `<!doctype html><meta charset="utf-8"><title>WebMCP Explorer</title>
<h1>WebMCP Explorer (placeholder)</h1><pre id="s">connecting…</pre><script>
new WebSocket("ws://" + location.host + "/ws?role=page").onmessage =
  (e) => { s.textContent = JSON.stringify(JSON.parse(e.data), null, 2); };
</script>`;
  }
}

// Append one event line; true only if it actually landed. O_NOFOLLOW: never write through a
// symlink planted in the tracked state folder. A failure is reported, never fatal.
function recordEvent(line: string): boolean {
  if (!stateDirIsReal()) {
    console.log("warning: could not record the event (state folder is missing or is a symlink)");
    return false;
  }
  let fd: number | undefined;
  try {
    fd = openSync(join(stateDir, "_feedback.ndjson"),
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    // Append-only and self-isolating: one write of "\n" + record + "\n". Two loops may share
    // this trail, and no inspect-then-append can be made atomic across processes — a leading
    // newline needs neither, terminating whatever fragment anyone left. Blank lines are normal.
    const buf = Buffer.from("\n" + line + "\n", "utf8");
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.log(`warning: only ${written}/${buf.length} bytes of the event reached _feedback.ndjson; ` +
        "it was dropped, and the next append isolates the fragment");
      return false;
    }
    return true;
  } catch (err) {
    console.log(`warning: could not record the event (${(err as NodeJS.ErrnoException).code ?? err})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return false;
}

function stateFiles(): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  let names: string[] = [];
  try {
    if (stateDirIsReal()) names = readdirSync(stateDir); // gone mid-loop is a recovery case
  } catch {}
  for (const name of names) {
    if (name.startsWith(".")) continue; // dot-files are runtime plumbing, not state
    let fd: number | undefined;
    try {
      // O_NOFOLLOW: a symlink planted in the state folder must not leak what it points at,
      // and there is no window between the check and the read. Directories fail EISDIR.
      fd = openSync(join(stateDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      files[name] = readFileSync(fd, "utf8");
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return files;
}

const snapshot = () => JSON.stringify({ type: "snapshot", files: stateFiles() });

let publishedFiles = stateFiles();
let debounce: ReturnType<typeof setTimeout> | undefined;

function publishChanges(): void {
  clearTimeout(debounce);
  debounce = undefined;
  const next = stateFiles();
  const names = [...new Set([...Object.keys(publishedFiles), ...Object.keys(next)])].sort();
  for (const name of names) {
    const present = Object.prototype.hasOwnProperty.call(next, name);
    if (present && next[name] === publishedFiles[name]) continue;
    server.publish("page", JSON.stringify({ type: "file", name, text: present ? next[name] : null }));
  }
  publishedFiles = next;
}

function releasePortFile(): void {
  // Only the claimant releases .port, and only while it still holds its own port.
  if (ownPortFile && portFileValue() === server.port) {
    try {
      unlinkSync(portFile);
    } catch {}
  }
}

const preferredPort = await reusablePort();
function startServer(port: number) {
  return Bun.serve<{ role: "page" | "claude" }>({
    port, // the previous run's port when free (NEK-735), else 0 and the OS picks
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      // A browser always sends Origin, so any page the user visits could otherwise read the
      // whole plan, forge submit/approve, or kill the loop. Non-browser clients (the Monitor,
      // the robot, curl) send none.
      const origin = req.headers.get("origin");
      const foreign = !!origin && origin !== `http://localhost:${srv.port}` &&
        origin !== `http://127.0.0.1:${srv.port}`;
      if (foreign && (url.pathname === "/ws" || url.pathname === "/shutdown")) {
        console.log(`warning: rejected ${url.pathname} from origin ${origin}`);
        return new Response("forbidden origin", { status: 403 });
      }
      if (url.pathname === "/ws") {
        const role = url.searchParams.get("role");
        // Exact roles only — a typo must fail loudly, not silently join the page role.
        if (role !== "page" && role !== "claude") return new Response("unknown role", { status: 400 });
        if (srv.upgrade(req, { data: { role } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/healthz") return new Response(HEALTH);
      if (url.pathname === "/shutdown" && req.method === "POST") {
        // Flush the final file update (e.g. phase "done") before dying, else the last write
        // races the debounced watcher publish.
        publishChanges();
        releasePortFile();
        setTimeout(() => process.exit(0), 300);
        return new Response("bye");
      }
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      open(ws) {
        ws.subscribe(ws.data.role);
        if (ws.data.role === "page") ws.send(snapshot());
        console.log(`ws open: ${ws.data.role}`);
      },
      message(ws, raw) {
        if (ws.data.role !== "page") return; // the Explorer is the only event source
        const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
        if (bytes > MAX_EVENT_BYTES) {
          ws.send(JSON.stringify({ type: "error", message: "That message is too large. Keep it under 64 KB." }));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        const event = parsed as Record<string, unknown>;
        event.ts = new Date().toISOString();
        const line = JSON.stringify(event);
        // The state folder is the approval trail (ADR-0003): never act on an event that
        // could not be written down — an unrecorded approve would leave no record at all.
        if (!recordEvent(line)) {
          console.log(`warning: dropped ${String(event.type)} — it could not be recorded, so it was not relayed`);
          return;
        }
        // Only actionable events wake Claude — picks are recorded but need no turn.
        if (ACTIONABLE.has(String(event.type))) server.publish("claude", line);
        console.log(`event: ${line}`);
      },
      close(ws) {
        console.log(`ws close: ${ws.data.role}`);
      },
    },
  });
}
let server: ReturnType<typeof startServer>;
try {
  server = startServer(preferredPort);
} catch {
  server = startServer(0); // taken between the probe and the bind — let the OS pick
}
recordLastPort(server.port);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    releasePortFile();
    process.exit(0);
  });
}

const watcher = watch(stateDir, () => {
  clearTimeout(debounce);
  debounce = setTimeout(publishChanges, 120);
});
// The state folder disappearing is a recovery case Claude handles, not a server crash.
watcher.on("error", (err) => console.log(`warning: state folder watch stopped (${err.message})`));

scavengeStagedClaims();
await claimPortFile(server.port);

console.log(`webmcp-explorer on http://localhost:${server.port}  state: ${stateDir}`);
