import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { appPaths } from "./paths.js";
import { atomicWrite, ensureDir, withFileLock } from "./fs-utils.js";
import { CodexErrandError } from "./errors.js";
import { loadConfig } from "./config.js";
import type { GcReport, ReasoningEffort, SandboxMode } from "./types.js";

export interface StoredTask {
  version: 1;
  taskId: string;
  threadId: string;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sandboxMode: SandboxMode;
  networkAccess: boolean;
  model?: string | undefined;
  reasoning?: ReasoningEffort | undefined;
  noFollowup: boolean;
}

function taskPath(taskId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
    throw new CodexErrandError("INVALID_TASK_ID", `Invalid task id: ${taskId}`, { exitCode: 2 });
  }
  return join(appPaths().tasksDir, `${taskId}.json`);
}

export async function savePendingTask(task: Omit<StoredTask, "version" | "updatedAt" | "expiresAt">): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const record: StoredTask = {
    ...task,
    version: 1,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.pendingTaskTtlMs).toISOString(),
  };
  const path = taskPath(task.taskId);
  await withFileLock(`${path}.lock`, async () => atomicWrite(path, JSON.stringify(record, null, 2)));
}

export function loadPendingTask(taskId: string): StoredTask {
  const path = taskPath(taskId);
  if (!existsSync(path)) {
    throw new CodexErrandError("TASK_NOT_FOUND", `No resumable task found for ${taskId}`, {
      exitCode: 2,
    });
  }
  let record: StoredTask;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as StoredTask;
  } catch (error) {
    throw new CodexErrandError("TASK_STATE_INVALID", `Could not parse task state for ${taskId}`, {
      exitCode: 2,
      cause: error,
    });
  }
  if (record.version !== 1 || record.taskId !== taskId || !record.threadId) {
    throw new CodexErrandError("TASK_STATE_INVALID", `Task state for ${taskId} is invalid`, {
      exitCode: 2,
    });
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    deletePendingTask(taskId);
    throw new CodexErrandError("TASK_EXPIRED", `Task ${taskId} has expired`, { exitCode: 2 });
  }
  return record;
}

export function deletePendingTask(taskId: string): void {
  rmSync(taskPath(taskId), { force: true });
}

interface SizedPath {
  path: string;
  bytes: number;
  mtimeMs: number;
}

function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

function isInside(path: string, root: string): boolean {
  const absolute = resolve(path);
  const absoluteRoot = resolve(root);
  return absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${sep}`);
}

function removeManagedPath(path: string, root: string): number {
  if (!isInside(path, root) || resolve(path) === resolve(root)) {
    throw new CodexErrandError("GC_PATH_REJECTED", `Refusing to remove unmanaged path: ${path}`);
  }
  const bytes = existsSync(path) ? directorySize(path) : 0;
  rmSync(path, { recursive: true, force: true });
  return bytes;
}

export function runGarbageCollection(now = Date.now()): GcReport {
  const config = loadConfig();
  const paths = appPaths();
  const report: GcReport = { removedPaths: 0, reclaimedBytes: 0, warnings: [] };

  ensureDir(paths.tempDir);
  ensureDir(paths.tasksDir);

  for (const entry of readdirSync(paths.tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(paths.tasksDir, entry.name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { expiresAt?: string };
      if (!record.expiresAt || Date.parse(record.expiresAt) <= now) {
        rmSync(path, { force: true });
        report.removedPaths += 1;
      }
    } catch (error) {
      report.warnings.push(`Could not inspect ${path}: ${String(error)}`);
    }
  }

  const tempEntries: SizedPath[] = [];
  for (const entry of readdirSync(paths.tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(paths.tempDir, entry.name);
    try {
      const stat = statSync(path);
      tempEntries.push({ path, bytes: directorySize(path), mtimeMs: stat.mtimeMs });
    } catch (error) {
      report.warnings.push(`Could not inspect ${path}: ${String(error)}`);
    }
  }

  for (const entry of tempEntries.filter((item) => now - item.mtimeMs > config.tempTtlMs)) {
    report.reclaimedBytes += removeManagedPath(entry.path, paths.tempDir);
    report.removedPaths += 1;
  }

  const remaining = tempEntries
    .filter((entry) => existsSync(entry.path))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = remaining.reduce((total, entry) => total + entry.bytes, 0);
  for (const entry of remaining) {
    if (totalBytes <= config.tempMaxBytes) break;
    report.reclaimedBytes += removeManagedPath(entry.path, paths.tempDir);
    report.removedPaths += 1;
    totalBytes -= entry.bytes;
  }

  return report;
}
