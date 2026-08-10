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
});

test("CLI version follows package.json", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
    encoding: "utf8",
  });
  assert.equal(output.trim(), manifest.version);
});

test("workspace task rejects the default Direct backend", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "task", "do work"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /task requires explicit --backend sdk/);
});
