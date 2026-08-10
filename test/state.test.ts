import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deletePendingTask, loadPendingTask, savePendingTask } from "../src/state.js";

test("pending task metadata round-trips in managed state", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexrun-state-test-"));
  const previous = process.env["CODEXRUN_HOME"];
  process.env["CODEXRUN_HOME"] = root;
  const taskId = randomUUID();
  try {
    await savePendingTask({
      taskId,
      threadId: "thread",
      workingDirectory: process.cwd(),
      createdAt: new Date().toISOString(),
      sandboxMode: "danger-full-access",
      networkAccess: true,
      noFollowup: false,
    });
    assert.equal(loadPendingTask(taskId).threadId, "thread");
    deletePendingTask(taskId);
    assert.throws(() => loadPendingTask(taskId), /No resumable task/);
  } finally {
    if (previous === undefined) delete process.env["CODEXRUN_HOME"];
    else process.env["CODEXRUN_HOME"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending tasks from the former CodexErrand state path remain resumable", () => {
  const root = mkdtempSync(join(tmpdir(), "codexrun-legacy-state-test-"));
  const currentRoot = join(root, "current");
  const legacyRoot = join(root, "legacy");
  const previousCurrent = process.env["CODEXRUN_HOME"];
  const previousLegacy = process.env["CODEXERRAND_HOME"];
  process.env["CODEXRUN_HOME"] = currentRoot;
  process.env["CODEXERRAND_HOME"] = legacyRoot;
  const taskId = randomUUID();
  const tasksDir = join(legacyRoot, "state", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${taskId}.json`),
    JSON.stringify({
      version: 1,
      taskId,
      threadId: "legacy-thread",
      workingDirectory: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sandboxMode: "danger-full-access",
      networkAccess: true,
      noFollowup: false,
    }),
  );
  try {
    assert.equal(loadPendingTask(taskId).threadId, "legacy-thread");
    deletePendingTask(taskId);
    assert.throws(() => loadPendingTask(taskId), /No resumable task/);
  } finally {
    if (previousCurrent === undefined) delete process.env["CODEXRUN_HOME"];
    else process.env["CODEXRUN_HOME"] = previousCurrent;
    if (previousLegacy === undefined) delete process.env["CODEXERRAND_HOME"];
    else process.env["CODEXERRAND_HOME"] = previousLegacy;
    rmSync(root, { recursive: true, force: true });
  }
});
