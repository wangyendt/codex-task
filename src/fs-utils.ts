import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexTaskError } from "./errors.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, data, { mode });
  renameSync(tempPath, path);
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  ensureDir(dirname(lockPath));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const startedAt = Date.now();
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {
        // Another process may have released it.
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new CodexTaskError("LOCK_TIMEOUT", `Timed out waiting for ${lockPath}`, {
          retryable: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort.
    }
  }
}
