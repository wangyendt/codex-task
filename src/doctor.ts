import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths, defaultCodexHome } from "./paths.js";
import { directTransportAvailable } from "./backends/direct/http.js";
import { inspectDirectAuth } from "./backends/direct/auth.js";
import { resolveDirectImageModel, resolveDirectModel } from "./backends/direct/models.js";
import type { DoctorCheck, DoctorReport } from "./types.js";

function codexVersion(): string | undefined {
  try {
    return execFileSync("codex", ["--version"], { timeout: 3000, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function sdkVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
    const packageJson = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as {
      version?: string;
    };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

export function runDoctor(codexHome = defaultCodexHome()): DoctorReport {
  const paths = appPaths();
  const checks: DoctorCheck[] = [];
  const transport = directTransportAvailable();
  checks.push({
    name: "direct-transport",
    status: transport ? "ok" : "warning",
    message: transport
      ? "Native Direct transport is available"
      : "Native Direct transport is unavailable; SDK backend can still be used",
  });

  const auth = inspectDirectAuth(codexHome);
  checks.push({
    name: "codex-oauth",
    status: auth.found && auth.valid ? "ok" : auth.found ? "warning" : "error",
    message: auth.message,
    details: auth.expiresAt ? { expiresAt: new Date(auth.expiresAt).toISOString() } : undefined,
  });

  try {
    const model = resolveDirectModel(codexHome, undefined, "medium");
    const imageModel = resolveDirectImageModel(codexHome, undefined, "medium");
    checks.push({
      name: "direct-model",
      status: "ok",
      message: `${model.model} via ${model.useResponsesLite ? "Responses Lite" : "classic Responses"}`,
      details: {
        source: model.source,
        reasoning: model.reasoning,
        imageModel: imageModel.model.model,
        imageFallbackFrom: imageModel.replacedLiteModel,
      },
    });
  } catch (error) {
    checks.push({
      name: "direct-model",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const cliVersion = codexVersion();
  checks.push({
    name: "codex-cli",
    status: cliVersion ? "ok" : "warning",
    message: cliVersion ?? "codex executable is not on PATH; the bundled SDK binary may still work",
  });
  const version = sdkVersion();
  checks.push({
    name: "codex-sdk",
    status: version ? "ok" : "error",
    message: version ? `@openai/codex-sdk ${version}` : "@openai/codex-sdk is unavailable",
  });

  return {
    ok: checks.every((check) => check.status !== "error"),
    platform: `${process.platform}/${process.arch}`,
    nodeVersion: process.version,
    checks,
    paths: {
      codexHome,
      config: paths.configPath,
      state: paths.stateDir,
      cache: paths.cacheDir,
      temp: paths.tempDir,
      tasks: paths.tasksDir,
    },
  };
}
