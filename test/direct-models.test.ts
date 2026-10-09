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

test("resolveDirectImageModel changes transport without substituting the main model", () => {
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
    assert.equal(result.model.model, "gpt-5.6-sol");
    assert.equal(result.model.useResponsesLite, false);
    assert.equal(result.model.reasoning, "medium");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Astra uses Lite for text and classic hosted image generation without falling back", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-task-model-test-"));
  try {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\n');
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [{
          slug: "gpt-6-astra",
          use_responses_lite: true,
          supported_reasoning_levels: [{ effort: "medium" }],
        }],
      }),
    );
    assert.equal(resolveDirectModel(codexHome, undefined).useResponsesLite, true);
    for (const explicit of [undefined, "gpt-6-astra"]) {
      const result = resolveDirectImageModel(codexHome, explicit);
      assert.equal(result.model.model, "gpt-6-astra");
      assert.equal(result.model.useResponsesLite, false);
      assert.equal(result.model.reasoning, "medium");
      assert.equal(result.model.source, explicit ? "explicit" : "codex-config");
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("all catalog model/reasoning pairs keep their selection even when every model prefers Lite", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-task-passthrough-"));
  const ids = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  const levels = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
  try {
    // Deliberately omit gpt-5.5: image requests must never consult its levels.
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: ids.map(id => ({
      slug: id,
      use_responses_lite: true,
      supported_reasoning_levels: levels.filter(level => !id.endsWith("luna") || level !== "ultra").map(effort => ({ effort })),
    })) }));
    let pairs = 0;
    for (const id of ids) {
      for (const effort of levels) {
        if (id.endsWith("luna") && effort === "ultra") {
          const resolved = resolveDirectImageModel(home, id, effort).model;
          assert.equal(resolved.model, id);
          assert.equal(resolved.reasoning, effort);
          continue;
        }
        const { model: resolved } = resolveDirectImageModel(home, id, effort);
        assert.equal(resolved.model, id);
        assert.equal(resolved.reasoning, effort);
        assert.equal(resolved.useResponsesLite, false);
        assert.equal(resolved.source, "explicit");
        pairs++;
      }
    }
    assert.equal(pairs, 40);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("image selection is not blocked by a missing model catalog or an unknown effort", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-task-image-advisory-"));
  try {
    const result = resolveDirectImageModel(home, "future-main-model", "ultra");
    assert.equal(result.model.model, "future-main-model");
    assert.equal(result.model.reasoning, "ultra");
    assert.equal(result.model.useResponsesLite, false);
    assert.throws(() => resolveDirectModel(home, "future-main-model", "ultra"), /not supported/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
