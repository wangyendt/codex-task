import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deletePendingTask, loadPendingTask, savePendingTask } from "../src/state.js";

test("pending task metadata round-trips in managed state", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexerrand-state-test-"));
  const previous = process.env["CODEXERRAND_HOME"];
  process.env["CODEXERRAND_HOME"] = root;
  const taskId = "00000000-0000-0000-0000-000000000001";
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
    if (previous === undefined) delete process.env["CODEXERRAND_HOME"];
    else process.env["CODEXERRAND_HOME"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
