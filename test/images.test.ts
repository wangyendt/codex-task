import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
