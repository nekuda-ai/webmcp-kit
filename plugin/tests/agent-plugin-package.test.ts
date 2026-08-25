import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pluginRoot = join(import.meta.dir, "..");

test("the Codex manifest ships the hooks and the root Agent Plugins manifest stays out", () => {
  const codex = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const claude = JSON.parse(
    readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const marketplace = JSON.parse(
    readFileSync(join(pluginRoot, "..", ".claude-plugin", "marketplace.json"), "utf8"),
  );
  const codexMarketplace = JSON.parse(
    readFileSync(join(pluginRoot, "..", ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  const marketplaceEntry = marketplace.plugins.find(
    (entry: { name?: string }) => entry.name === "webmcp-kit",
  );
  const codexMarketplaceEntry = codexMarketplace.plugins.find(
    (entry: { name?: string }) => entry.name === "webmcp-kit",
  );

  expect(codex.name).toBe("webmcp-kit");
  expect(codex.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(codex.version).toBe(claude.version);
  expect(codex.version).toBe(marketplaceEntry?.version);
  expect(codex.version).toBe(codexMarketplaceEntry?.version);
  expect(codex.homepage).toBe("https://github.com/nekuda-ai/webmcp-kit");
  expect(codex.license).toBe("MIT");
  expect(codex.skills).toBe("./skills/");
  expect(codex.hooks).toBe("./com.openai/hooks/hooks.json");
  expect(codexMarketplaceEntry?.source).toEqual({ source: "local", path: "./plugin" });
  expect(existsSync(join(pluginRoot, "com.openai", "hooks", "hooks.json"))).toBe(true);
  // ADR-0018 / NEK-779: a root plugin.json wins Codex's manifest discovery and
  // released hosts discard its hooks — its presence would silence the plugin.
  expect(existsSync(join(pluginRoot, "plugin.json"))).toBe(false);
});

test("Codex hooks use focused tool matchers and plugin-scoped paths", () => {
  const config = JSON.parse(
    readFileSync(join(pluginRoot, "com.openai", "hooks", "hooks.json"), "utf8"),
  );
  const preTool = config.hooks.PreToolUse[0];
  const stop = config.hooks.Stop[0];

  expect(preTool.matcher).not.toBe("*");
  expect(preTool.matcher).toContain("Bash");
  expect(preTool.matcher).toContain("apply_patch");
  expect(preTool.hooks[0].command).toContain("${PLUGIN_ROOT}/com.openai/hooks/");
  expect(preTool.hooks[0].command).toContain("command -v bun");
  expect(preTool.hooks[0].commandWindows).toContain("%PLUGIN_ROOT%\\com.openai\\hooks\\");
  expect(preTool.hooks[0].commandWindows).toContain("where bun");
  expect(preTool.hooks[0].additionalContextLimit).toBe(0);
  expect(stop.matcher).toBeUndefined();
  expect(stop.hooks[0].command).toContain("${PLUGIN_ROOT}/com.openai/hooks/");
  expect(stop.hooks[0].commandWindows).toContain("%PLUGIN_ROOT%\\com.openai\\hooks\\");

  const hook = readFileSync(
    join(pluginRoot, "com.openai", "hooks", "webmcp-feedback.ts"),
    "utf8",
  );
  expect(hook).toContain("process.env.PLUGIN_DATA");
  expect(existsSync(join(pluginRoot, "com.openai", "hooks", "webmcp_feedback.py"))).toBe(false);
});

test("the Unix hook command is a quiet no-op when Bun is unavailable", async () => {
  const config = JSON.parse(
    readFileSync(join(pluginRoot, "com.openai", "hooks", "hooks.json"), "utf8"),
  );
  const command = config.hooks.PreToolUse[0].hooks[0].command as string;
  const process = Bun.spawn(["/bin/sh", "-c", command], {
    env: { PATH: "/webmcp-test-no-bun", PLUGIN_ROOT: pluginRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

test("skill CLI calls resolve through the installed plugin entry", () => {
  const skills = join(pluginRoot, "skills");
  const connect = readFileSync(join(skills, "implement", "references", "connect.md"), "utf8");
  const entry = readFileSync(join(pluginRoot, "scripts", "webmcp.sh"), "utf8");

  expect(connect).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh"');
  expect(connect).toContain('"${PLUGIN_ROOT}/scripts/webmcp.sh"');
  expect(entry).toContain("CLAUDE_PLUGIN_ROOT");
  expect(entry).toContain("PLUGIN_ROOT");
  expect(entry).not.toContain("WEBMCP_CLI_TEST_WRAPPER");
  for (const path of markdownFiles(skills)) {
    expect(readFileSync(path, "utf8")).not.toMatch(/\bwebmcp\s+(?:login|connect|status)\b/);
  }
});

test("Connect reconciles the key and environment endpoint across every entry batch", () => {
  const connect = readFileSync(
    join(pluginRoot, "skills", "implement", "references", "connect.md"),
    "utf8",
  );

  expect(connect).toContain("Set `WEBMCP_API_BASE` to the environment's API; everything else follows.");
  expect(connect).toContain("defaults to `https://api.agentlane.com`");
  expect(connect).toContain("in the agent conversation for a human chat-only run");
  expect(connect).toContain("In every existing `registerTools` batch");
  expect(connect).toContain('tracking: { apiKey: "<api_key.value>", endpoint: "<ingest_url>" }');
  expect(connect).toContain("Otherwise remove any existing `tracking.endpoint`");
  expect(connect).toContain("never retain a stale endpoint");
  expect(connect).toContain("`tracking_endpoint_matches: true`");
});

test.each([
  ["Claude Code", { CLAUDE_PLUGIN_ROOT: pluginRoot, PLUGIN_ROOT: "/wrong-plugin-root" }],
  ["Codex", { CLAUDE_PLUGIN_ROOT: "", PLUGIN_ROOT: pluginRoot }],
])("the CLI entry runs --help through Bun from a scratch directory for %s", async (_, roots) => {
  const scratch = mkdtempSync(join(tmpdir(), "webmcp-plugin-entry-"));
  try {
    const child = Bun.spawn([join(pluginRoot, "scripts", "webmcp.sh"), "--help"], {
      cwd: scratch,
      env: { ...process.env, ...roots },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage:\n  webmcp login [--json]");
    expect(stderr).toBe("");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the CLI entry gives the exact Bun install fix when Bun is unavailable", async () => {
  const process = Bun.spawn(["/bin/sh", join(pluginRoot, "scripts", "webmcp.sh"), "--help"], {
    env: { PATH: "/webmcp-test-no-bun", PLUGIN_ROOT: pluginRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect({ code, stdout, stderr }).toEqual({
    code: 127,
    stdout: "",
    stderr: "webmcp: Bun is required. Install Bun, then retry.\n",
  });
});
