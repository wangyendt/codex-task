import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function script(name: string): string {
  return readFileSync(join(root, "scripts", "service", name), "utf8");
}

test("persistent service installers use the global package and a protected token file", () => {
  for (const name of ["install-ubuntu.sh", "install-macos.sh", "Install-Windows.ps1"]) {
    const contents = script(name);
    assert.match(contents, /npm install -g codex-task@latest/);
    assert.doesNotMatch(contents, /\bnpx\b/);
    assert.match(contents, /token-file/i);
  }
});

test("Unix users get one discoverable install and uninstall entry point", () => {
  for (const name of ["install.sh", "uninstall.sh"]) {
    const output = execFileSync("bash", [join(root, "scripts", "service", name), "--help"], { encoding: "utf8" });
    assert.match(output, /Ubuntu\/Linux/);
    assert.match(output, /macOS/);
  }
});

test("each platform installer uses its user-level startup mechanism", () => {
  const ubuntu = script("install-ubuntu.sh");
  assert.match(ubuntu, /loginctl enable-linger "\$current_user"/);
  assert.match(ubuntu, /loginctl show-user "\$current_user" -p Linger --value/);
  assert.ok(
    ubuntu.indexOf("loginctl enable-linger") < ubuntu.indexOf("systemctl --user enable --now"),
    "Ubuntu setup should enable linger before enabling the user service",
  );
  assert.match(ubuntu, /systemctl --user enable --now codex-task\.service/);
  assert.match(script("install-macos.sh"), /launchctl bootstrap "gui\/\$\(id -u\)"/);
  assert.match(script("install-macos.sh"), /for delay in 0\.2 0\.5 1/);
  assert.match(script("Install-Windows.ps1"), /Register-ScheduledTask/);
  assert.match(script("Install-Windows.ps1"), /New-ScheduledTaskTrigger -AtLogOn/);
});

test("persistent service installers support automatic, fixed, and disabled proxy modes", () => {
  for (const name of ["install-ubuntu.sh", "install-macos.sh"]) {
    const contents = script(name);
    assert.match(contents, /service_proxy=.*CODEX_TASK_SERVICE_PROXY/);
    assert.match(contents, /CODEX_TASK_SKIP_GLOBAL_INSTALL/);
    assert.match(contents, /export CODEX_TASK_PROXY=/);
    assert.match(contents, /automatic environment\/system detection/);
    assert.match(contents, /chmod 700 "\$runner"/);
    assert.doesNotMatch(contents, /7890/);
  }

  const windows = script("Install-Windows.ps1");
  assert.match(windows, /CODEX_TASK_SERVICE_PROXY/);
  assert.match(windows, /CODEX_TASK_SKIP_GLOBAL_INSTALL/);
  assert.match(windows, /CODEX_TASK_PROXY/);
  assert.match(windows, /automatic environment\/system detection/);
  assert.match(windows, /icacls \$Runner \/inheritance:r/);
  assert.doesNotMatch(windows, /7890/);
});

test("uninstallers preserve the global package and Codex data", () => {
  for (const name of ["uninstall-ubuntu.sh", "uninstall-macos.sh", "Uninstall-Windows.ps1"]) {
    const contents = script(name);
    assert.doesNotMatch(contents, /npm\s+(?:uninstall|remove)/i);
    assert.doesNotMatch(contents, /\.codex[/\\]/i);
    assert.doesNotMatch(contents, /disable-linger/);
  }
});
