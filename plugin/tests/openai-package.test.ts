import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("the OpenAI skills bundle carries every runtime path its instructions invoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-openai-package-"));
  temporaryDirectories.push(root);
  const output = join(root, "webmcp-kit.zip");

  const built = await command(["python3", "scripts/package-openai-skills.py", "--output", output]);
  expect(built).toEqual({ code: 0, stdout: `${output}\n`, stderr: "" });

  const inspect = [
    "import json, sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    "  texts = {name: archive.read(name).decode('utf-8') for name in archive.namelist() if name.endswith(('.md', '.sh', '.cmd'))}",
    "  modes = {item.filename: item.external_attr >> 16 for item in archive.infolist()}",
    "  print(json.dumps({'names': archive.namelist(), 'texts': texts, 'modes': modes, 'manifest': json.loads(archive.read('webmcp-kit/.codex-plugin/plugin.json'))}))",
  ].join("\n");
  const inspected = await command(["python3", "-c", inspect, output]);
  expect(inspected.code).toBe(0);
  expect(inspected.stderr).toBe("");

  const archive = JSON.parse(inspected.stdout) as {
    names: string[];
    texts: Record<string, string>;
    modes: Record<string, number>;
    manifest: Record<string, unknown>;
  };
  const names = new Set(archive.names);
  expect(names).toContain("webmcp-kit/scripts/webmcp.sh");
  expect(names).toContain("webmcp-kit/scripts/webmcp.cmd");
  expect(names).toContain("webmcp-kit/cli/webmcp.ts");
  expect(names).toContain("webmcp-kit/cli/browser.ts");
  expect(archive.modes["webmcp-kit/scripts/webmcp.sh"]! & 0o111).not.toBe(0);
  expect(archive.manifest.hooks).toBeUndefined();
  expect(names).not.toContain("webmcp-kit/com.openai/hooks/hooks.json");

  const references = new Set<string>();
  const patterns = [
    /\$\{plugin_root\}\/([A-Za-z0-9._/-]+)/g,
    /Join-Path\s+\$pluginRoot\s+"([^"]+)"/g,
    /%plugin_root%\\([A-Za-z0-9._\\/-]+)/g,
  ];
  for (const source of Object.values(archive.texts)) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern))
        references.add(match[1]!.replaceAll("\\", "/"));
    }
  }
  expect([...references].sort()).toEqual([
    "cli/webmcp.ts",
    "scripts/webmcp.cmd",
    "scripts/webmcp.sh",
  ]);
  for (const reference of references) expect(names).toContain(`webmcp-kit/${reference}`);
});
