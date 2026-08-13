import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDirectRequest,
  type DirectRequestContext,
  type DirectRequestSpec,
} from "../src/backends/direct/protocol.js";
import type { ResolvedDirectModel } from "../src/backends/direct/models.js";

const context: DirectRequestContext = {
  accessToken: "secret",
  accountId: "account",
  identity: {
    tls: { label: "chrome150", ja3: "chrome150", akamai: "chrome119" },
    installationId: "install",
    codexVersion: "0.147.0",
    osType: "macOS",
    osVersion: "15.0",
    arch: "aarch64",
  },
  sessionId: "session",
  threadId: "thread",
};

function model(useResponsesLite: boolean): ResolvedDirectModel {
  return {
    model: useResponsesLite ? "gpt-5.6-sol" : "gpt-5.5",
    useResponsesLite,
    reasoning: "medium",
    supportedReasoning: ["medium", "high"],
    source: "explicit",
  };
}

test("classic request uses top-level instructions and tools", () => {
  const request = buildDirectRequest(context, { kind: "text", prompt: "hello", model: model(false) });
  assert.equal(request.headers["x-openai-internal-codex-responses-lite"], undefined);
  assert.equal(typeof request.body["instructions"], "string");
  assert.deepEqual(request.body["tools"], []);
  const input = request.body["input"] as Array<Record<string, unknown>>;
  assert.equal(input[0]?.["role"], "user");
});

test("lite request prefixes additional_tools and developer instructions", () => {
  const request = buildDirectRequest(context, { kind: "text", prompt: "hello", model: model(true) });
  assert.equal(request.headers["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(request.body["instructions"], "");
  assert.equal("tools" in request.body, false);
  const input = request.body["input"] as Array<Record<string, unknown>>;
  assert.equal(input[0]?.["type"], "additional_tools");
  assert.equal(input[1]?.["role"], "developer");
  assert.equal((request.body["reasoning"] as Record<string, unknown>)["context"], "all_turns");
});

test("text request sends local images as multimodal input", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-protocol-test-"));
  const image = join(root, "meal.png");
  try {
    writeFileSync(image, "image-bytes");
    const spec = {
      kind: "text",
      prompt: "Extract foods and calories as JSON.",
      imagePaths: [image],
      model: model(true),
    } as DirectRequestSpec;
    const request = buildDirectRequest(context, spec);
    const input = request.body["input"] as Array<Record<string, unknown>>;
    const userMessage = input.find((item) => item["role"] === "user");
    const content = userMessage?.["content"] as Array<Record<string, unknown>>;
    assert.deepEqual(content.map((item) => item["type"]), ["input_text", "input_image"]);
    assert.equal(content[1]?.["image_url"], `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
