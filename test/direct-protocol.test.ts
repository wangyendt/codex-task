import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectRequest, type DirectRequestContext } from "../src/backends/direct/protocol.js";
import type { ResolvedDirectModel } from "../src/backends/direct/models.js";

const context: DirectRequestContext = {
  accessToken: "secret",
  accountId: "account",
  identity: {
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
