import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { parseDocument } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
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
}

process.stdout.write(`${JSON.stringify({ ok: true, files })}\n`);
