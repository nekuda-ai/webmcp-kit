import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../cli/atomic-write";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "webmcp-atomic-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("writeFileAtomic", () => {
  test("creates the file and any missing directory with the requested modes", async () => {
    const root = await scratch();
    const directory = join(root, "nested", ".webmcp");
    const path = join(directory, "connect.json");

    await writeFileAtomic(path, '{"ok":true}\n', { mode: 0o600, directoryMode: 0o700 });

    expect(await readFile(path, "utf8")).toBe('{"ok":true}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  // The whole point of the idiom: the destination name is re-pointed at a
  // finished file rather than truncated in place, so a reader holding the old
  // file cannot observe a half-written document. A descriptor opened before the
  // write keeps the previous inode, and that is only true of a rename.
  test("replaces the destination by rename, so a reader never observes a partial file", async () => {
    const root = await scratch();
    const path = join(root, "connect.json");
    await writeFile(path, "previous\n");
    const held = await open(path, "r");

    try {
      await writeFileAtomic(path, "replacement\n");

      expect(await readFile(path, "utf8")).toBe("replacement\n");
      expect(await held.readFile("utf8")).toBe("previous\n");
    } finally {
      await held.close();
    }
  });

  test("tightens the mode of a file that already existed permissively", async () => {
    const root = await scratch();
    const path = join(root, "connect.json");
    await writeFile(path, "previous\n", { mode: 0o644 });
    await chmod(path, 0o644);

    await writeFileAtomic(path, "replacement\n", { mode: 0o600 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("leaves no temporary file behind, including when the write fails", async () => {
    const root = await scratch();
    const path = join(root, "connect.json");
    await writeFileAtomic(path, "first\n");
    expect((await readdir(root)).sort()).toEqual(["connect.json"]);

    // A destination that is a directory fails at the rename, i.e. after the
    // temp file exists — the one window where a leftover could survive.
    const blocked = join(root, "blocked");
    await writeFileAtomic(join(blocked, "keep.json"), "keep\n");
    await expect(writeFileAtomic(blocked, "clobber\n")).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual(["blocked", "connect.json"]);
    expect(await readFile(join(blocked, "keep.json"), "utf8")).toBe("keep\n");
  });
});
