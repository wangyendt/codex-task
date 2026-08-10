import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("CODEXRUN environment variables take precedence over legacy names", () => {
  const root = mkdtempSync(join(tmpdir(), "codexrun-config-test-"));
  const names = ["CODEXRUN_HOME", "CODEXERRAND_HOME", "CODEXRUN_MODEL", "CODEXERRAND_MODEL"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env["CODEXRUN_HOME"] = join(root, "current");
  process.env["CODEXERRAND_HOME"] = join(root, "legacy");
  process.env["CODEXRUN_MODEL"] = "current-model";
  process.env["CODEXERRAND_MODEL"] = "legacy-model";
  try {
    assert.equal(loadConfig().directModel, "current-model");
    delete process.env["CODEXRUN_MODEL"];
    assert.equal(loadConfig().directModel, "legacy-model");
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
