import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { outputPathForImage, validateImageOptions, writePngArtifact } from "../src/images.js";

test("validateImageOptions accepts bounded image settings", () => {
  const value = validateImageOptions({
    prompt: "image",
    count: 10,
    concurrency: 3,
    size: "3840x2160",
    quality: "high",
    background: "transparent",
  });
  assert.equal(value.count, 10);
  assert.equal(value.size, "3840x2160");
});

test("validateImageOptions passes through dimensions above the former local limit", () => {
  const value = validateImageOptions({ prompt: "x", size: "7680x4320" });
  assert.equal(value.size, "7680x4320");
});

test("validateImageOptions rejects unsafe count and dimensions", () => {
  assert.throws(() => validateImageOptions({ prompt: "x", count: 11 }), /count/);
  assert.throws(() => validateImageOptions({ prompt: "x", size: "wide" }), /WIDTHxHEIGHT/);
});

test("validateImageOptions validates reference type and size", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-image-test-"));
  try {
    const path = join(directory, "reference.txt");
    writeFileSync(path, "not an image");
    assert.throws(() => validateImageOptions({ prompt: "x", imagePaths: [path] }), /unsupported/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writePngArtifact writes atomically and protects existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-output-test-"));
  try {
    const output = join(directory, "result.png");
    const artifact = writePngArtifact("00000000-0000-0000-0000-000000000000", Buffer.from("png"), output, 0, 1, false);
    assert.equal(artifact.path, output);
    assert.equal(readFileSync(output, "utf8"), "png");
    assert.throws(
      () => writePngArtifact("00000000-0000-0000-0000-000000000000", Buffer.from("new"), output, 0, 1, false),
      /already exists/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("outputPathForImage creates deterministic batch paths", () => {
  const target = outputPathForImage("00000000-0000-0000-0000-000000000000", "./poster.png", 1, 3);
  assert.match(target.path, /poster-2\.png$/);
  assert.equal(target.temporary, false);
});

test("image output defaults to a unique durable file in the current directory", () => {
  const target = outputPathForImage("12345678-0000-0000-0000-000000000000", undefined, 0, 1);
  assert.equal(target.path, resolve("image-12345678.png"));
  assert.equal(target.temporary, false);
});

test("temporary image output is explicit and managed", () => {
  const target = outputPathForImage("12345678-0000-0000-0000-000000000000", undefined, 0, 1, true);
  assert.match(target.path, /codex-task[/\\]12345678-0000-0000-0000-000000000000[/\\]image-1\.png$/);
  assert.equal(target.temporary, true);
});

test("temporary image output cannot also name a durable destination", () => {
  assert.throws(
    () => validateImageOptions({ prompt: "meal", temporary: true, output: "./meal.png" }),
    /--temp cannot be combined with --output/,
  );
});

test("reference inputs preserve more than five images in order", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-many-inputs-"));
  try {
    const paths = Array.from({ length: 12 }, (_, index) => {
      const path = join(directory, `input-${index}.png`);
      writeFileSync(path, `frame-${index}`);
      return path;
    });
    assert.deepEqual(validateImageOptions({ prompt: "All frames", imagePaths: paths }).imagePaths, paths);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removing the count cap retains per-file and aggregate byte limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-image-bytes-"));
  const sparse = (name: string, bytes: number): string => {
    const path = join(directory, name);
    const fd = openSync(path, "w");
    try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
    return path;
  };
  try {
    const huge = sparse("huge.png", 20 * 1024 * 1024 + 1);
    assert.throws(() => validateImageOptions({ prompt: "x", imagePaths: [huge] }), /20 MiB/);
    const files = Array.from({ length: 6 }, (_, index) => sparse(`${index}.png`, 9 * 1024 * 1024));
    assert.throws(() => validateImageOptions({ prompt: "x", imagePaths: files }), /50 MiB/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("imageModel remains optional, validates syntax and rejects SDK instead of silently dropping it", () => {
  assert.equal(validateImageOptions({}).imageModel, undefined);
  assert.equal(validateImageOptions({ imageModel: "gpt-image-future" }).imageModel, "gpt-image-future");
  for (const imageModel of ["", " image-model", "image model", "model\n", "a".repeat(129)]) {
    assert.throws(() => validateImageOptions({ imageModel }), /INVALID_IMAGE_MODEL/);
  }
  assert.throws(() => validateImageOptions({ imageModel: "gpt-image-future", backend: "sdk" }), /IMAGE_MODEL_REQUIRES_DIRECT/);
});
