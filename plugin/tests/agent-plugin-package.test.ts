import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
