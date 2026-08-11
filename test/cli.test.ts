import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("CLI help exposes the capability commands", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    encoding: "utf8",
  });
  assert.match(output, /text/);
  assert.match(output, /image/);
  assert.match(output, /task/);
  assert.match(output, /resume/);
  assert.match(output, /serve/);
});

test("serve help exposes network-safe service controls", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--help"], {
    encoding: "utf8",
  });
  assert.match(output, /--host <host>/);
  assert.match(output, /--port <port>/);
  assert.match(output, /--token-file <path>/);
  assert.match(output, /--max-concurrency <count>/);
});

test("CLI version follows package.json", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
    encoding: "utf8",
  });
  assert.equal(output.trim(), manifest.version);
});

test("task implies the SDK backend and exposes multimodal input options", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "task", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /-f, --prompt-file <path>/);
  assert.match(result.stdout, /-i, --image <path>/);
  assert.doesNotMatch(result.stdout, /--backend/);
  assert.doesNotMatch(result.stdout, /--schema/);
  assert.doesNotMatch(result.stdout, /--retries/);
});

test("text, image, and resume share composable file and image inputs", () => {
  for (const command of ["text", "image", "resume task-id"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...command.split(" "), "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /-f, --prompt-file <path>/);
    assert.match(result.stdout, /-i, --image <path>/);
    if (command.startsWith("resume")) {
      assert.doesNotMatch(result.stdout, /--schema/);
      assert.doesNotMatch(result.stdout, /--retries/);
    }
  }
});
