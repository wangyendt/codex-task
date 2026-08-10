import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateImage, generateText } from "../../src/api.js";

const enabled = process.env["RUN_DIRECT_E2E"] === "1";

test("Direct gpt-5.6-sol text smoke", { skip: !enabled }, async () => {
  const result = await generateText({
    prompt: "Reply with exactly: codexrun-ok",
    backend: "direct",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    retries: 0,
  });
  assert.equal(result.status, "completed");
  assert.match(result.text ?? "", /codexrun-ok/i);
});

test("Direct image preflights Lite to classic image generation", { skip: !enabled }, async () => {
  const output = mkdtempSync(join(tmpdir(), "codexrun-e2e-image-"));
  try {
    const result = await generateImage({
      prompt: "A plain blue circle centered on a white background",
      backend: "direct",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      output,
      count: 1,
      size: "1024x1024",
      quality: "low",
      retries: 0,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.effectiveModel, "gpt-5.5");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
