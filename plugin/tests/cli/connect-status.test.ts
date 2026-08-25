import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, connectFilePath, connectLockPath, readConnectFile } from "../../cli/connect";
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
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

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
    refresh_token: "fake-refresh-token",
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
      expect(savedText).not.toContain("fake-refresh-token");
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
      await writeFile(
        source,
        `const label = "tools 🛠";\n// tracking: { apiKey: "comment-is-not-a-fact" }\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}", otel: true } });\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\n`,
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
        `registerTools([], { tracking: { otel: true } });\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\n`,
      );
      const missingBatch = await status({ workspace: path, apiBase: platform.base, store });
      expect(missingBatch.tracking_api_key_present).toBe(false);
      expect(missingBatch.tracking_api_key_matches).toBe(false);

      await writeFile(
        source,
        `other.registerTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\nregisterTools([], { nested: { tracking: { apiKey: "${PUBLIC_KEY}" } } });\n`,
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

      await writeFile(source, 'registerTools([], { tracking: { apiKey: "wmk_wrong" } });\n');
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
        `registerTools([], { tracking: { apiKey: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\n`,
      );
      const missingEndpoint = await status({ workspace: path, apiBase: platform.base, store });
      expect(missingEndpoint.tracking_endpoint_matches).toBe(false);

      await writeFile(
        source,
        `registerTools([], { tracking: { apiKey: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}", endpoint: "${ingestUrl}" } });\n`,
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
        `registerTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\nregisterTools([], { tracking: { apiKey: "${PUBLIC_KEY}" } });\n`,
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
