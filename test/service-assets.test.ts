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
  assert.match(script("install-ubuntu.sh"), /systemctl --user enable --now codex-task\.service/);
  assert.match(script("install-macos.sh"), /launchctl bootstrap "gui\/\$\(id -u\)"/);
  assert.match(script("Install-Windows.ps1"), /Register-ScheduledTask/);
  assert.match(script("Install-Windows.ps1"), /New-ScheduledTaskTrigger -AtLogOn/);
});

test("uninstallers preserve the global package and Codex data", () => {
  for (const name of ["uninstall-ubuntu.sh", "uninstall-macos.sh", "Uninstall-Windows.ps1"]) {
    const contents = script(name);
    assert.doesNotMatch(contents, /npm\s+(?:uninstall|remove)/i);
    assert.doesNotMatch(contents, /\.codex[/\\]/i);
  }
});
