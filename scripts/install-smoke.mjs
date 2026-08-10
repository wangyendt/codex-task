import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "codex-task-install-"));
try {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf8",
  });
  const filename = JSON.parse(output)[0].filename;
  const packagePath = join(temp, filename);
  execFileSync("npm", ["init", "-y"], { cwd: temp, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", packagePath], { cwd: temp, stdio: "ignore" });
  const installed = join(temp, "node_modules", "codex-task");
  const module = await import(pathToFileURL(join(installed, "dist", "index.js")).href);
  if (typeof module.generateText !== "function") throw new Error("generateText export is unavailable");
  execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--help"], { stdio: "ignore" });
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const cliVersion = execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--version"], {
    encoding: "utf8",
  }).trim();
  if (cliVersion !== installedManifest.version) {
    throw new Error(`CLI version ${cliVersion} does not match package version ${installedManifest.version}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
