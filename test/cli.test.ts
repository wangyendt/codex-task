import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(output, /setup/);
});

test("setup exposes automatic, fixed, and direct proxy modes", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "setup", "--help"], {
    encoding: "utf8",
  });
  assert.match(output, /--proxy <url>/);
  assert.match(output, /--no-proxy/);
  assert.match(output, /--host <host>/);
  assert.match(output, /--port <port>/);
  assert.match(output, /--max-concurrency <count>/);
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

test("user can create, list, and revoke a scoped Service Token", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-task-token-cli-"));
  const env = { ...process.env, CODEX_TASK_HOME: home };
  const run = (...args: string[]): Record<string, unknown> => JSON.parse(execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "token", ...args],
    { encoding: "utf8", env },
  )) as Record<string, unknown>;

  try {
    const created = run("create", "--name", "ipad-media", "--allow", "text,image");
    assert.equal(created["status"], "created");
    assert.equal(created["name"], "ipad-media");
    assert.deepEqual(created["allow"], ["text", "image"]);
    assert.match(String(created["token"]), /^ctt_/);

    const listed = run("list");
    assert.deepEqual(listed["tokens"], [{
      name: "ipad-media",
      allow: ["text", "image"],
      createdAt: created["createdAt"],
    }]);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(String(created["token"])));

    assert.deepEqual(run("revoke", "ipad-media"), { status: "revoked", name: "ipad-media" });
    assert.deepEqual(run("list")["tokens"], []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
