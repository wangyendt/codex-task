import assert from "node:assert/strict";
import test from "node:test";
import {
  proxyFromMacOsOutput,
  proxyFromWindowsServer,
  resolveEffectiveProxy,
  type ProxyCommandRunner,
} from "../src/system-proxy.js";

test("explicit proxy modes override environment and system settings", () => {
  const runCommand: ProxyCommandRunner = () => {
    throw new Error("system lookup should not run");
  };
  const env = { ALL_PROXY: "http://environment:8080" };

  assert.equal(resolveEffectiveProxy({ configuredProxy: "socks5h://fixed:1080", env, runCommand }), "socks5h://fixed:1080");
  assert.equal(resolveEffectiveProxy({ configuredProxy: "direct", env, runCommand }), undefined);
  assert.equal(resolveEffectiveProxy({ configuredProxy: "none", env, runCommand }), undefined);
});

test("automatic mode prefers standard proxy environment variables", () => {
  assert.equal(resolveEffectiveProxy({
    configuredProxy: "auto",
    env: { HTTPS_PROXY: "http://environment:8080" },
    runCommand: () => undefined,
  }), "http://environment:8080");
});

test("macOS system proxy parsing prefers SOCKS and falls back to web proxy", () => {
  assert.equal(proxyFromMacOsOutput(`
    HTTPEnable : 1
    HTTPPort : 8080
    HTTPProxy : web.local
    SOCKSEnable : 1
    SOCKSPort : 1080
    SOCKSProxy : socks.local
  `), "socks5h://socks.local:1080");
  assert.equal(proxyFromMacOsOutput(`
    HTTPSEnable : 1
    HTTPSPort : 8080
    HTTPSProxy : web.local
    SOCKSEnable : 0
  `), "http://web.local:8080");
  assert.equal(proxyFromMacOsOutput("HTTPEnable : 0\nSOCKSEnable : 0"), undefined);
});

test("automatic mode reads the active macOS system proxy", () => {
  const runCommand: ProxyCommandRunner = (file, args) => {
    assert.equal(file, "/usr/sbin/scutil");
    assert.deepEqual(args, ["--proxy"]);
    return "SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : 6153";
  };
  assert.equal(resolveEffectiveProxy({
    configuredProxy: "auto",
    env: {},
    platform: "darwin",
    runCommand,
  }), "socks5h://127.0.0.1:6153");
});

test("automatic mode reads manual GNOME proxy settings", () => {
  const values = new Map([
    ["org.gnome.system.proxy mode", "'manual'"],
    ["org.gnome.system.proxy.socks host", "'127.0.0.1'"],
    ["org.gnome.system.proxy.socks port", "1081"],
  ]);
  const runCommand: ProxyCommandRunner = (_file, args) => values.get(`${args[1]} ${args[2]}`);
  assert.equal(resolveEffectiveProxy({ env: {}, platform: "linux", runCommand }), "socks5h://127.0.0.1:1081");
});

test("Windows system proxy strings support shared and per-protocol forms", () => {
  assert.equal(proxyFromWindowsServer("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(
    proxyFromWindowsServer("http=web.local:8080;https=secure.local:8443;socks=socks.local:1080"),
    "socks5h://socks.local:1080",
  );
});
