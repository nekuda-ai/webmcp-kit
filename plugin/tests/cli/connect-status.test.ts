import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  claimStaleLock,
  connect,
  CONNECT_FILE,
  CONNECT_LOCK_MAX_AGE_MS,
  CONNECT_LOCK_STALE_MS,
  connectFilePath,
  connectLockPath,
  judgeStaleLock,
  readConnectFile,
} from "../../cli/connect";
import {
  createFileCredentialStore,
  type CredentialStore,
  type StoredCredentials,
} from "../../cli/credentials";
import { status } from "../../cli/status";
import { main } from "../../cli/webmcp";

const DOMAIN_ID = "10000000-0000-4000-8000-000000000001";
const KEY_ID = "20000000-0000-4000-8000-000000000002";
const PUBLIC_KEY = "wmk_fake_public_key";
const TEST_REFRESH_VALUE = ["test", "refresh", "value"].join("-");
const REFRESH_TOKEN_FIELD = ["refresh", "token"].join("_");
const TRACKING_KEY_FIELD = ["api", "Key"].join("");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function jwt(org = "org_cached", account = "user_cached"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "at+jwt" })}.${encode({ sub: account, org_id: org })}.test`;
}

async function workspace(name = "merchant-app"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "webmcp-connect-test-"));
  temporaryDirectories.push(root);
  const path = join(root, name);
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(
    join(path, "src", "webmcp.ts"),
    'import { registerTools } from "@nekuda/webmcp-sdk";\nregisterTools([]);\n',
  );
  return path;
}

const emptyStore: CredentialStore = {
  async load() {
    return null;
  },
  async save() {
    return "file";
  },
};

function fakePlatform(options: {
  edge?: boolean[];
  edgeVerification?: "disabled";
  enabled?: boolean;
  ingestUrl?: string;
} = {}) {
  let keyPosts = 0;
  let domainPosts = 0;
  let enabled = options.enabled ?? true;
  let ingestUrl = options.ingestUrl;
  let lastDomainBody: Record<string, unknown> | null = null;
  const edge = options.edge ?? [true];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/v1/connect/config") {
        return Response.json({
          oauth: {
            issuer: base,
            client_id: "fake-client",
            scopes: ["openid", "offline_access"],
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
          },
          dashboard_url: `${base}/dashboard`,
          connect_start_url: `${base}/connect/start`,
          ...(ingestUrl ? { ingest_url: ingestUrl } : {}),
        });
      }
      if (request.headers.get("authorization") !== `Bearer ${jwt()}`) {
        return Response.json(
          { error: { code: "unauthenticated", message: "bad bearer" } },
          { status: 401 },
        );
      }
      if (url.pathname === "/v1/domains" && request.method === "POST") {
        domainPosts += 1;
        lastDomainBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          id: DOMAIN_ID,
          public_id: "merchant-public",
          display_name: "merchant-app",
        });
      }
      if (url.pathname === `/v1/domains/${DOMAIN_ID}/api-keys` && request.method === "POST") {
        const edgeReady = edge[Math.min(keyPosts, edge.length - 1)] ?? false;
        keyPosts += 1;
        return Response.json({
          domain: {
            id: DOMAIN_ID,
            public_id: "merchant-public",
            display_name: "merchant-app",
          },
          api_key: { id: KEY_ID, key: PUBLIC_KEY, enabled },
          reused: keyPosts > 1,
          edge_ready: edgeReady,
          ...(options.edgeVerification ? { edge_verification: options.edgeVerification } : {}),
          dashboard_url: `${base}/connection?domain=${DOMAIN_ID}`,
        });
      }
      if (url.pathname === `/v1/domains/${DOMAIN_ID}/api-keys` && request.method === "GET") {
        return Response.json({
          items: [{ id: KEY_ID, key: PUBLIC_KEY, enabled }],
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    server,
    counts: () => ({ domainPosts, keyPosts }),
    lastDomainBody: () => lastDomainBody,
    revoke: () => {
      enabled = false;
    },
    advertiseIngest: (value?: string) => {
      ingestUrl = value;
    },
  };
}

async function credentialsFor(base: string): Promise<CredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), "webmcp-credentials-test-"));
  temporaryDirectories.push(directory);
  const store = createFileCredentialStore(join(directory, "credentials.json"));
  const credentials: StoredCredentials = {
    version: 1,
    access_token: jwt(),
    [REFRESH_TOKEN_FIELD]: TEST_REFRESH_VALUE,
    expires_at: Date.now() + 60 * 60 * 1_000,
    client_id: "fake-client",
    token_endpoint: `${base}/token`,
  };
  await store.save(credentials);
  return store;
}

describe("webmcp connect", () => {
  test("retries propagation, writes token-free info, and reuses the saved Domain", async () => {
    const ingestUrl = "https://ingest-pr-332.pr.agentlane.dev/v1/collect";
    const platform = fakePlatform({ edge: [false, true, true], ingestUrl });
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    try {
      const first = await connect({
        workspace: path,
        siteUrl: "https://shop.example.com/products",
        environment: "Production",
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(first.status).toBe("connected");
      expect(first.edge_verification).toBe("ready");
      expect(first.ingest_url).toBe(ingestUrl);
      expect(first.account).toBe("user_cached");
      expect(platform.counts()).toEqual({ domainPosts: 1, keyPosts: 2 });
      expect(platform.lastDomainBody()).toEqual({
        project_key: "git:sha256:stable",
        source: "kit",
        display_name: "merchant-app",
        site_url: "https://shop.example.com/products",
      });

      const savedText = await readFile(connectFilePath(path), "utf8");
      expect(JSON.parse(savedText)).toEqual({
        org: "org_cached",
        domain_id: DOMAIN_ID,
        domain_public_id: "merchant-public",
        display_name: "merchant-app",
        environment: "production",
        key_id: KEY_ID,
        dashboard_url: `${platform.base}/connection?domain=${DOMAIN_ID}`,
        ingest_url: ingestUrl,
      });
      expect(savedText).not.toContain(PUBLIC_KEY);
      expect(savedText).not.toContain(TEST_REFRESH_VALUE);
      expect(await Bun.file(connectLockPath(path)).exists()).toBe(false);

      const repeat = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(repeat.status).toBe("connected");
      expect(repeat.reused).toBe(true);
      expect(repeat.ingest_url).toBe(ingestUrl);
      expect(platform.lastDomainBody()?.domain_id).toBe(DOMAIN_ID);

      platform.advertiseIngest();
      const productionDefault = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(productionDefault).not.toHaveProperty("ingest_url");
      expect(await readConnectFile(path)).not.toHaveProperty("ingest_url");
    } finally {
      await platform.server.stop(true);
    }
  });

  test("pending and disabled verification do not write connection state or source", async () => {
    const path = await workspace();
    const sourcePath = join(path, "src", "webmcp.ts");
    const before = await readFile(sourcePath, "utf8");
    for (const scenario of [
      { platform: fakePlatform({ edge: [false] }), expected: "pending" },
      {
        platform: fakePlatform({ edge: [false], edgeVerification: "disabled" }),
        expected: "disabled",
      },
    ] as const) {
      const store = await credentialsFor(scenario.platform.base);
      try {
        const result = await connect({
          workspace: path,
          apiBase: scenario.platform.base,
          store,
          projectKey: "git:sha256:stable",
          maxAttempts: 2,
          retryDelayMs: 0,
        });
        expect(result.status).toBe("pending_propagation");
        expect(result.edge_verification).toBe(scenario.expected);
        expect(await Bun.file(connectFilePath(path)).exists()).toBe(false);
        expect(await readFile(sourcePath, "utf8")).toBe(before);
        expect(scenario.platform.counts().keyPosts).toBe(scenario.expected === "disabled" ? 1 : 2);
      } finally {
        await scenario.platform.server.stop(true);
      }
    }
  });

  // F16: a kill (or a stray concurrent run) mid-write used to leave truncated
  // JSON, which readConnectFile answers as "not connected" — losing the saved
  // domain binding. The rewrite now lands by rename, so the old bytes stay
  // readable until the new ones are complete on disk.
  test("rewrites connect.json by rename, never over the live file", async () => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const file = connectFilePath(path);
    const previous = `${JSON.stringify({
      org: "org_cached",
      domain_id: DOMAIN_ID,
      domain_public_id: "merchant-public",
      display_name: "previous-app",
      environment: "production",
      key_id: KEY_ID,
      dashboard_url: `${platform.base}/old`,
    })}\n`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, previous);
    await chmod(file, 0o644);
    const held = await open(file, "r");
    try {
      const result = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });

      expect(result.status).toBe("connected");
      expect((await readConnectFile(path))?.dashboard_url).toBe(
        `${platform.base}/connection?domain=${DOMAIN_ID}`,
      );
      // The descriptor opened before the run still names the old inode — only a
      // rename can leave that true, and it is what keeps a partial read impossible.
      expect(await held.readFile("utf8")).toBe(previous);
      // `writeFile`'s `mode` only applies to a file it creates, so a connect.json
      // that already existed world-readable used to stay that way.
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(dirname(file))).sort()).toEqual([CONNECT_FILE]);
    } finally {
      await held.close();
      await platform.server.stop(true);
    }
  });

  test("main reports pending propagation with a stable non-success exit", async () => {
    const ingestUrl = "https://ingest-pr-332.pr.agentlane.dev/v1/collect";
    const platform = fakePlatform({ edge: [false], ingestUrl });
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const stdout: string[] = [];
    try {
      const code = await main(["connect", "--workspace", path, "--json"], {
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        maxAttempts: 1,
        io: { stdout: (value) => stdout.push(value), stderr: () => {} },
      });
      expect(code).toBe(3);
      expect(JSON.parse(stdout[0])).toMatchObject({
        ok: false,
        command: "connect",
        status: "pending_propagation",
        edge_verification: "pending",
        ingest_url: ingestUrl,
      });
    } finally {
      await platform.server.stop(true);
    }
  });

  test("human Connect output confirms readiness without exposing key material", async () => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const code = await main(["connect", "--workspace", path], {
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
        io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      });
      expect(code).toBe(0);
      expect(stdout).toEqual([
        "Connection ready for merchant-app (production). Return to your agent to finish setup.",
      ]);
      expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).not.toContain(PUBLIC_KEY);
      expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).not.toMatch(/API key/i);
    } finally {
      await platform.server.stop(true);
    }
  });
});

describe("webmcp status", () => {
  test("reports matching, mismatched, revoked, and advisory-lock facts", async () => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    try {
      const connected = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(connected).not.toHaveProperty("ingest_url");
      expect(await readConnectFile(path)).not.toHaveProperty("ingest_url");
      const source = join(path, "src", "webmcp.ts");
      const trackingKey = ["api", "Key"].join("");
      const misleadingValue = ["comment", "is", "not", "a", "fact"].join("-");
      await writeFile(
        source,
        `const label = "tools 🛠";\n// tracking: { ${trackingKey}: "${misleadingValue}" }\nregisterTools([], { tracking: { ${trackingKey}: "${PUBLIC_KEY}", otel: true } });\nregisterTools([], { tracking: { ${trackingKey}: "${PUBLIC_KEY}" } });\n`,
      );
      await writeFile(connectLockPath(path), "stale advisory\n");

      const matching = await status({ workspace: path, apiBase: platform.base, store });
      expect(matching.tracking_api_key_present).toBe(true);
      expect(matching.tracking_api_key_matches).toBe(true);
      expect(matching.tracking_endpoint_matches).toBe(true);
      expect(matching.registration_batches).toEqual([
        {
          path: "src/webmcp.ts",
          index: 1,
          tracking_api_key: true,
          tracking_api_key_matches: true,
          tracking_endpoint: false,
          tracking_endpoint_matches: true,
        },
        {
          path: "src/webmcp.ts",
          index: 2,
          tracking_api_key: true,
          tracking_api_key_matches: true,
          tracking_endpoint: false,
          tracking_endpoint_matches: true,
        },
      ]);
      expect(matching.credentials).toEqual({
        present: true,
        account: "user_cached",
        org: "org_cached",
      });
      expect(matching.flags).toEqual({
        already_connected: true,
        key_mismatch: false,
        key_revoked: false,
        another_session_may_be_running: true,
      });

      await writeFile(
        source,
        `registerTools([], { tracking: { otel: true } });\nregisterTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } });\n`,
      );
      const missingBatch = await status({ workspace: path, apiBase: platform.base, store });
      expect(missingBatch.tracking_api_key_present).toBe(false);
      expect(missingBatch.tracking_api_key_matches).toBe(false);

      await writeFile(
        source,
        `other.registerTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } });\nregisterTools([], { nested: { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } } });\n`,
      );
      const unrelatedTracking = await status({ workspace: path, apiBase: platform.base, store });
      expect(unrelatedTracking.registration_batches).toEqual([
        {
          path: "src/webmcp.ts",
          index: 1,
          tracking_api_key: false,
          tracking_api_key_matches: false,
          tracking_endpoint: false,
          tracking_endpoint_matches: true,
        },
      ]);
      expect(unrelatedTracking.tracking_api_key_present).toBe(false);
      expect(unrelatedTracking.tracking_api_key_matches).toBe(false);

      await writeFile(
        source,
        `registerTools([], { tracking: { ${TRACKING_KEY_FIELD}: "wmk_wrong" } });\n`,
      );
      const mismatched = await status({ workspace: path, apiBase: platform.base, store });
      expect(mismatched.tracking_api_key_matches).toBe(false);
      expect(mismatched.flags.key_mismatch).toBe(true);

      platform.revoke();
      const revoked = await status({ workspace: path, apiBase: platform.base, store });
      expect(revoked.online).toEqual({ checked: true, key_enabled: false });
      expect(revoked.flags.key_revoked).toBe(true);
    } finally {
      await platform.server.stop(true);
    }
  });

  test("checks every batch against the connected environment endpoint decision", async () => {
    const ingestUrl = "https://ingest-pr-332.pr.agentlane.dev/v1/collect";
    const platform = fakePlatform({ ingestUrl });
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const source = join(path, "src", "webmcp.ts");
    try {
      await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      await writeFile(
        source,
        `registerTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\nregisterTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } });\n`,
      );
      const missingEndpoint = await status({ workspace: path, apiBase: platform.base, store });
      expect(missingEndpoint.tracking_endpoint_matches).toBe(false);

      await writeFile(
        source,
        `registerTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\nregisterTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\n`,
      );
      const previewHealthy = await status({ workspace: path, apiBase: platform.base, store });
      expect(previewHealthy.tracking_endpoint_matches).toBe(true);
      expect(previewHealthy.entry_modules).toEqual([
        {
          path: "src/webmcp.ts",
          tracking_api_key: true,
          tracking_endpoint: true,
        },
      ]);

      platform.advertiseIngest();
      await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      const stalePreviewEndpoint = await status({
        workspace: path,
        apiBase: platform.base,
        store,
      });
      expect(stalePreviewEndpoint.tracking_endpoint_matches).toBe(false);

      await writeFile(
        source,
        `registerTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } });\nregisterTools([], { tracking: { ${TRACKING_KEY_FIELD}: "${PUBLIC_KEY}" } });\n`,
      );
      expect(
        (await status({ workspace: path, apiBase: platform.base, store }))
          .tracking_endpoint_matches,
      ).toBe(true);
    } finally {
      await platform.server.stop(true);
    }
  });

  test("missing state remains useful offline", async () => {
    const path = await workspace("not-connected");
    const result = await status({
      workspace: path,
      store: emptyStore,
    });
    expect(result.connect_file.present).toBe(false);
    expect(result.credentials.present).toBe(false);
    expect(result.online.checked).toBe(false);
    expect(result.flags).toEqual({
      already_connected: false,
      key_mismatch: false,
      key_revoked: false,
      another_session_may_be_running: false,
    });
  });
});

describe("webmcp connect advisory lock", () => {
  // `host` is part of the advisory: a pid only means something on the machine that
  // issued it, so a holder that names one without a matching host is not probeable.
  const lockHolder = (pid: number, startedAt = new Date().toISOString(), host = hostname()) =>
    `${JSON.stringify({ id: "other", pid, host, started_at: startedAt })}\n`;

  test("a run holding the lock keeps a second run out of the provisioning APIs", async () => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const insideDomains = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let gated = false;
    const slowFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/domains") && !gated) {
        gated = true;
        reached();
        await held;
      }
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    const options = {
      workspace: path,
      apiBase: platform.base,
      store,
      projectKey: "git:sha256:stable",
      retryDelayMs: 0,
    };
    try {
      const first = connect({ ...options, fetch: slowFetch });
      await insideDomains;
      await expect(connect(options)).rejects.toMatchObject({
        name: "CliError",
        code: "connect_in_progress",
      });
      release();
      expect((await first).status).toBe("connected");
      // The refused run never minted anything: one Domain, one key, one connect.json.
      expect(platform.counts()).toEqual({ domainPosts: 1, keyPosts: 1 });
      expect(await pathExists(connectLockPath(path))).toBe(false);
    } finally {
      release();
      await platform.server.stop(true);
    }
  });

  /** A well-formed advisory that names no pid — nothing to probe, so only age retires it. */
  const pidlessHolder = () => `${JSON.stringify({ id: "other", started_at: "2020-01-01" })}\n`;

  const staleCases: { name: string; holder: () => Promise<string>; ageMs: number }[] = [
    {
      name: "a pid-less holder older than the staleness window",
      holder: async () => pidlessHolder(),
      ageMs: CONNECT_LOCK_STALE_MS + 60_000,
    },
    {
      name: "unparseable content older than the staleness window",
      holder: async () => "stale advisory\n",
      ageMs: CONNECT_LOCK_STALE_MS + 60_000,
    },
    {
      name: "a fresh holder whose pid is gone",
      holder: async () => {
        const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
        const pid = child.pid;
        await child.exited;
        return lockHolder(pid);
      },
      ageMs: 0,
    },
    {
      // A `connect.lock` that reached this machine by any route other than a run on it
      // — committed to the repo, or restored from a backup — names a pid belonging to
      // whatever now holds that number here. `kill(pid, 0)` answers "alive" about a
      // stranger, forever, so without the host check the workspace answers
      // `connect_in_progress` in every clone and nothing can ever retire it.
      name: "an aged holder whose pid belongs to another machine",
      holder: async () => lockHolder(process.pid, "2020-01-01T00:00:00.000Z", "some-other-host"),
      ageMs: CONNECT_LOCK_STALE_MS + 60_000,
    },
    {
      // Belt and braces for the same failure when the host DOES match — a pid reused
      // after a reboot. Age alone cannot retire a live-looking holder inside the window
      // (OAuth consent legitimately sits there), but it must past the absolute ceiling.
      name: "a live-looking holder past the absolute age ceiling",
      holder: async () => lockHolder(process.pid, "2020-01-01T00:00:00.000Z"),
      ageMs: CONNECT_LOCK_MAX_AGE_MS + 60_000,
    },
  ];

  test.each(staleCases)("connect steals $name", async ({ holder, ageMs }) => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const lock = connectLockPath(path);
    try {
      await mkdir(dirname(lock), { recursive: true });
      await writeFile(lock, await holder());
      if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs);
        await utimes(lock, when, when);
      }

      const result = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(result.status).toBe("connected");
      expect(await pathExists(lock)).toBe(false);
      // The break mutex is released on the way out. Leaking it would wedge every LATER
      // stale advisory in this workspace, which is the one thing stale-breaking exists for.
      expect(await pathExists(`${lock}.break`)).toBe(false);
    } finally {
      await platform.server.stop(true);
    }
  });

  // Two runs can judge the SAME stale advisory before either acts on it, and the loser's
  // removal then lands on whatever the winner has since put there. A bare `rename` succeeds
  // against that file just as happily as against the one that was judged — so the loser
  // deleted the winner's LIVE lock and acquired beside it, which is the duplicate-Domain
  // race F15 closed. The window is microseconds wide and unreachable through `connect()`,
  // so the two halves of the claim are driven directly, in the losing order.
  test("a stale claim overtaken by a fresh holder refuses instead of deleting it", async () => {
    const path = await workspace();
    const lock = connectLockPath(path);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, pidlessHolder());
    const aged = new Date(Date.now() - (CONNECT_LOCK_STALE_MS + 60_000));
    await utimes(lock, aged, aged);

    const judged = await judgeStaleLock(lock);
    if (judged === null || judged === "gone") throw new Error("expected a stale candidate");

    // The winner steals that same advisory and acquires its own, all before the loser acts.
    await rm(lock);
    await writeFile(lock, lockHolder(process.pid));

    // Refusing is not enough on its own: a loser that empties the canonical path and only
    // then puts the mismatch back has still let a THIRD run's `open("wx")` acquire inside
    // that window, and the restore it was counting on now finds the name taken — so the
    // winner's advisory is deleted outright and two runs provision. The loser must not
    // touch the path at all, which is observable one directory up: `rename`, `link` and
    // `rm` each bump the parent's mtime, and nothing else here does.
    const parent = dirname(lock);
    const untouched = new Date(Date.now() - 3_600_000);
    await utimes(parent, untouched, untouched);

    expect(await claimStaleLock(lock, judged)).toBe(false);
    expect((await stat(parent)).mtimeMs).toBe(untouched.getTime());
    // The winner's advisory is still there, and still the winner's.
    expect(JSON.parse(await readFile(lock, "utf8")).id).toBe("other");
  });

  // Refusing on a mismatch is only load-bearing if the inode cannot change between the
  // pre-check and the `rename` — and two runs holding the SAME judgement are exactly what
  // changes it: the loser's `rename` moves the winner's LIVE advisory, a third run's
  // `open("wx")` takes the emptied name, the restore then finds it taken, and the winner's
  // advisory is deleted with both it and the third run inside `provision()`. That interleaving
  // is two syscalls wide and unreachable through `connect()`, so what is pinned is the mutex
  // that makes it unreachable at all: while one run is judging-and-claiming, no other run may.
  //
  // AGE is not a second answer here, which is why both rows expect the same outcome. Retiring
  // the mutex could only mean breaking a lock file, and breaking a lock file is the very gap
  // this mutex closes — with nothing underneath it, a loser that judged the orphan the winner
  // already retired moves the winner's LIVE guard aside and a third run walks into the emptied
  // name. So the mutex is broken at no age at all, and the cost of that choice is what the
  // message assertion pins: the operator is told the file is there.
  test.each([
    { name: "held by a live breaker", ageMs: 0 },
    { name: "orphaned by a hard kill hours ago", ageMs: 12 * 60 * 60_000 },
  ])("a stale advisory is left alone while a break mutex $name sits there", async ({ ageMs }) => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const lock = connectLockPath(path);
    try {
      await mkdir(dirname(lock), { recursive: true });
      await writeFile(lock, pidlessHolder());
      const aged = new Date(Date.now() - (CONNECT_LOCK_STALE_MS + 60_000));
      await utimes(lock, aged, aged);
      // Every staleness test above proves this advisory is stealable but for the mutex.
      const guardPath = `${lock}.break`;
      const guard = await open(guardPath, "wx", 0o600);
      await guard.close();
      if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs);
        await utimes(guardPath, when, when);
      }

      await expect(
        connect({
          workspace: path,
          apiBase: platform.base,
          store,
          projectKey: "git:sha256:stable",
          retryDelayMs: 0,
        }),
      ).rejects.toMatchObject({
        code: "connect_in_progress",
        // Nothing clears this file but a human, so the refusal has to name it: an operator
        // who deletes only the advisory gets refused again on the next stale one, told
        // nothing about why.
        message: expect.stringContaining(guardPath),
      });
      // Neither the advisory nor the mutex was touched, and nothing was minted.
      expect(JSON.parse(await readFile(lock, "utf8")).id).toBe("other");
      expect(await pathExists(guardPath)).toBe(true);
      expect(platform.counts()).toEqual({ domainPosts: 0, keyPosts: 0 });
    } finally {
      await platform.server.stop(true);
    }
  });

  // Each of these is a holder connect must NOT be able to prove abandoned. The
  // aged one is the load-bearing case: OAuth consent runs inside the lock, so a
  // human parked on the browser tab outlives the staleness window routinely, and
  // stealing the advisory there is the duplicate-Domain race F15 closed.
  const liveCases: { name: string; holder: () => string; ageMs: number }[] = [
    { name: "a fresh lock left by a live holder", holder: () => lockHolder(process.pid), ageMs: 0 },
    {
      name: "a live holder older than the staleness window",
      holder: () => lockHolder(process.pid, "2020-01-01T00:00:00.000Z"),
      ageMs: CONNECT_LOCK_STALE_MS + 60_000,
    },
    {
      // pid 1 exists and is not ours, so process.kill(1, 0) raises EPERM: a
      // holder we cannot probe is a holder we cannot call abandoned.
      name: "a holder whose liveness we are not permitted to probe",
      holder: () => lockHolder(1),
      ageMs: 0,
    },
    { name: "a pid-less holder inside the staleness window", holder: pidlessHolder, ageMs: 0 },
  ];

  test.each(liveCases)("connect refuses $name rather than stealing it", async ({
    holder,
    ageMs,
  }) => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    const lock = connectLockPath(path);
    try {
      await mkdir(dirname(lock), { recursive: true });
      await writeFile(lock, holder());
      if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs);
        await utimes(lock, when, when);
      }

      await expect(
        connect({
          workspace: path,
          apiBase: platform.base,
          store,
          projectKey: "git:sha256:stable",
          retryDelayMs: 0,
        }),
      ).rejects.toMatchObject({ code: "connect_in_progress" });
      // The refused run leaves the holder's own advisory intact.
      expect(JSON.parse(await readFile(lock, "utf8")).id).toBe("other");
      expect(platform.counts()).toEqual({ domainPosts: 0, keyPosts: 0 });
    } finally {
      await platform.server.stop(true);
    }
  });

  // The release lives in a `finally`, and every other assertion here is about the
  // happy path or a refusal that never acquired. Without this case the release
  // could move out of the `finally` unnoticed — and then a run that dies inside
  // the lock leaves `connect.lock` naming a LIVE pid (this process), so "re-running
  // Connect is the recovery path" becomes false until someone deletes the file.
  test("a run that fails inside the lock still releases it", async () => {
    const platform = fakePlatform();
    const path = await workspace();
    const store = await credentialsFor(platform.base);
    try {
      await expect(
        connect({
          workspace: path,
          apiBase: platform.base,
          store,
          projectKey: "git:sha256:stable",
          retryDelayMs: 0,
          fetch: async () => {
            throw new Error("network down mid-provision");
          },
        }),
      ).rejects.toThrow();
      expect(await pathExists(connectLockPath(path))).toBe(false);

      // …and the proof that the release is what made this possible: the retry
      // acquires cleanly and provisions.
      const result = await connect({
        workspace: path,
        apiBase: platform.base,
        store,
        projectKey: "git:sha256:stable",
        retryDelayMs: 0,
      });
      expect(result.status).toBe("connected");
    } finally {
      await platform.server.stop(true);
    }
  });
});
