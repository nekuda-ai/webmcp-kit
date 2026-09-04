import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import type { CredentialStore, StoredCredentials } from "./credentials";
import { createCredentialStore } from "./credentials";
import { CliError, apiBaseFor, type LoginOptions, loginWithConfig } from "./login";

export const CONNECT_DIRECTORY = ".webmcp";
export const CONNECT_FILE = "connect.json";
export const CONNECT_LOCK_FILE = "connect.lock";
/**
 * A connect run can legitimately sit at the browser consent screen for minutes, so the lock is
 * only presumed abandoned well past that. A holder whose pid is provably gone is stolen sooner.
 */
export const CONNECT_LOCK_STALE_MS = 15 * 60_000;
/**
 * The ceiling a live-looking pid cannot outlast. A pid proves nothing across machines:
 * a `connect.lock` that gets committed, or one left behind before a reboot, names a
 * number some unrelated process now holds, and `kill(pid, 0)` says "alive" forever.
 * Without this, that workspace answers `connect_in_progress` for every clone, for good.
 * Far past any consent screen, so a genuinely live holder is never stolen from.
 */
export const CONNECT_LOCK_MAX_AGE_MS = 12 * 60 * 60_000;

export type ConnectFile = {
  org: string;
  domain_id: string;
  domain_public_id: string;
  display_name: string;
  environment: string;
  key_id: string;
  dashboard_url: string;
  ingest_url?: string;
};

export type TokenIdentity = {
  account: string;
  org: string | null;
};

export type ConnectResult = {
  status: "connected" | "pending_propagation";
  edge_verification: "ready" | "pending" | "disabled";
  account: string;
  org: string;
  domain: { id: string; public_id: string; display_name: string };
  environment: string;
  api_key: { id: string; value: string; enabled: boolean };
  dashboard_url: string;
  ingest_url?: string;
  reused: boolean;
  connection_file: string | null;
};

type ProvisionResponse = {
  domain: { id: string; public_id: string; display_name: string };
  api_key: { id: string; key: string; enabled: boolean };
  reused: boolean;
  edge_ready: boolean;
  edge_verification?: "disabled";
  dashboard_url: string;
};

export type ConnectOptions = LoginOptions & {
  workspace: string;
  siteUrl?: string;
  environment?: string;
  org?: string;
  retryDelayMs?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  projectKey?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseProvision(value: unknown): ProvisionResponse | null {
  if (!isRecord(value) || !isRecord(value.domain) || !isRecord(value.api_key)) return null;
  const domainId = stringField(value.domain, "id");
  const publicId = stringField(value.domain, "public_id");
  const displayName = stringField(value.domain, "display_name");
  const keyId = stringField(value.api_key, "id");
  const key = stringField(value.api_key, "key");
  const dashboardUrl = stringField(value, "dashboard_url");
  if (
    !domainId ||
    !publicId ||
    !displayName ||
    !keyId ||
    !key ||
    typeof value.api_key.enabled !== "boolean" ||
    typeof value.reused !== "boolean" ||
    typeof value.edge_ready !== "boolean" ||
    !dashboardUrl
  ) {
    return null;
  }
  return {
    domain: { id: domainId, public_id: publicId, display_name: displayName },
    api_key: { id: keyId, key, enabled: value.api_key.enabled },
    reused: value.reused,
    edge_ready: value.edge_ready,
    edge_verification: value.edge_verification === "disabled" ? "disabled" : undefined,
    dashboard_url: dashboardUrl,
  };
}

export function tokenIdentity(credentials: StoredCredentials): TokenIdentity | null {
  try {
    const payload = JSON.parse(
      Buffer.from(credentials.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      account: payload.sub,
      org: typeof payload.org_id === "string" && payload.org_id ? payload.org_id : null,
    };
  } catch {
    return null;
  }
}

async function workspacePath(raw: string): Promise<string> {
  let path: string;
  try {
    path = await realpath(raw);
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CliError("workspace_not_found", `Workspace is not a directory: ${raw}`);
  }
  return path;
}

function gitOutput(workspace: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Stable across clones/worktrees when a Git remote exists; path-stable otherwise. */
export async function deriveProjectKey(workspace: string): Promise<string> {
  const resolved = await workspacePath(workspace);
  const root = gitOutput(resolved, ["rev-parse", "--show-toplevel"]);
  const remote = gitOutput(resolved, ["config", "--get", "remote.origin.url"]);
  const identity =
    root && remote
      ? `${remote.replace(/\.git$/, "")}\n${relative(root, resolved).replaceAll("\\", "/") || "."}`
      : resolved;
  const kind = root && remote ? "git" : "path";
  return `${kind}:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function connectFilePath(workspace: string): string {
  return join(workspace, CONNECT_DIRECTORY, CONNECT_FILE);
}

export function connectLockPath(workspace: string): string {
  return join(workspace, CONNECT_DIRECTORY, CONNECT_LOCK_FILE);
}

export async function readConnectFile(workspace: string): Promise<ConnectFile | null> {
  try {
    const value = JSON.parse(await readFile(connectFilePath(workspace), "utf8"));
    if (!isRecord(value)) return null;
    const fields = [
      "org",
      "domain_id",
      "domain_public_id",
      "display_name",
      "environment",
      "key_id",
      "dashboard_url",
    ] as const;
    if (fields.some((field) => !stringField(value, field))) return null;
    if (!isUuid(value.domain_id) || !isUuid(value.key_id)) return null;
    const ingestUrl = value.ingest_url;
    if (ingestUrl !== undefined && typeof ingestUrl !== "string") return null;
    if (ingestUrl !== undefined) {
      try {
        const parsed = new URL(ingestUrl);
        if (
          parsed.toString() !== ingestUrl ||
          !["http:", "https:"].includes(parsed.protocol) ||
          !ingestUrl.endsWith("/v1/collect")
        ) {
          return null;
        }
      } catch {
        return null;
      }
    }
    return {
      ...(Object.fromEntries(fields.map((field) => [field, value[field]])) as ConnectFile),
      ...(typeof ingestUrl === "string" ? { ingest_url: ingestUrl } : {}),
    };
  } catch {
    return null;
  }
}

async function writeConnectFile(workspace: string, value: ConnectFile): Promise<string> {
  const path = connectFilePath(workspace);
  // Atomically: a truncated connect.json reads back as null, which reports the
  // workspace as not connected and loses the saved Domain binding.
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function apiJson(
  url: string,
  credentials: StoredCredentials,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new CliError("api_unavailable", "Could not reach the WebMCP API");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status below remains the useful fact when a proxy returns non-JSON.
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    const code = error && stringField(error, "code");
    const message = error && stringField(error, "message");
    throw new CliError(
      code ?? "api_error",
      message ?? `WebMCP API request failed (${response.status})`,
    );
  }
  return body;
}

async function authenticated(
  options: ConnectOptions,
  store: CredentialStore,
  forceConsent = false,
): Promise<{ credentials: StoredCredentials; identity: TokenIdentity; ingestUrl?: string }> {
  let login = await loginWithConfig({
    ...options,
    store,
    forceConsent,
  });
  let loaded = await store.load();
  let identity = loaded ? tokenIdentity(loaded.credentials) : null;
  if (!loaded || !identity) {
    throw new CliError("invalid_credentials", "Stored WebMCP credentials are invalid");
  }
  if (!forceConsent && (!identity.org || (options.org && identity.org !== options.org))) {
    login = await loginWithConfig({
      ...options,
      store,
      forceConsent: true,
    });
    loaded = await store.load();
    identity = loaded ? tokenIdentity(loaded.credentials) : null;
  }
  if (!loaded || !identity) {
    throw new CliError("invalid_credentials", "Stored WebMCP credentials are invalid");
  }
  if (!identity.org) {
    throw new CliError(
      "no_active_organization",
      "OAuth login has no selected organization; authorize again and select one",
    );
  }
  if (options.org && identity.org !== options.org) {
    throw new CliError(
      "organization_mismatch",
      `OAuth consent selected ${identity.org}, not requested organization ${options.org}`,
    );
  }
  return {
    credentials: loaded.credentials,
    identity,
    ...(login.config.ingest_url ? { ingestUrl: login.config.ingest_url } : {}),
  };
}

/**
 * Stale means provably abandoned: a holder pid that is gone, or — when the
 * advisory names no pid to check — one that has aged out.
 *
 * The pid answers FIRST, and a live holder is never stale however old the file
 * is. Age alone cannot retire a lock: OAuth consent runs inside this lock and a
 * human can sit on that browser tab far longer than the window, and stealing the
 * advisory from a run that is still going reopens exactly the duplicate-Domain
 * race the lock exists to close (F15). The cost of erring this way is a wedged
 * run holding the file, which `connect_in_progress` already tells the operator
 * how to clear.
 */
function lockIsStale(raw: string, mtimeMs: number): boolean {
  let pid: unknown;
  let host: unknown;
  try {
    ({ pid, host } = JSON.parse(raw));
  } catch {
    pid = undefined;
  }
  const ageMs = Date.now() - mtimeMs;
  // A pid is only meaningful on the machine that issued it, so it is trusted only when
  // the advisory names this host. Elsewhere — a committed lock, a different container or
  // pid namespace — the number is someone else's and `kill(pid, 0)` answers about them.
  if (typeof pid === "number" && pid > 0 && host === hostname() && ageMs <= CONNECT_LOCK_MAX_AGE_MS) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // EPERM is someone else's live process: a holder we cannot prove is gone counts as live.
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }
  // Unreadable content, a holder that named no pid, a pid from another machine, or one
  // that has outlasted the ceiling: only the age can retire it.
  return ageMs > CONNECT_LOCK_STALE_MS;
}

/** The advisory as a claim can re-identify it: `rename` moves both fields unchanged. */
type StaleLock = { ino: number; mtimeMs: number };

/**
 * The holder at `path` as a claimable identity — `"gone"` when there is nothing there,
 * null when it is not provably abandoned and must be left alone.
 */
export async function judgeStaleLock(path: string): Promise<StaleLock | "gone" | null> {
  let raw: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  } catch {
    return "gone";
  }
  if (!lockIsStale(raw, info.mtimeMs)) return null;
  return { ino: info.ino, mtimeMs: info.mtimeMs };
}

/**
 * Remove the advisory `judged` named, and answer whether the path is free to retry.
 *
 * This judged a path it does not own, and neither `rm` nor `rename` can be told WHICH
 * file to remove: both take whatever currently sits there. Two runs judging the same
 * stale advisory both proceed, and the loser acts AFTER the winner has stolen it,
 * acquired, and written its own — deleting a LIVE lock and letting both into
 * `provision()`, the duplicate-Domain race the lock exists to close (F15).
 *
 * So identity is confirmed BEFORE the path is touched, not after: a holder that is no
 * longer the inode we judged is left completely alone and the run refused. Confirming
 * afterwards is not equivalent, however carefully the mismatch is undone — the canonical
 * path stands empty in between, so a third run's `open("wx")` can acquire inside that
 * window, the restore then finds the name taken, and the live holder's advisory is gone
 * for good. The judgement is arbitrarily old (the winner can steal, acquire and enter
 * `provision()` between the two halves), so that window is the whole exposure.
 *
 * The pre-check leaves a two-syscall gap, and the `rename` does NOT arbitrate inside it — it
 * moves whatever sits there. A racer holding the SAME judgement that acquires between the
 * `stat` and the `rename` has its live advisory moved away, a third run's `open("wx")` takes
 * the emptied name, the restore below then finds it taken, and two runs provision. That gap is
 * closed one level up by the mutex in `releaseStaleLock`, which is what makes the pre-check
 * decide. The re-validation stays as the belt to those braces, and answers the residual the
 * mutex does not: anything that is not the judged inode is linked straight back (`link`
 * refuses to clobber, so a third acquirer keeps its own).
 *
 * Split from the judgement, and both exported, because the window between them is the
 * whole bug: a test cannot interleave two runs inside one call, but it can drive the
 * halves in the losing order.
 */
export async function claimStaleLock(path: string, judged: StaleLock): Promise<boolean> {
  const holder = await stat(path).catch(() => null);
  // Gone already: the path is free and `open("wx")` is what actually arbitrates.
  if (!holder) return true;
  if (holder.ino !== judged.ino || holder.mtimeMs !== judged.mtimeMs) return false;
  const claimed = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, claimed);
  } catch {
    // Someone else stole or released it first; the path is free either way.
    return true;
  }
  const taken = await stat(claimed).catch(() => null);
  const mine = taken?.ino === judged.ino && taken?.mtimeMs === judged.mtimeMs;
  if (!mine) await link(claimed, path).catch(() => {});
  await rm(claimed, { force: true }).catch(() => {});
  return mine;
}

/** The mutex a run holds while it judges and claims the advisory at `path`. */
function breakLockPath(path: string): string {
  return `${path}.break`;
}

/**
 * True when the path is free to retry — already gone, or a stale holder we claimed.
 *
 * Judging and claiming run under a mutex because they are one decision split across syscalls:
 * two runs that judged the same advisory are exactly what replaces the inode inside
 * `claimStaleLock`'s gap, at the cost that comment names. Under the mutex the only remaining
 * way for that inode to leave the path is its own holder releasing it.
 *
 * Contention is refused, not retried: a run that cannot take the mutex is racing one that
 * holds it and is about to hold the workspace, so `connect_in_progress` is the same answer a
 * syscall later.
 *
 * The mutex is never broken, at ANY age — `open("wx")` is the whole protocol. Breaking a lock
 * file means acting on a pathname whose contents can change under the decision, which is
 * precisely `claimStaleLock`'s two-syscall gap, and what closes that gap for the advisory is
 * this mutex. Applying the same protocol TO the mutex has nothing left underneath it: a loser
 * that judged the orphan the winner already retired renames the winner's LIVE guard aside, a
 * third run's `open("wx")` takes the emptied name, and two runs are inside the judge-and-claim
 * this exists to serialize — F15's duplicate-Domain race, one level down. Age cannot rescue
 * that; it only sets how long the window stays shut. So a guard nobody removes is the
 * deliberate cost, and it is a cheap one: it is held across a handful of syscalls and nothing
 * else — no network, no consent screen — so an orphan means a hard kill inside that instant;
 * it costs only the AUTOMATIC breaking of stale advisories, never a normal acquire, which
 * consults it not at all; and `inProgressMessage` names the file so the operator clearing the
 * advisory clears this beside it.
 *
 * Residual, deliberately: a holder judged stale by AGE may still be alive and release inside
 * that gap, which is what the claim's re-validation still answers. Closing it outright would
 * mean releasing under this mutex too — and then one orphaned mutex leaks every run's
 * advisory, instead of merely refusing to break stale ones.
 */
async function releaseStaleLock(path: string): Promise<boolean> {
  const guard = breakLockPath(path);
  let held: Awaited<ReturnType<typeof open>>;
  try {
    held = await open(guard, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    const judged = await judgeStaleLock(path);
    if (judged === "gone") return true;
    if (!judged) return false;
    return await claimStaleLock(path, judged);
  } finally {
    // Both swallowed, and the close especially: an unguarded reject here skips the
    // `rm` below it, and a guard nobody removes is a guard that never expires — no
    // later run in this workspace could break a stale advisory again (see above), so
    // a transient fs error would cost the workspace its recovery path permanently.
    await held.close().catch(() => {});
    await rm(guard, { force: true }).catch(() => {});
  }
}

/**
 * Why the run was refused, naming the break mutex whenever one is sitting there.
 *
 * That file is never broken automatically (see `releaseStaleLock`), so while it exists no
 * stale advisory in this workspace can be broken either — and an operator who deletes only
 * the advisory is told nothing by a second refusal on the next run. It is equally a LIVE
 * breaker's mutex, which is why the sentence carries the same "if no run is active" condition
 * as the advisory it stands beside rather than an instruction to remove it.
 */
async function inProgressMessage(path: string): Promise<string> {
  const guard = breakLockPath(path);
  const orphan = await stat(guard).then(
    () => true,
    () => false,
  );
  return (
    `Another webmcp connect run holds ${path}. Wait for it to finish, ` +
    "or delete that file if no run is active." +
    (orphan ? ` A run also left ${guard} behind; delete that one too.` : "")
  );
}

/** O_EXCL, so two runs cannot both believe they hold the workspace. */
async function acquireLock(path: string, id: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && (await releaseStaleLock(path))) continue;
      throw new CliError("connect_in_progress", await inProgressMessage(path));
    }
    try {
      // `host` is what makes `pid` checkable: see `lockIsStale`.
      await file.writeFile(
        `${JSON.stringify({ id, pid: process.pid, host: hostname(), started_at: new Date().toISOString() })}\n`,
      );
    } finally {
      await file.close();
    }
    return;
  }
}

async function withAdvisoryLock<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const path = connectLockPath(workspace);
  const id = randomUUID();
  await acquireLock(path, id);
  try {
    return await work();
  } finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current?.id === id) await rm(path, { force: true });
    } catch {
      // A missing/replaced advisory belongs to no cleanup protocol.
    }
  }
}

export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const workspace = await workspacePath(options.workspace);
  const environment = options.environment?.trim().toLowerCase() || "production";
  const siteUrl = options.siteUrl?.trim();
  if (siteUrl) {
    try {
      const url = new URL(siteUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad scheme");
    } catch {
      throw new CliError("invalid_site_url", "--site-url must be an http(s) URL");
    }
  }
  const store = options.store ?? createCredentialStore();
  const fetcher = options.fetch ?? fetch;
  const base = apiBaseFor(options);
  const projectKey = options.projectKey ?? (await deriveProjectKey(workspace));
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);

  return withAdvisoryLock(workspace, async () => {
    let auth = await authenticated(options, store);
    const provision = async (): Promise<ProvisionResponse> => {
      const saved = await readConnectFile(workspace);
      const domainBody = {
        project_key: projectKey,
        source: "kit",
        display_name: basename(workspace),
        ...(siteUrl ? { site_url: siteUrl } : {}),
        ...(saved?.org === auth.identity.org ? { domain_id: saved.domain_id } : {}),
      };
      const domainValue = await apiJson(
        `${base}/v1/domains`,
        auth.credentials,
        { method: "POST", body: JSON.stringify(domainBody) },
        fetcher,
      );
      if (!isRecord(domainValue) || !stringField(domainValue, "id")) {
        throw new CliError("invalid_response", "The WebMCP API returned an invalid domain");
      }
      const domainId = domainValue.id as string;
      let last: ProvisionResponse | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const keyValue = await apiJson(
          `${base}/v1/domains/${encodeURIComponent(domainId)}/api-keys`,
          auth.credentials,
          { method: "POST", body: JSON.stringify({ environment }) },
          fetcher,
        );
        last = parseProvision(keyValue);
        if (!last) {
          throw new CliError("invalid_response", "The WebMCP API returned an invalid API key");
        }
        if (last.edge_ready || last.edge_verification === "disabled" || attempt === maxAttempts) {
          break;
        }
        await sleep(retryDelayMs);
      }
      return last as ProvisionResponse;
    };

    let provisioned: ProvisionResponse;
    try {
      provisioned = await provision();
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "unauthenticated") throw error;
      auth = await authenticated(options, store, true);
      provisioned = await provision();
    }

    const edgeVerification = provisioned.edge_ready
      ? "ready"
      : provisioned.edge_verification === "disabled"
        ? "disabled"
        : "pending";
    let path: string | null = null;
    if (provisioned.edge_ready) {
      path = await writeConnectFile(workspace, {
        org: auth.identity.org as string,
        domain_id: provisioned.domain.id,
        domain_public_id: provisioned.domain.public_id,
        display_name: provisioned.domain.display_name,
        environment,
        key_id: provisioned.api_key.id,
        dashboard_url: provisioned.dashboard_url,
        ...(auth.ingestUrl ? { ingest_url: auth.ingestUrl } : {}),
      });
    }
    return {
      status: provisioned.edge_ready ? "connected" : "pending_propagation",
      edge_verification: edgeVerification,
      account: auth.identity.account,
      org: auth.identity.org as string,
      domain: provisioned.domain,
      environment,
      api_key: {
        id: provisioned.api_key.id,
        value: provisioned.api_key.key,
        enabled: provisioned.api_key.enabled,
      },
      dashboard_url: provisioned.dashboard_url,
      ...(auth.ingestUrl ? { ingest_url: auth.ingestUrl } : {}),
      reused: provisioned.reused,
      connection_file: path,
    };
  });
}
