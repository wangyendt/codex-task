import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { parseDocument } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const releaseWorkflow = "release-on-main.yml";
const releaseTriggerPaths = [
  "src/**",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/service/**",
  "skills/**",
  ".codex-plugin/plugin.json",
];
const files = (await readdir(workflowDirectory))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

if (files.length === 0) {
  throw new Error("No GitHub Actions workflows found.");
}

for (const file of files) {
  const source = await readFile(new URL(file, workflowDirectory), "utf8");
  const document = parseDocument(source, { prettyErrors: true });

  if (document.errors.length > 0) {
    throw new Error(
      `${join(".github/workflows", file)} is invalid YAML:\n${document.errors.join("\n")}`,
    );
  }

  if (file === releaseWorkflow) {
    const workflow = document.toJS();
    const configuredPaths = workflow?.on?.push?.paths;
    if (!Array.isArray(configuredPaths)) {
      throw new Error(
        `${join(".github/workflows", file)} must limit automatic releases with on.push.paths.`,
      );
    }

    const missingPaths = releaseTriggerPaths.filter(
      (path) => !configuredPaths.includes(path),
    );
    if (missingPaths.length > 0) {
      throw new Error(
        `${join(".github/workflows", file)} is missing release trigger paths: ${missingPaths.join(", ")}`,
      );
    }
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, files })}\n`);
