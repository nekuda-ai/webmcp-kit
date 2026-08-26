import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  browserSearchPlan,
  browserVersionProbe,
  chromeForTestingSupported,
} from "../../cli/browser";

const pluginRoot = join(import.meta.dir, "..", "..");
const PACKAGE_EXPECTATION = [
  "exec",
  "--yes",
  "--package=chrome-devtools-mcp@latest",
  "--",
  "chrome-devtools",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o700);
}

function runCli(
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("the packaged entry starts @latest with the required safe WebMCP flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-cli-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "npm-argv.txt");
  const chrome = join(root, "chrome");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(
    join(bin, "npm"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\necho "driver started"\n',
  );
  await executable(chrome, "#!/bin/sh\necho 'Google Chrome for Testing 150.0.7871.0'\n");

  const { code, stdout, stderr } = runCli(
    [
      join(pluginRoot, "scripts", "webmcp.sh"),
      "browser",
      "start",
      "--executable-path",
      chrome,
    ],
    {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CAPTURE: capture,
        HOME: root,
      },
    },
  );

  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "driver started\n", stderr: "" });
  expect((await readFile(capture, "utf8")).trim().split("\n")).toEqual([
    "exec",
    "--yes",
    "--package=chrome-devtools-mcp@latest",
    "--",
    "chrome-devtools",
    "start",
    "--headless=true",
    "--isolated=true",
    "--category-experimental-webmcp=true",
    "--chrome-arg=--enable-features=WebMCP",
    "--performance-crux=false",
    "--usage-statistics=false",
    "--redact-network-headers=true",
    `--executable-path=${chrome}`,
    expect.stringMatching(/^--sessionId=[a-f0-9]{24}$/),
  ]);
});

test("start discovers a supported Chrome without a global browser CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-discovery-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "npm-argv.txt");
  const chrome = join(bin, "google-chrome");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(
    join(bin, "npm"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\necho "driver started"\n',
  );
  await executable(chrome, "#!/bin/sh\necho 'Google Chrome 151.0.7922.0'\n");

  const { code, stderr } = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start"], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      PLUGIN_ROOT: pluginRoot,
      CAPTURE: capture,
      HOME: root,
    },
  });

  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const args = (await readFile(capture, "utf8")).trim().split("\n");
  expect(args).toContain(`--executable-path=${chrome}`);
  expect(args.at(-1)).toMatch(/^--sessionId=[a-f0-9]{24}$/);
});

test.skipIf(!chromeForTestingSupported())(
  "start installs and reuses Chrome for Testing from the user cache when Chrome is absent",
  async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-install-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "npm-argv.txt");
  const installedChrome = join(root, "cache", "chrome", "stable", "chrome");
  const chromeSource = join(root, "chrome-source");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      'printf "CALL\\n" >> "$CAPTURE"',
      'printf "%s\\n" "$@" >> "$CAPTURE"',
      'case "$*" in',
      '  *"@puppeteer/browsers@latest"*)',
      '    mkdir -p "$(dirname "$INSTALLED_CHROME")"',
      '    cp "$CHROME_SOURCE" "$INSTALLED_CHROME"',
      '    chmod 700 "$INSTALLED_CHROME"',
      '    echo "$INSTALLED_CHROME"',
      "    ;;",
      '  *) echo "driver started" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await executable(chromeSource, "#!/bin/sh\necho 'Google Chrome for Testing 152.0.1.0'\n");

  const { code, stderr } = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start"], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CAPTURE: capture,
      HOME: root,
      WEBMCP_BROWSER_PATH: join(root, "missing-chrome"),
      WEBMCP_BROWSER_CACHE_DIR: join(root, "cache"),
      INSTALLED_CHROME: installedChrome,
      CHROME_SOURCE: chromeSource,
    },
  });
  const repeated = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start"], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CAPTURE: capture,
      HOME: root,
      WEBMCP_BROWSER_PATH: join(root, "missing-chrome"),
      WEBMCP_BROWSER_CACHE_DIR: join(root, "cache"),
      INSTALLED_CHROME: installedChrome,
      CHROME_SOURCE: chromeSource,
    },
  });
  const calls = await readFile(capture, "utf8");

  expect({ code, repeatedCode: repeated.code, stderr }).toEqual({ code: 0, repeatedCode: 0, stderr: "" });
  expect(calls).toContain("--package=@puppeteer/browsers@latest");
  expect(calls).toContain("chrome@stable");
  expect(calls).toContain(`--path=${join(root, "cache")}`);
  expect(calls).toContain(`--executable-path=${installedChrome}`);
  expect(calls.match(/--package=@puppeteer\/browsers@latest/g)).toHaveLength(1);
  },
);

test("Chrome for Testing support matches its published host platforms", () => {
  expect(chromeForTestingSupported("linux", "x64")).toBeTrue();
  expect(chromeForTestingSupported("linux", "arm64")).toBeFalse();
  expect(chromeForTestingSupported("darwin", "arm64")).toBeTrue();
  expect(chromeForTestingSupported("win32", "ia32")).toBeTrue();
  expect(chromeForTestingSupported("freebsd", "x64")).toBeFalse();
});

test.skipIf(chromeForTestingSupported())(
  "missing Chrome on an unsupported host fails before an incompatible download",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "webmcp-browser-unsupported-host-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const npmCalled = join(root, "npm-called");
    await mkdir(bin);
    await symlink(Bun.which("bun") as string, join(bin, "bun"));
    await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
    await executable(join(bin, "npm"), `#!/bin/sh\ntouch '${npmCalled}'\n`);

    const { code, stderr } = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start"], {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PLUGIN_ROOT: pluginRoot,
        HOME: root,
        WEBMCP_BROWSER_PATH: join(root, "missing-chrome"),
      },
    });

    expect(code).toBe(1);
    expect(stderr).toContain(
      `Chrome for Testing has no ${process.platform}/${process.arch} build`,
    );
    expect(stderr).toContain("set WEBMCP_BROWSER_PATH or pass --executable-path <path>");
    expect(existsSync(npmCalled)).toBeFalse();
  },
);

test("start clears a stale daemon and retries once", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-stale-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "npm-argv.txt");
  const attempts = join(root, "attempts.txt");
  const chrome = join(root, "chrome");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(chrome, "#!/bin/sh\necho 'Google Chrome 151.0.7922.0'\n");
  await executable(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$CAPTURE"',
      'case "$*" in',
      '  *"chrome-devtools start"*)',
      '    count=$(wc -l < "$ATTEMPTS" 2>/dev/null || echo 0)',
      '    echo x >> "$ATTEMPTS"',
      '    if [ "$count" -eq 0 ]; then echo "stale daemon PID file" >&2; exit 1; fi',
      '    echo "driver restarted"',
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );

  const { code, stdout, stderr } = runCli(
    [
      join(pluginRoot, "scripts", "webmcp.sh"),
      "browser",
      "start",
      "--executable-path",
      chrome,
    ],
    {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CAPTURE: capture,
        ATTEMPTS: attempts,
        HOME: root,
      },
    },
  );
  const calls = await readFile(capture, "utf8");

  expect(code).toBe(0);
  expect(stdout).toBe("driver restarted\n");
  expect(stderr).toContain("stale daemon state detected; stopped it and retried start once");
  expect(calls.match(/chrome-devtools start/g)).toHaveLength(2);
  expect(calls.match(/chrome-devtools stop/g)).toHaveLength(1);
});

test("explicit run scopes route commands to distinct upstream daemon sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-sessions-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');

  const outputs = ["a11ce", "b22ed"].map((sessionId) => {
      const { code, stdout } = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "status"], {
        cwd: root,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          PLUGIN_ROOT: pluginRoot,
          HOME: root,
          WEBMCP_BROWSER_SESSION_ID: sessionId,
        },
      });
      return { code, args: stdout.trim().split("\n") };
    });

  expect(outputs.map((output) => output.code)).toEqual([0, 0]);
  expect(outputs.map((output) => output.args.slice(0, -1))).toEqual([
    [...PACKAGE_EXPECTATION, "status"],
    [...PACKAGE_EXPECTATION, "status"],
  ]);
  const sessionArgs = outputs.map((output) => output.args.at(-1) as string);
  expect(sessionArgs[0]).toMatch(/^--sessionId=[a-f0-9]{24}$/);
  expect(sessionArgs[1]).toMatch(/^--sessionId=[a-f0-9]{24}$/);
  expect(sessionArgs[0]).not.toBe(sessionArgs[1]);
});

test.each([
  ["missing Node.js", null, false, "Node.js is required"],
  ["incompatible Node.js", "v22.11.0", false, "Node.js v22.11.0 is incompatible"],
  ["missing npm", "v22.22.2", false, "npm is required"],
] as const)("status reports %s with an actionable error", async (_, nodeVersion, withNpm, message) => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-runtime-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await symlink("/bin/sh", join(bin, "sh"));
  if (nodeVersion) await executable(join(bin, "node"), `#!/bin/sh\necho '${nodeVersion}'\n`);
  if (withNpm) await executable(join(bin, "npm"), "#!/bin/sh\nexit 0\n");

  const { code, stderr } = runCli(
    [join(pluginRoot, "scripts", "webmcp.sh"), "browser", "status"],
    {
      cwd: root,
      env: { PATH: bin, PLUGIN_ROOT: pluginRoot, HOME: root },
    },
  );

  expect(code).not.toBe(0);
  expect(stderr).toContain(message);
});

test.skipIf(!chromeForTestingSupported())(
  "a Chrome for Testing download failure preserves the actionable cause",
  async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-download-failure-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(join(bin, "npm"), "#!/bin/sh\necho 'registry unavailable' >&2\nexit 42\n");

  const { code, stderr } = runCli([join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start"], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      PLUGIN_ROOT: pluginRoot,
      HOME: root,
      WEBMCP_BROWSER_PATH: join(root, "missing-chrome"),
      WEBMCP_BROWSER_CACHE_DIR: join(root, "cache"),
    },
  });

  expect(code).toBe(1);
  expect(stderr).toContain("Chrome for Testing download failed. Check network access and retry.");
  expect(stderr).toContain("registry unavailable");
  },
);

test("a browser launch failure is returned without claiming verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-launch-failure-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const chrome = join(root, "chrome");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(
    join(bin, "npm"),
    "#!/bin/sh\necho 'error while loading shared libraries: libX11.so' >&2\nexit 17\n",
  );
  await executable(chrome, "#!/bin/sh\necho 'Google Chrome 151.0.7922.0'\n");

  const { code, stderr } = runCli(
    [join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start", "--executable-path", chrome],
    {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: pluginRoot, HOME: root },
    },
  );

  expect(code).toBe(17);
  expect(stderr).toContain("error while loading shared libraries: libX11.so");
  expect(stderr).not.toContain("stale daemon state detected");
});

test("an executable for the wrong host architecture is an actionable browser error", async () => {
  const root = await mkdtemp(join(tmpdir(), "webmcp-browser-wrong-arch-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const chrome = join(root, "wrong-architecture-chrome");
  await mkdir(bin);
  await symlink(Bun.which("bun") as string, join(bin, "bun"));
  await executable(join(bin, "node"), "#!/bin/sh\necho v22.22.2\n");
  await executable(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  await executable(chrome, "not an executable for this host\n");

  const { code, stderr } = runCli(
    [join(pluginRoot, "scripts", "webmcp.sh"), "browser", "start", "--executable-path", chrome],
    {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, PLUGIN_ROOT: pluginRoot, HOME: root },
    },
  );

  expect(code).toBe(1);
  expect(stderr).toContain(`${chrome} is not a supported executable`);
  expect(stderr).not.toContain("plugin/cli/browser.ts");
});

test("macOS and Windows discovery use their native installed and cache locations", () => {
  expect(browserSearchPlan("darwin", { HOME: "/Users/agent" })).toEqual({
    cache: "/Users/agent/Library/Caches/webmcp-kit/chrome-for-testing",
    names: ["google-chrome", "google-chrome-stable"],
    fixed: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/agent/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
  });
  expect(
    browserSearchPlan("win32", {
      USERPROFILE: "C:\\Users\\agent",
      LOCALAPPDATA: "C:\\Users\\agent\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    }),
  ).toEqual({
    cache: "C:\\Users\\agent\\AppData\\Local\\webmcp-kit\\chrome-for-testing",
    names: ["chrome.exe"],
    fixed: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\agent\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ],
  });
});

test("Windows reads Chrome's file version through PowerShell without launching Chrome", () => {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  expect(browserVersionProbe(chrome, "win32", "C:\\Windows\\System32\\powershell.exe")).toEqual({
    command: "C:\\Windows\\System32\\powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Item -LiteralPath $env:WEBMCP_BROWSER_PROBE_PATH).VersionInfo.ProductVersion",
    ],
    env: { WEBMCP_BROWSER_PROBE_PATH: chrome },
  });
  expect(browserVersionProbe("/usr/bin/chromium", "linux", undefined)).toEqual({
    command: "/usr/bin/chromium",
    args: ["--version"],
  });
});
