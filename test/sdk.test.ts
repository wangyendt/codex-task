import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { runSdkTurn } from "../src/backends/sdk.js";

async function* events(): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: "thread-1" };
  yield { type: "turn.started" };
  yield {
    type: "item.completed",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "ok",
      exit_code: 0,
      status: "completed",
    },
  };
  yield {
    type: "item.completed",
    item: {
      id: "change-1",
      type: "file_change",
      changes: [{ path: "src/index.ts", kind: "update" }],
      status: "completed",
    },
  };
  yield {
    type: "item.completed",
    item: {
      id: "message-1",
      type: "agent_message",
      text: JSON.stringify({
        status: "needs_input",
        text: "Need one choice",
        questions: ["Keep compatibility?"],
        artifacts: [],
      }),
    },
  };
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 1,
    },
  };
}

test("runSdkTurn maps structured follow-up and execution summary", async () => {
  let receivedOptions: ThreadOptions | undefined;
  const fakeThread = {
    id: "thread-1",
    runStreamed: async () => ({ events: events() }),
  };
  const result = await runSdkTurn({
    taskId: "task-1",
    prompt: "task",
    workingDirectory: process.cwd(),
    sandboxMode: "danger-full-access",
    networkAccess: true,
    noFollowup: false,
    timeoutMs: 1000,
    codex: {
      startThread: (options) => {
        receivedOptions = options;
        return fakeThread;
      },
      resumeThread: () => fakeThread,
    },
  });
  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.questions, ["Keep compatibility?"]);
  assert.deepEqual(result.changes, ["src/index.ts"]);
  assert.equal(result.commands[0]?.exitCode, 0);
  assert.equal(receivedOptions?.sandboxMode, "danger-full-access");
  assert.equal(receivedOptions?.networkAccessEnabled, true);
});

test("runSdkTurn rejects needs_input when noFollowup is enabled", async () => {
  const fakeThread = { id: "thread-1", runStreamed: async () => ({ events: events() }) };
  await assert.rejects(
    runSdkTurn({
      taskId: "task-1",
      prompt: "task",
      workingDirectory: process.cwd(),
      sandboxMode: "danger-full-access",
      networkAccess: true,
      noFollowup: true,
      timeoutMs: 1000,
      codex: { startThread: () => fakeThread, resumeThread: () => fakeThread },
    }),
    /no-followup/,
  );
});

test("runSdkTurn preserves raw output for a caller-provided schema", async () => {
  async function* rawEvents(): AsyncGenerator<ThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-2" };
    yield {
      type: "item.completed",
      item: { id: "message-2", type: "agent_message", text: '{"headline":"Ready"}' },
    };
  }
  const fakeThread = { id: "thread-2", runStreamed: async () => ({ events: rawEvents() }) };
  const result = await runSdkTurn({
    taskId: "task-2",
    prompt: "write a headline",
    workingDirectory: process.cwd(),
    sandboxMode: "danger-full-access",
    networkAccess: true,
    noFollowup: true,
    timeoutMs: 1000,
    outputSchema: { type: "object" },
    structuredResponse: false,
    codex: { startThread: () => fakeThread, resumeThread: () => fakeThread },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, '{"headline":"Ready"}');
});
