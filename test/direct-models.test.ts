import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDirectImageModel, resolveDirectModel } from "../src/backends/direct/models.js";

test("resolveDirectModel follows Codex config and Responses Lite metadata", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-task-model-test-"));
  try {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            priority: 1,
            supported_in_api: true,
            use_responses_lite: true,
            supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
          },
        ],
      }),
    );
    const model = resolveDirectModel(codexHome, undefined, "high");
    assert.equal(model.model, "gpt-5.6-sol");
    assert.equal(model.useResponsesLite, true);
    assert.equal(model.source, "codex-config");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("resolveDirectModel validates reasoning against model catalog", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-task-model-test-"));
  try {
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-test",
            visibility: "list",
            priority: 1,
            supported_reasoning_levels: [{ effort: "low" }],
          },
        ],
      }),
    );
    assert.throws(() => resolveDirectModel(codexHome, "gpt-test", "high"), /not supported/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("resolveDirectImageModel preflights Lite to a classic image model", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-task-model-test-"));
  try {
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            priority: 1,
            use_responses_lite: true,
            supported_reasoning_levels: [{ effort: "medium" }],
          },
          {
            slug: "gpt-5.5",
            visibility: "list",
            priority: 2,
            use_responses_lite: false,
            supported_reasoning_levels: [{ effort: "medium" }],
          },
        ],
      }),
    );
    const result = resolveDirectImageModel(codexHome, "gpt-5.6-sol", "medium");
    assert.equal(result.model.model, "gpt-5.5");
    assert.equal(result.replacedLiteModel, "gpt-5.6-sol");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
