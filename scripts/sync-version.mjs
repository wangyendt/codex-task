import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pluginPath = join(root, ".codex-plugin", "plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
plugin.version = packageJson.version;
writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
