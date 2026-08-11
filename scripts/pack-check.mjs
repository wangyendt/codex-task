import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
const report = JSON.parse(output)[0];
const files = report.files.map((entry) => entry.path);
for (const required of [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "skills/codex-task/SKILL.md",
  "skills/codex-task/agents/openai.yaml",
  ".codex-plugin/plugin.json",
  "README.md",
  "README_EN.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  if (!files.includes(required)) throw new Error(`npm package is missing ${required}`);
}
for (const forbidden of ["src/", "test/", ".github/"]) {
  if (files.some((path) => path.startsWith(forbidden))) throw new Error(`npm package leaks ${forbidden}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, files: files.length, bytes: report.size })}\n`);
