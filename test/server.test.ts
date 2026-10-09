import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCodexTaskServer } from "../src/server.js";
import { appPaths } from "../src/paths.js";
import type { TaskRequest } from "../src/types.js";

const TOKEN = "test-service-token";

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

test("service refuses a non-loopback listener without a bearer token", async () => {
  await assert.rejects(async () => {
    const server = await startCodexTaskServer({ host: "0.0.0.0", port: 0 });
    await server.close();
  }, /non-loopback listener requires a Service Token/);
});

test("service startup removes expired remote upload directories left by a crash", async () => {
  const stale = join(appPaths().tempDir, "server", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(stale, old, old);
  const server = await startCodexTaskServer({ host: "127.0.0.1", port: 0, jobTtlMs: 1_000 });
  try {
    assert.equal(existsSync(stale), false);
  } finally {
    await server.close();
    rmSync(stale, { recursive: true, force: true });
  }
});

test("remote client can inspect health but needs a bearer token for task APIs", async () => {
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    run: async () => {
      throw new Error("runner must not be called");
    },
  });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "codex-task" });

    const unauthorized = await fetch(`${server.url}/v1/jobs/missing`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: { code: "UNAUTHORIZED", message: "A valid Bearer token is required" },
    });
  } finally {
    await server.close();
  }
});

test("scoped Service Token can submit only its allowed task kinds", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-task-token-server-"));
  const created = JSON.parse(execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "token", "create", "--name", "iphone-text", "--allow", "text"],
    { encoding: "utf8", env: { ...process.env, CODEX_TASK_HOME: home } },
  )) as { token: string };
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    tokenRegistryPath: join(home, "config", "service", "tokens.json"),
    readModels: async () => ({ source: "codex-app-server", updatedAt: null, stale: false, models: [{ id: "test", displayName: "Test", reasoningLevels: ["high"], defaultReasoning: "high", inputModalities: ["text"] }] }),
    run: async (request) => ({
      status: "completed",
      taskId: "11111111-1111-4111-8111-111111111111",
      backend: request.kind === "task" || request.kind === "resume" ? "sdk" : "direct",
      text: request.kind,
      artifacts: [],
    }),
  });
  const scopedHeaders = {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  };
  try {
    assert.equal((await fetch(`${server.url}/v1/models`, { headers: scopedHeaders })).status, 200);
    const textResponse = await fetch(`${server.url}/v1/text`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ prompt: "Summarize this" }),
    });
    assert.equal(textResponse.status, 202);

    const sdkResponse = await fetch(`${server.url}/v1/text`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ prompt: "Try SDK", backend: "sdk" }),
    });
    assert.equal(sdkResponse.status, 403);
    assert.deepEqual(await sdkResponse.json(), {
      error: { code: "FORBIDDEN", message: "Scoped Service Tokens allow Direct requests only" },
    });

    for (const [path, kind] of [
      ["/v1/image", "image"],
      ["/v1/task", "task"],
      ["/v1/tasks/11111111-1111-4111-8111-111111111111/resume", "resume"],
    ] as const) {
      const response = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ prompt: "Not allowed" }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: { code: "FORBIDDEN", message: `Service Token does not allow ${kind} requests` },
      });
    }

    const adminResponse = await fetch(`${server.url}/v1/image`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "Admin remains allowed" }),
    });
    assert.equal(adminResponse.status, 202);
    const adminReceipt = await adminResponse.json() as { statusUrl: string };
    const forbiddenCancel = await fetch(`${server.url}${adminReceipt.statusUrl}/cancel`, {
      method: "POST",
      headers: scopedHeaders,
    });
    assert.equal(forbiddenCancel.status, 403);
    assert.deepEqual(await forbiddenCancel.json(), {
      error: { code: "FORBIDDEN", message: "Service Token does not allow image requests" },
    });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote image job accepts named prompt files and images, then serves its artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-server-test-"));
  const output = join(root, "generated.png");
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    run: async (request) => {
      if (request.kind !== "image") throw new Error("expected image request");
      const inputPath = request.options.imagePaths?.[0];
      const validInput =
        request.options.prompt?.includes("BEGIN PROMPT FILE: diet.md") === true &&
        inputPath !== undefined &&
        existsSync(inputPath) &&
        readFileSync(inputPath).equals(Buffer.from("input-image"));
      writeFileSync(output, Buffer.from("generated-image"));
      return {
        status: "completed",
        taskId: "22222222-2222-4222-8222-222222222222",
        backend: "direct",
        text: validInput ? "input-ok" : "input-invalid",
        artifacts: [{ path: output, kind: "image", mimeType: "image/png", sizeBytes: 15 }],
      };
    },
  });
  try {
    const submitted = await fetch(`${server.url}/v1/image`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "Make it higher protein",
        promptFiles: [{ name: "diet.md", content: "Keep carbohydrates low" }],
        images: [{ name: "meal.png", mimeType: "image/png", dataBase64: Buffer.from("input-image").toString("base64") }],
      }),
    });
    assert.equal(submitted.status, 202);
    const receipt = (await submitted.json()) as { jobId: string; statusUrl: string };
    let snapshot: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${server.url}${receipt.statusUrl}`, { headers: authHeaders() });
      snapshot = (await response.json()) as Record<string, unknown>;
      if (snapshot["status"] === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = snapshot["result"] as Record<string, unknown>;
    assert.equal(result["text"], "input-ok");
    const artifact = (result["artifacts"] as Array<Record<string, unknown>>)[0];
    assert.equal(artifact?.["downloadUrl"], `/v1/jobs/${receipt.jobId}/artifacts/0`);
    assert.equal(artifact?.["path"], undefined);

    const downloaded = await fetch(`${server.url}${String(artifact?.["downloadUrl"])}`, { headers: authHeaders() });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), "generated-image");

    const uploadRoot = join(appPaths().tempDir, "server", receipt.jobId);
    for (let attempt = 0; attempt < 20 && existsSync(uploadRoot); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(uploadRoot), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote client submits text work and polls the asynchronous result", async () => {
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    run: async (request) => ({
      status: "completed",
      taskId: "11111111-1111-4111-8111-111111111111",
      backend: request.kind === "task" || request.kind === "resume" ? "sdk" : request.options.backend ?? "direct",
      text: request.kind === "text"
        ? `received: ${request.options.prompt}; images=${request.options.imagePaths?.length ?? 0}`
        : "wrong kind",
      artifacts: [],
    }),
  });
  try {
    const submitted = await fetch(`${server.url}/v1/text`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "Analyze this meal",
        promptFiles: [{ name: "goal.md", content: "Return concise JSON" }],
        images: [{ name: "meal.png", mimeType: "image/png", dataBase64: Buffer.from("meal").toString("base64") }],
        backend: "direct",
      }),
    });
    assert.equal(submitted.status, 202);
    const receipt = (await submitted.json()) as { jobId: string; status: string; statusUrl: string };
    assert.match(receipt.jobId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.statusUrl, `/v1/jobs/${receipt.jobId}`);

    let snapshot: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${server.url}${receipt.statusUrl}`, { headers: authHeaders() });
      assert.equal(response.status, 200);
      snapshot = (await response.json()) as Record<string, unknown>;
      if (snapshot["status"] === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(snapshot["status"], "completed");
    assert.match(String((snapshot["result"] as Record<string, unknown>)["text"]), /BEGIN PROMPT FILE: goal\.md/);
    assert.match(String((snapshot["result"] as Record<string, unknown>)["text"]), /images=1/);
  } finally {
    await server.close();
  }
});

test("remote client submits workspace work and resumes needs_input with new multimodal context", async () => {
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    run: async (request) => {
      if (request.kind === "task") {
        return {
          status: "needs_input",
          taskId: "33333333-3333-4333-8333-333333333333",
          threadId: "thread-333",
          backend: "sdk",
          text: "Need serving size",
          questions: ["One or two servings?"],
          artifacts: [],
        };
      }
      if (request.kind === "resume") {
        const imageExists = request.options.imagePaths?.[0] ? existsSync(request.options.imagePaths[0]) : false;
        return {
          status: "completed",
          taskId: request.options.taskId,
          backend: "sdk",
          text: imageExists ? `resumed: ${request.options.answer}` : "missing image",
          artifacts: [],
        };
      }
      throw new Error("unexpected request kind");
    },
  });
  try {
    const submitted = await fetch(`${server.url}/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "Build the meal page", workingDirectory: "/srv/meal-app" }),
    });
    assert.equal(submitted.status, 202);
    const taskReceipt = (await submitted.json()) as { statusUrl: string };
    let taskSnapshot: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      taskSnapshot = (await (await fetch(`${server.url}${taskReceipt.statusUrl}`, { headers: authHeaders() })).json()) as Record<string, unknown>;
      if (taskSnapshot["status"] === "needs_input") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const taskResult = taskSnapshot["result"] as Record<string, unknown>;
    assert.deepEqual(taskResult["questions"], ["One or two servings?"]);

    const resumed = await fetch(`${server.url}/v1/tasks/${String(taskResult["taskId"])}/resume`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "Use one serving",
        promptFiles: [{ name: "copy.md", content: "Keep labels concise" }],
        images: [{ name: "layout.png", mimeType: "image/png", dataBase64: Buffer.from("layout").toString("base64") }],
      }),
    });
    assert.equal(resumed.status, 202);
    const resumeReceipt = (await resumed.json()) as { statusUrl: string };
    let resumeSnapshot: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      resumeSnapshot = (await (await fetch(`${server.url}${resumeReceipt.statusUrl}`, { headers: authHeaders() })).json()) as Record<string, unknown>;
      if (resumeSnapshot["status"] === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const resumeResult = resumeSnapshot["result"] as Record<string, unknown>;
    assert.match(String(resumeResult["text"]), /Use one serving/);
    assert.match(String(resumeResult["text"]), /BEGIN PROMPT FILE: copy\.md/);
  } finally {
    await server.close();
  }
});

test("service keeps excess remote jobs queued until a worker slot is available", async () => {
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    maxConcurrency: 1,
    run: async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return {
        status: "completed",
        taskId: `${String(calls).padStart(8, "0")}-0000-4000-8000-000000000000`,
        backend: "direct",
        artifacts: [],
      };
    },
  });
  try {
    const submit = async (prompt: string): Promise<{ statusUrl: string }> => {
      const response = await fetch(`${server.url}/v1/text`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
      });
      return await response.json() as { statusUrl: string };
    };
    const first = await submit("first");
    const second = await submit("second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondBeforeRelease = await (await fetch(`${server.url}${second.statusUrl}`, { headers: authHeaders() })).json() as { status: string };
    assert.equal(calls, 1);
    assert.equal(secondBeforeRelease.status, "queued");

    releaseFirst?.();
    for (let attempt = 0; attempt < 20 && calls < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, 2);
    const firstAfterRelease = await (await fetch(`${server.url}${first.statusUrl}`, { headers: authHeaders() })).json() as { status: string };
    assert.equal(firstAfterRelease.status, "completed");
  } finally {
    releaseFirst?.();
    await server.close();
  }
});

test("service cancels a queued remote job without starting it", async () => {
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    maxConcurrency: 1,
    run: async () => {
      calls += 1;
      await firstGate;
      return {
        status: "completed",
        taskId: "11111111-1111-4111-8111-111111111111",
        backend: "direct",
        artifacts: [],
      };
    },
  });
  try {
    const submit = async (prompt: string): Promise<{ statusUrl: string }> => {
      const response = await fetch(`${server.url}/v1/text`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
      });
      return await response.json() as { statusUrl: string };
    };
    await submit("occupy the only worker");
    const queued = await submit("cancel me before I start");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelled = await fetch(`${server.url}${queued.statusUrl}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    assert.equal(cancelled.status, 200);
    const snapshot = await cancelled.json() as Record<string, unknown>;
    assert.equal(snapshot["status"], "cancelled");
    assert.equal((snapshot["result"] as Record<string, unknown>)["status"], "cancelled");
    assert.equal(
      ((snapshot["result"] as Record<string, unknown>)["error"] as Record<string, unknown>)["code"],
      "CANCELLED",
    );

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
  } finally {
    releaseFirst?.();
    await server.close();
  }
});

test("service aborts a running remote job and keeps its terminal status cancelled", async () => {
  let receivedSignal: AbortSignal | undefined;
  const server = await startCodexTaskServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    run: async (request) => {
      receivedSignal = request.options.signal;
      await new Promise<void>((resolve) => {
        request.options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "completed",
        taskId: "22222222-2222-4222-8222-222222222222",
        backend: "direct",
        artifacts: [],
      };
    },
  });
  try {
    const submitted = await fetch(`${server.url}/v1/image`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "cancel while generating" }),
    });
    const receipt = await submitted.json() as { statusUrl: string };
    for (let attempt = 0; attempt < 20 && !receivedSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancelled = await fetch(`${server.url}${receipt.statusUrl}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(receivedSignal?.aborted, true);
    const snapshot = await cancelled.json() as Record<string, unknown>;
    assert.equal(snapshot["status"], "cancelled");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterRunnerSettled = await fetch(`${server.url}${receipt.statusUrl}`, { headers: authHeaders() });
    assert.equal((await afterRunnerSettled.json() as Record<string, unknown>)["status"], "cancelled");
  } finally {
    await server.close();
  }
});

for (const endpoint of ["/v1/text", "/v1/image", "/v1/task", "/v1/tasks/11111111-1111-4111-8111-111111111111/resume"]) {
  test(`${endpoint} forwards more than five images in upload order`, async () => {
    const server = await startCodexTaskServer({
      host: "127.0.0.1", port: 0, token: TOKEN,
      run: async (request) => {
        const paths = request.options.imagePaths ?? [];
        assert.equal(paths.length, 12);
        assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")),
          Array.from({ length: 12 }, (_, index) => `frame-${index}`));
        return {
          status: "completed", taskId: "11111111-1111-4111-8111-111111111111",
          backend: request.kind === "task" || request.kind === "resume" ? "sdk" : "direct",
          text: "all-12-inputs-received", artifacts: [],
        };
      },
    });
    try {
      const submitted = await fetch(`${server.url}${endpoint}`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({
          prompt: "Use every frame", images: Array.from({ length: 12 }, (_, index) => ({
            mimeType: "image/png", dataBase64: Buffer.from(`frame-${index}`).toString("base64"),
          })),
        }),
      });
      assert.equal(submitted.status, 202);
      const receipt = await submitted.json() as { statusUrl: string };
      let snapshot: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 20; attempt += 1) {
        snapshot = await (await fetch(`${server.url}${receipt.statusUrl}`, { headers: authHeaders() })).json() as Record<string, unknown>;
        if (snapshot["status"] === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(snapshot["status"], "completed");
      assert.equal((snapshot["result"] as Record<string, unknown>)["text"], "all-12-inputs-received");
    } finally {
      await server.close();
    }
  });
}

test("model catalog requires authentication and supports refresh without creating tasks", async () => {
  const catalog = { source: "codex-app-server" as const, updatedAt: "2026-10-05T00:00:00Z", stale: false, models: [{ id: "future", displayName: "Future", reasoningLevels: ["high"], defaultReasoning: "high", inputModalities: ["text"] }] };
  const refreshes: boolean[] = [];
  const server = await startCodexTaskServer({ host: "127.0.0.1", port: 0, token: TOKEN,
    readModels: async (refresh) => { refreshes.push(refresh ?? false); return catalog; },
    run: async () => { throw new Error("must not run tasks"); },
  });
  try {
    assert.equal((await fetch(`${server.url}/v1/models`)).status, 401);
    assert.equal(refreshes.length, 0);
    for (const path of ["/v1/models", "/v1/models?refresh=true"]) {
      const res = await fetch(`${server.url}${path}`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body, catalog);
    }
    assert.deepEqual(refreshes, [false, true]);
  } finally { await server.close(); }
});

test("model catalog returns 503 when no metadata is available", async () => {
  const server = await startCodexTaskServer({ host: "127.0.0.1", port: 0, token: TOKEN,
    readModels: async () => ({ source: "codex-model-cache", updatedAt: null, stale: true, models: [] }),
  });
  try { assert.equal((await fetch(`${server.url}/v1/models`, { headers: authHeaders() })).status, 503); }
  finally { await server.close(); }
});

test("image HTTP options preserve main model/reasoning and optional tool model independently", async () => {
  const received: TaskRequest[] = [];
  const server = await startCodexTaskServer({
    host: "127.0.0.1", port: 0, token: TOKEN,
    run: async request => {
      received.push(request);
      return { status: "completed", taskId: "11111111-1111-4111-8111-111111111111", backend: "direct", artifacts: [] };
    },
  });
  const submit = (body: Record<string, unknown>): Promise<Response> => fetch(`${server.url}/v1/image`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  });
  try {
    const response = await submit({ prompt: "a circle", backend: "direct", model: "gpt-5.6-sol", reasoning: "ultra", imageModel: "gpt-image-future" });
    assert.equal(response.status, 202);
    assert.equal(received.length, 1);
    const request = received[0]!;
    assert.equal(request.kind, "image");
    if (request.kind !== "image") throw new Error("expected image request");
    assert.equal(request.options.model, "gpt-5.6-sol");
    assert.equal(request.options.reasoning, "ultra");
    assert.equal(request.options.imageModel, "gpt-image-future");
    for (const imageModel of [null, 42, {}, "", "a b"]) {
      const rejected = await submit({ prompt: "a circle", imageModel });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { error: { code: string } }).error.code, "INVALID_IMAGE_MODEL");
    }
    const sdk = await submit({ prompt: "a circle", backend: "sdk", imageModel: "gpt-image-future" });
    assert.equal(sdk.status, 400);
    assert.equal((await sdk.json() as { error: { code: string } }).error.code, "IMAGE_MODEL_REQUIRES_DIRECT");
    assert.equal(received.length, 1);
    const automatic = await submit({ prompt: "a circle", model: "gpt-6.1-sol", reasoning: "low" });
    assert.equal(automatic.status, 202);
    const automaticRequest = received[1]!;
    if (automaticRequest.kind !== "image") throw new Error("expected image request");
    assert.equal(automaticRequest.options.imageModel, undefined);
  } finally { await server.close(); }
});
