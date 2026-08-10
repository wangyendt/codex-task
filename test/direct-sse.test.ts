import assert from "node:assert/strict";
import test from "node:test";
import { parseDirectResponse, parseSse } from "../src/backends/direct/sse.js";

test("parseDirectResponse extracts final text and usage", () => {
  const stream = [
    'data: {"type":"response.output_text.delta","delta":"hel"}',
    'data: {"type":"response.output_text.done","text":"hello"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}',
    "data: [DONE]",
  ].join("\n\n");
  const result = parseDirectResponse(stream);
  assert.equal(result.text, "hello");
  assert.equal(result.usage?.inputTokens, 4);
});

test("parseDirectResponse extracts final image", () => {
  const base64 = Buffer.from("image").toString("base64");
  const stream = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${base64}","size":"1024x1024"}}\n`;
  const result = parseDirectResponse(stream);
  assert.equal(result.image?.toString("utf8"), "image");
  assert.equal(result.imageSize, "1024x1024");
});

test("parseSse ignores keepalive lines and failed responses throw", () => {
  assert.equal(parseSse("event: ping\ndata: [DONE]\n").length, 0);
  assert.throws(
    () => parseDirectResponse('data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n'),
    /boom/,
  );
});
