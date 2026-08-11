import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveTaskInput, toSdkInput } from "../src/inputs.js";

test("caller can combine inline text, multiple prompt files, stdin, and images in order", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-input-test-"));
  const requirements = join(root, "requirements.md");
  const constraints = join(root, "constraints.md");
  const image = join(root, "meal.png");
  try {
    writeFileSync(requirements, "Use at least 30 g protein.\n");
    writeFileSync(constraints, "Keep the meal below 650 kcal.\n");
    writeFileSync(image, "png");

    const result = resolveTaskInput({
      prompt: "Create a fitness meal plan.",
      promptFiles: [requirements, constraints],
      stdin: "Prefer ingredients available in summer.",
      imagePaths: [image],
    });

    assert.equal(
      result.text,
      [
        "Create a fitness meal plan.",
        `--- BEGIN PROMPT FILE: ${resolve(requirements)} ---\nUse at least 30 g protein.\n--- END PROMPT FILE ---`,
        `--- BEGIN PROMPT FILE: ${resolve(constraints)} ---\nKeep the meal below 650 kcal.\n--- END PROMPT FILE ---`,
        "--- BEGIN STDIN ---\nPrefer ingredients available in summer.\n--- END STDIN ---",
      ].join("\n\n"),
    );
    assert.deepEqual(result.imagePaths, [resolve(image)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every task kind rejects missing or unsupported image inputs before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-input-test-"));
  try {
    assert.throws(
      () => resolveTaskInput({ prompt: "Analyze the meal.", imagePaths: [join(root, "missing.png")] }),
      /does not exist/,
    );
    const unsupported = join(root, "meal.txt");
    writeFileSync(unsupported, "not an image");
    assert.throws(
      () => resolveTaskInput({ prompt: "Analyze the meal.", imagePaths: [unsupported] }),
      /unsupported image type/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolved multimodal input maps to Codex SDK text and local_image entries", () => {
  assert.deepEqual(toSdkInput({ text: "Analyze the meal.", imagePaths: ["/tmp/meal.png"] }), [
    { type: "text", text: "Analyze the meal." },
    { type: "local_image", path: "/tmp/meal.png" },
  ]);
});
