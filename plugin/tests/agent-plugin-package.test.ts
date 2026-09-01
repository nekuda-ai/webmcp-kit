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
  const implementVerify = readFileSync(
    join(skills, "implement", "references", "verify.md"),
    "utf8",
  );
  const verify = readFileSync(join(skills, "verify", "SKILL.md"), "utf8");
  const entry = readFileSync(join(pluginRoot, "scripts", "webmcp.sh"), "utf8");
  const windowsEntry = readFileSync(join(pluginRoot, "scripts", "webmcp.cmd"), "utf8");

  expect(connect).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/webmcp.sh"');
  expect(connect).toContain('"${PLUGIN_ROOT}/scripts/webmcp.sh"');
  expect(entry).toContain("CLAUDE_PLUGIN_ROOT");
  expect(entry).toContain("PLUGIN_ROOT");
  expect(entry).not.toContain("WEBMCP_CLI_TEST_WRAPPER");
  expect(windowsEntry).toContain("%CLAUDE_PLUGIN_ROOT%");
  expect(windowsEntry).toContain("%PLUGIN_ROOT%");
  expect(windowsEntry).toContain("%plugin_root%\\cli\\webmcp.ts");
  for (const instructions of [verify, implementVerify]) {
    expect(instructions).toContain('plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"');
    expect(instructions).toContain('skill_dir="<absolute base directory for this skill>"');
    expect(instructions).toContain('plugin_root="$(cd "$skill_dir/../.." && pwd -P)"');
    expect(instructions).toContain('webmcp="${plugin_root}/scripts/webmcp.sh"');
    expect(instructions).toContain('"$webmcp" browser');
    expect(instructions).toContain("$env:CLAUDE_PLUGIN_ROOT");
    expect(instructions).toContain("$env:PLUGIN_ROOT");
    expect(instructions).toContain("Resolve-Path");
    expect(instructions).toContain("scripts\\webmcp.cmd");
    expect(instructions).not.toContain("scripts\\\\webmcp.cmd");
    expect(instructions).not.toMatch(
      /"\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}\/scripts\/webmcp\.sh" browser (?:status|start)/,
    );
    expect(instructions).toContain("chrome-devtools-mcp@latest");
    expect(instructions).toContain("--category-experimental-webmcp");
    expect(instructions).toContain("--enable-features=WebMCP");
    expect(instructions).not.toContain("tool-agnostic");
    expect(instructions).not.toContain("guided manual");
  }
  for (const command of [
    "status",
    "start",
    "new_page",
    "list_webmcp_tools",
    "execute_webmcp_tool",
    "take_snapshot",
    "list_console_messages",
    "list_network_requests",
    "stop",
  ]) {
    expect(verify).toContain(`browser ${command}`);
  }
  for (const path of markdownFiles(skills)) {
    expect(readFileSync(path, "utf8")).not.toMatch(/\bwebmcp\s+(?:login|connect|status)\b/);
  }
});

// skill.json is the hand-maintained discovery list copied to the public repo root on
// release; nothing else enumerates the skills, because both host manifests discover
// plugin/skills/ by directory. So a skill added to the tree is listed everywhere the
// hosts look and nowhere the indexers look — it installs and runs, and the release is
// silent about it. This is the check that makes the two agree.
test("every skill in the tree is listed in the discovery manifest", () => {
  const skillsDir = join(pluginRoot, "skills");
  const listed = JSON.parse(readFileSync(join(pluginRoot, "skill.json"), "utf8")) as {
    skills: { id: string; path: string; description: string }[];
  };
  const onDisk = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

  expect(onDisk.length).toBeGreaterThan(0);
  expect(listed.skills.map((skill) => skill.id).sort()).toEqual(onDisk);
  for (const skill of listed.skills) {
    expect(skill.path).toBe(`skills/${skill.id}/SKILL.md`);
    expect(existsSync(join(pluginRoot, skill.path))).toBe(true);
    expect(skill.description.length).toBeGreaterThan(0);
  }
});

// plugin/AGENTS.md is released bytes: sync-to-public copies it to the public repo ROOT,
// where GitHub and the skill indexers read it as the plugin's front door. It enumerates
// the skills in prose, and prose does not fail to compile — the "Two skills:" line
// survived a third skill landing in the tree, so the one file an indexer reads first was
// the one describing a plugin that no longer existed. Same equality as the manifest check
// above, against the sentence a human reads.
test("the released agent-facing doc names every skill in the tree", () => {
  const doc = readFileSync(join(pluginRoot, "AGENTS.md"), "utf8");
  const skillsDir = join(pluginRoot, "skills");
  const onDisk = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name);

  expect(onDisk.length).toBeGreaterThan(0);
  for (const id of onDisk) {
    expect(doc).toContain(`\`${id}\``);
  }
  // The count word is part of the claim: naming all three under "Two skills" reads as a
  // list with one skill bolted on rather than as the plugin's actual surface. Read the
  // word the doc actually uses rather than asserting one built from a lookup table — past
  // the table's end that assertion demands the literal "undefined skills:", failing with
  // a message that names nothing on the exact event it was written for: a skill landing.
  const counts = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
  const stated = doc.match(/\*\*(\w+) skills:\*\*/)?.[1];
  expect({ word: stated, skills: onDisk.length }).toEqual({
    word: counts[onDisk.length] ?? String(onDisk.length),
    skills: onDisk.length,
  });
});

// The derivation in stable-keys.md is a rule plus a table of worked examples, and the
// table is what a reader copies. An example that does not survive the rule it illustrates
// — or that the SDK's own `stableKey` pattern would reject — teaches a key the SDK throws
// on at module load. Re-derive every documented row from the documented algorithm.
test("every worked stableKey example follows the derivation and the SDK pattern", () => {
  const stableKeys = readFileSync(
    join(pluginRoot, "skills", "connect-existing-tools", "references", "stable-keys.md"),
    "utf8",
  );
  const sdkPattern = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
  const derive = (wireName: string) =>
    `adopted.${wireName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`;

  const rows = [...stableKeys.matchAll(/^\| `([^`]+)` \| `(adopted\.[^`]+)` \|$/gm)].map(
    (row) => ({ wireName: row[1]!, documented: row[2]! }),
  );

  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const { wireName, documented } of rows) {
    expect({ wireName, key: documented }).toEqual({ wireName, key: derive(wireName) });
    expect(documented).toMatch(sdkPattern);
  }
});

// Four decisions this skill exists to carry, each losable by an edit that still reads
// well. They are pinned where they are stated, not where they are summarized.
test.each([
  [
    "detection.md",
    // Detection labels; it never licenses a rewrite. The recognizer list is deliberately
    // generous only because that separation holds.
    ["never authorizes a rewrite", "**list** tools, never execute them", "runtime-unverified"],
  ],
  [
    "inventory.md",
    // A baseline re-derived from the migrated tree checks the tree against itself.
    ["never re-derived", "registered: false", "verbatim"],
  ],
  [
    "migration.md",
    // The SDK defaults `name` to `stableKey`, so an omitted `name` renames every tool.
    ["EXPLICIT", "One batch per registration scope", "never guess"],
  ],
  [
    "stable-keys.md",
    ["cannot be guaranteed in all cases", "Never re-derive", "immutable"],
  ],
  [
    "verify-connection.md",
    // Configuration and readiness are checks on this machine; only the runtime part
    // observes what a visitor's browser does.
    ['not "a request was sent"', "no rejection message", "at most once per page load"],
  ],
])("%s keeps the decision it carries", (file, phrases) => {
  const body = readFileSync(
    join(pluginRoot, "skills", "connect-existing-tools", "references", file),
    "utf8",
  );
  for (const phrase of phrases) expect(body).toContain(phrase);
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
