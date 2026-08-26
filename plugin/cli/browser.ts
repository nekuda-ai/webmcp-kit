#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";

type Output = { code: number; stdout: string; stderr: string };

const PACKAGE_ARGS = [
  "exec",
  "--yes",
  "--package=chrome-devtools-mcp@latest",
  "--",
  "chrome-devtools",
] as const;

const START_FLAGS = [
  "--headless=true",
  "--isolated=true",
  "--category-experimental-webmcp=true",
  "--chrome-arg=--enable-features=WebMCP",
  "--performance-crux=false",
  "--usage-statistics=false",
  "--redact-network-headers=true",
] as const;

async function run(
  command: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<Output> {
  try {
    const child = Bun.spawn([command, ...args], {
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 126, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function executablePath(args: string[]): string | undefined {
  const equals = args.find((arg) => arg.startsWith("--executable-path="));
  if (equals) return equals.slice("--executable-path=".length);
  const index = args.indexOf("--executable-path");
  return index >= 0 ? args[index + 1] : undefined;
}

function browserSessionId(): string {
  const scope =
    process.env.WEBMCP_BROWSER_SESSION_ID ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CODEX_THREAD_ID ??
    process.env.CODEX_SESSION_ID ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.env.CODEX_WORKSPACE_ROOT ??
    process.env.PWD ??
    process.cwd();
  return createHash("sha256").update(scope).digest("hex").slice(0, 24);
}

function nodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
}

function browserSupported(version: string): boolean {
  const major =
    /(?:Chrome|Chromium)(?: for Testing)?\s+(\d+)/i.exec(version)?.[1] ??
    /^\s*(\d+)\./.exec(version)?.[1];
  return Number(major) >= 150;
}

export function browserVersionProbe(
  path: string,
  platform = process.platform,
  powershell =
    Bun.which("powershell.exe") ??
    Bun.which("pwsh.exe") ??
    Bun.which("powershell") ??
    Bun.which("pwsh"),
): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  if (platform !== "win32") return { command: path, args: ["--version"] };
  if (!powershell) return undefined;
  return {
    command: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Item -LiteralPath $env:WEBMCP_BROWSER_PROBE_PATH).VersionInfo.ProductVersion",
    ],
    env: { WEBMCP_BROWSER_PROBE_PATH: path },
  };
}

async function probeBrowser(path: string): Promise<Output> {
  const probe = browserVersionProbe(path);
  if (!probe) {
    return {
      code: 127,
      stdout: "",
      stderr: "PowerShell is required to inspect Chrome's file version without launching it.",
    };
  }
  return run(probe.command, probe.args, probe.env);
}

function installerNodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  return major >= 23 || (major === 22 && Number(match[2]) >= 12);
}

export function chromeForTestingSupported(
  platform = process.platform,
  arch = process.arch,
): boolean {
  if (platform === "linux") return arch === "x64";
  if (platform === "darwin") return arch === "x64" || arch === "arm64";
  if (platform === "win32") return arch === "x64" || arch === "ia32";
  return false;
}

export function browserSearchPlan(
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { cache: string; names: string[]; fixed: string[] } {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  if (platform === "win32") {
    const path = win32.join;
    return {
      cache: path(env.LOCALAPPDATA ?? home, "webmcp-kit", "chrome-for-testing"),
      names: ["chrome.exe"],
      fixed: [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
        .filter((root): root is string => !!root)
        .map((root) => path(root, "Google", "Chrome", "Application", "chrome.exe")),
    };
  }
  if (platform === "darwin") {
    return {
      cache: join(home, "Library", "Caches", "webmcp-kit", "chrome-for-testing"),
      names: ["google-chrome", "google-chrome-stable"],
      fixed: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      ],
    };
  }
  return {
    cache: join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "webmcp-kit", "chrome-for-testing"),
    names: ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"],
    fixed: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  };
}

function browserCache(): string {
  return process.env.WEBMCP_BROWSER_CACHE_DIR ?? browserSearchPlan().cache;
}

function cachedBrowserPaths(root: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...cachedBrowserPaths(path, depth + 1));
    else if (["chrome", "chrome.exe", "Google Chrome for Testing"].includes(entry.name)) paths.push(path);
  }
  return paths;
}

function installedBrowserPaths(): string[] {
  const configured = [process.env.WEBMCP_BROWSER_PATH, process.env.CHROME_PATH].filter(
    (value): value is string => Boolean(value),
  );
  const { names, fixed } = browserSearchPlan();
  const cached = cachedBrowserPaths(browserCache());
  // An explicit path opts out of ambient system Chrome, but the managed cache remains reusable.
  if (configured.length > 0) return [...configured, ...cached];
  return [
    ...cached,
    ...names.map((name) => Bun.which(name)).filter((path): path is string => !!path),
    ...fixed.filter(existsSync),
  ];
}

async function discoverBrowser(): Promise<string | undefined> {
  for (const path of installedBrowserPaths()) {
    const version = await probeBrowser(path);
    if (version.code === 0 && browserSupported(version.stdout)) return path;
  }
  return undefined;
}

async function installBrowser(npm: string, nodeVersion: string): Promise<string | undefined> {
  if (!chromeForTestingSupported()) {
    await fail(
      `Chrome is missing and Chrome for Testing has no ${process.platform}/${process.arch} build. Install Chrome or Chromium 150+ for this host, then set WEBMCP_BROWSER_PATH or pass --executable-path <path>.`,
    );
    return undefined;
  }
  if (!installerNodeSupported(nodeVersion)) {
    await fail(
      `Chrome is missing and @puppeteer/browsers@latest requires Node 22.12+; current ${nodeVersion.trim()}.`,
    );
    return undefined;
  }
  const cache = browserCache();
  const result = await run(npm, [
    "exec",
    "--yes",
    "--package=@puppeteer/browsers@latest",
    "--",
    "browsers",
    "install",
    "chrome@stable",
    `--path=${cache}`,
    "--format={{path}}",
  ]);
  if (result.code !== 0) {
    await fail("Chrome for Testing download failed. Check network access and retry.", result.stderr || result.stdout);
    return undefined;
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
}

async function fail(message: string, detail = ""): Promise<number> {
  process.stderr.write(`webmcp browser: ${message}${detail ? `\n${detail.trim()}\n` : "\n"}`);
  return 1;
}

export async function browserMain(args: string[]): Promise<number> {
  const node = Bun.which("node");
  if (!node) return fail("Node.js is required. Install a supported Node.js release, then retry.");
  const nodeVersion = await run(node, ["--version"]);
  if (nodeVersion.code !== 0 || !nodeSupported(nodeVersion.stdout)) {
    return fail(
      `Node.js ${nodeVersion.stdout.trim() || "version unknown"} is incompatible; chrome-devtools-mcp requires Node 20.19+, 22.12+, or 23+.`,
    );
  }
  const npm = Bun.which("npm");
  if (!npm) return fail("npm is required to resolve chrome-devtools-mcp@latest. Install npm, then retry.");
  if (args.some((arg) => arg === "--sessionId" || arg.startsWith("--sessionId="))) {
    return fail("Use WEBMCP_BROWSER_SESSION_ID instead of passing the upstream --sessionId flag.");
  }
  const sessionId = browserSessionId();

  const command = args[0];
  if (command === "start") {
    const explicit = executablePath(args.slice(1));
    const path = explicit ?? (await discoverBrowser()) ?? (await installBrowser(npm, nodeVersion.stdout));
    if (!path) return 1;
    const version = await probeBrowser(path);
    if (version.code !== 0 || !browserSupported(version.stdout)) {
      return fail(`Chrome 150+ is required; ${path} is not a supported executable.`, version.stderr);
    }
    const startArgs = [
      ...PACKAGE_ARGS,
      "start",
      ...START_FLAGS,
      `--executable-path=${path}`,
      `--sessionId=${sessionId}`,
    ];
    let result = await run(npm, startArgs);
    if (result.code !== 0 && /(?:stale|daemon|socket|pid)/i.test(result.stderr)) {
      const stopped = await run(npm, [...PACKAGE_ARGS, "stop", `--sessionId=${sessionId}`]);
      if (stopped.code === 0) {
        process.stderr.write(
          "webmcp browser: stale daemon state detected; stopped it and retried start once.\n",
        );
        result = await run(npm, startArgs);
      } else {
        result.stderr = `${result.stderr}${stopped.stderr}`;
      }
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }

  const result = await run(npm, [...PACKAGE_ARGS, ...args, `--sessionId=${sessionId}`]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}
