import assert from "node:assert/strict";
import test from "node:test";
import { mapDirectHttpError } from "../src/backends/direct/index.js";
import { parseDirectResponse } from "../src/backends/direct/sse.js";

const selection = { model: "gpt-6.1-sol", reasoning: "ultra" };
const body = JSON.stringify({ error: { message: "Invalid value: 'ultra'. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.", code: "invalid_value", param: "reasoning.effort" } });
test("upstream reasoning refusal identifies the requested combination and never retries", () => {
  const error = mapDirectHttpError(400, body, selection);
  assert.equal(error.code, "DIRECT_UNSUPPORTED_REASONING");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { ...selection, upstreamCode: "invalid_value", upstreamParam: "reasoning.effort", supportedReasoning: ["none", "low", "medium", "high", "xhigh", "max"] });
});
test("main, drawing and image-tool combination rejections remain distinct", () => {
  for (const [param, message, expected] of [
    ["model", "Model does not exist", "DIRECT_UNSUPPORTED_MODEL"],
    ["tools[0].model", "Invalid model", "DIRECT_UNSUPPORTED_IMAGE_MODEL"],
    ["tools", "image_generation is not supported by this model", "DIRECT_UNSUPPORTED_IMAGE_COMBINATION"],
  ]) {
    assert.equal(mapDirectHttpError(400, JSON.stringify({ error: { param, message } }), selection).code, expected);
  }
});
test("unrelated parameter, auth, quota and moderation failures are not unsupported combinations", () => {
  assert.equal(mapDirectHttpError(400, JSON.stringify({error:{message:"Invalid value: size",param:"tools[0].size"}}), selection).code, "DIRECT_REQUEST_REJECTED");
  assert.equal(mapDirectHttpError(401, body, selection).code, "DIRECT_AUTH_FAILED");
  assert.equal(mapDirectHttpError(429, body, selection).code, "DIRECT_RATE_LIMITED");
  assert.equal(mapDirectHttpError(503, body, selection).code, "DIRECT_SERVER_ERROR");
  assert.equal(mapDirectHttpError(400, JSON.stringify({error:{message:"Content moderation blocked this request",code:"content_policy_violation"}}), selection).code,"DIRECT_REQUEST_REJECTED");
});
test("SSE-level selection refusal uses the same structured error code", () => {
  const error = JSON.parse(body) as { error: Record<string, unknown> };
  const stream = `data: ${JSON.stringify({type:"response.failed",response:{error:error.error}})}\n\n`;
  assert.throws(() => parseDirectResponse(stream), { code: "DIRECT_UNSUPPORTED_REASONING" });
});
