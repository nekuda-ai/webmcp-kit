import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AtomicWriteOptions = {
  /** Permissions for the file; private by default, since the CLI's files are the user's. */
  mode?: number;
  /** When set, the containing directory is created with — and forced to — this mode. */
  directoryMode?: number;
};

/**
 * Writes `contents` so no reader can ever observe a half-written file: a private
 * temp file beside the destination is filled, fsynced and then renamed over it.
 * A crash mid-write leaves the previous file intact rather than truncated, and
 * `rename` is atomic within a directory, so the name always points at a complete
 * document. The mode is applied on every write — `writeFile`'s own `mode` only
 * takes effect for a file it creates, so a permissive leftover would survive.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  await mkdir(directory, {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });
  if (options.directoryMode !== undefined) await chmod(directory, options.directoryMode);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    // umask can clear bits `open` was asked for; the rename then carries this
    // inode — and its mode — to the destination name.
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
