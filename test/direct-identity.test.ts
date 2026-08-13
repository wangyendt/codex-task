import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DIRECT_TLS_PROFILES,
  inspectDirectTlsProfile,
  loadOrCreateIdentity,
} from "../src/backends/direct/identity.js";
import { directSessionOptions } from "../src/backends/direct/http.js";
import { mapDirectHttpError } from "../src/backends/direct/index.js";

test("existing Direct identities gain one stable explicit browser fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-direct-identity-"));
  const previousHome = process.env["CODEX_TASK_HOME"];
  process.env["CODEX_TASK_HOME"] = root;
  const identityPath = join(root, "state", "identity.json");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(identityPath, JSON.stringify({
    installationId: "install",
    codexVersion: "0.147.0",
    osType: "Linux",
    osVersion: "test",
    arch: "x86_64",
  }));

  try {
    const first = loadOrCreateIdentity(join(root, "codex"));
    const second = loadOrCreateIdentity(join(root, "codex"));
    assert.ok(DIRECT_TLS_PROFILES.some((profile) => profile.label === first.tls.label));
    assert.notEqual(first.tls.ja3, "auto");
    assert.notEqual(first.tls.akamai, "auto");
    assert.deepEqual(second.tls, first.tls);
    const persisted = JSON.parse(readFileSync(identityPath, "utf8")) as { tls?: unknown };
    assert.deepEqual(persisted.tls, first.tls);
  } finally {
    if (previousHome === undefined) delete process.env["CODEX_TASK_HOME"];
    else process.env["CODEX_TASK_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspecting the Direct profile is read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-task-direct-inspect-"));
  const previousHome = process.env["CODEX_TASK_HOME"];
  process.env["CODEX_TASK_HOME"] = root;
  try {
    assert.equal(inspectDirectTlsProfile().label, "chrome150");
    assert.equal(existsSync(join(root, "state", "identity.json")), false);
  } finally {
    if (previousHome === undefined) delete process.env["CODEX_TASK_HOME"];
    else process.env["CODEX_TASK_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Direct native sessions receive the persisted fingerprint instead of auto", () => {
  const profile = DIRECT_TLS_PROFILES[0];
  assert.ok(profile);
  const options = directSessionOptions(12_345, "socks5h://127.0.0.1:7890", profile);
  assert.equal(options.ja3, profile.ja3);
  assert.equal(options.akamai, profile.akamai);
  assert.equal(options.proxy, "socks5h://127.0.0.1:7890");
  assert.equal(options.httpVersion, "http2");
  assert.equal(options.timeout, 13);
});

test("HTML 403 blocks are not misreported as expired OAuth", () => {
  assert.equal(mapDirectHttpError(403, "<html><body>blocked</body></html>").code, "DIRECT_UPSTREAM_BLOCKED");
  assert.equal(mapDirectHttpError(403, '{"error":"forbidden"}').code, "DIRECT_AUTH_FAILED");
});
