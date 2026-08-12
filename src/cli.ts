#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { dispatch, streamTaskEvents } from "./api.js";
import { runDoctor } from "./doctor.js";
import { asCodexTaskError, usageError } from "./errors.js";
import { resolveTaskInput, type ResolvedTaskInput } from "./inputs.js";
import { startCodexTaskServer } from "./server.js";
import {
  createServiceToken,
  listServiceTokens,
  parseServiceTokenScopes,
  revokeServiceToken,
  serviceTokenRegistryPath,
} from "./service-tokens.js";
import { companionSkillPath } from "./skill.js";
import { runServiceSetup } from "./setup.js";
import { runGarbageCollection } from "./state.js";
import type {
  Backend,
  ImageOptions,
  ReasoningEffort,
  SandboxMode,
  TaskRequest,
  TaskResult,
} from "./types.js";

interface PromptFlags {
  promptFile?: string[];
  image?: string[];
}

interface PackageManifest {
  version: string;
}

interface CommonFlags extends PromptFlags {
  backend?: Backend;
  model?: string;
  reasoning?: ReasoningEffort;
  instructions?: string;
  instructionsFile?: string;
  schema?: string;
  timeout?: string;
  retries?: string;
  codexHome?: string;
  stream?: boolean;
}

interface CommonFeatureOptions {
  schema?: boolean;
  retries?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Partial<PackageManifest>;
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }
  return manifest.version;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveCliInput(positional: string | undefined, flags: PromptFlags): Promise<ResolvedTaskInput> {
  const stdin = process.stdin.isTTY ? undefined : await readStdin();
  return resolveTaskInput({
    prompt: positional,
    promptFiles: flags.promptFile,
    stdin,
    imagePaths: flags.image,
  });
}

function durationMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw usageError(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return amount * factor;
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usageError(`${name} must be an integer`);
  return Number(value);
}

function jsonFile(path: string | undefined): Record<string, unknown> | undefined {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw usageError(`could not parse JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function serviceToken(path: string | undefined): string | undefined {
  if (!path) return process.env["CODEX_TASK_SERVER_TOKEN"]?.trim() || undefined;
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!token) throw new Error("token file is empty");
    return token;
  } catch (error) {
    throw usageError(`could not read service token file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function instructions(flags: CommonFlags): string | undefined {
  if (flags.instructions && flags.instructionsFile) {
    throw usageError("--instructions and --instructions-file are mutually exclusive");
  }
  return flags.instructions ?? (flags.instructionsFile ? readFileSync(flags.instructionsFile, "utf8") : undefined);
}

function common(flags: CommonFlags, backend: Backend): {
  backend: Backend;
  model?: string | undefined;
  reasoning?: ReasoningEffort | undefined;
  instructions?: string | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  codexHome?: string | undefined;
} {
  return {
    backend: flags.backend ?? backend,
    model: flags.model,
    reasoning: flags.reasoning,
    instructions: instructions(flags),
    outputSchema: jsonFile(flags.schema),
    timeoutMs: durationMs(flags.timeout),
    retries: integer(flags.retries, "retries"),
    codexHome: flags.codexHome,
  };
}

function addCommonOptions(
  command: Command,
  defaultBackend?: Backend,
  features: CommonFeatureOptions = {},
): Command {
  let configured = defaultBackend
    ? command.addOption(
        new Option("--backend <backend>", "execution backend").choices(["direct", "sdk"]).default(defaultBackend),
      )
    : command.addOption(new Option("--backend <backend>").choices(["sdk"]).hideHelp());
  configured = configured
    .option("-f, --prompt-file <path>", "append a UTF-8 prompt file; repeatable", collect, [])
    .option("-i, --image <path>", "attach a local image; repeat up to five times", collect, [])
    .option("--model <model>", "model override")
    .addOption(
      new Option("--reasoning <effort>", "reasoning effort").choices([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]),
    )
    .option("--instructions <text>", "additional worker instructions")
    .option("--instructions-file <path>", "read additional instructions from a file");
  if (features.schema) configured = configured.option("--schema <path>", "JSON Schema for the final text response");
  configured = configured.option("--timeout <duration>", "timeout, for example 30s, 10m, or 1h");
  if (features.retries) configured = configured.option("--retries <count>", "Direct transient retries");
  return configured
    .option("--codex-home <path>", "Codex home directory")
    .option("--stream", "emit JSONL progress events");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resultExitCode(result: TaskResult): number {
  if (result.status === "completed" || result.status === "needs_input") return 0;
  if (result.status === "cancelled") return 130;
  return result.error.code === "USAGE_ERROR" ? 2 : 1;
}

async function execute(request: TaskRequest, stream: boolean): Promise<void> {
  if (stream) {
    let exitCode = 0;
    for await (const event of streamTaskEvents(request)) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      if (event.type === "failed") exitCode = resultExitCode(event.result);
    }
    process.exitCode = exitCode;
    return;
  }
  const result = await dispatch(request);
  writeJson(result);
  process.exitCode = resultExitCode(result);
}

const program = new Command();
program
  .name("codex-task")
  .description("Unofficial agent-to-agent text, image, and workspace task runner for Codex")
  .version(packageVersion());

addCommonOptions(program.command("text [prompt]").description("generate a focused text result"), "direct", {
  schema: true,
  retries: true,
}).action(
  async (prompt: string | undefined, flags: CommonFlags) => {
    const input = await resolveCliInput(prompt, flags);
    await execute(
      { kind: "text", options: { ...common(flags, "direct"), prompt: input.text, imagePaths: input.imagePaths } },
      flags.stream ?? false,
    );
  },
);

addCommonOptions(program.command("image [prompt]").description("generate or edit images"), "direct", { retries: true })
  .option("-o, --output <path>", "PNG file or output directory")
  .option("--temp", "store output under the managed temporary directory")
  .option("-n, --count <count>", "number of images", "1")
  .option("--concurrency <count>", "parallel image requests", "1")
  .option("--size <size>", "auto or WIDTHxHEIGHT", "auto")
  .addOption(new Option("--quality <quality>").choices(["auto", "low", "medium", "high"]).default("auto"))
  .addOption(
    new Option("--background <background>").choices(["auto", "opaque", "transparent"]).default("auto"),
  )
  .option("--overwrite", "replace existing output files")
  .option("--cwd <path>", "working directory for SDK image generation")
  .action(async (prompt: string | undefined, flags: CommonFlags & Record<string, unknown>) => {
    const input = await resolveCliInput(prompt, flags);
    const options: ImageOptions = {
      ...common(flags, "direct"),
      prompt: input.text,
      imagePaths: input.imagePaths,
      output: flags["output"] as string | undefined,
      temporary: (flags["temp"] as boolean | undefined) ?? false,
      count: integer(flags["count"] as string, "count"),
      concurrency: integer(flags["concurrency"] as string, "concurrency"),
      size: flags["size"] as string,
      quality: flags["quality"] as ImageOptions["quality"],
      background: flags["background"] as ImageOptions["background"],
      overwrite: (flags["overwrite"] as boolean | undefined) ?? false,
      workingDirectory: flags["cwd"] as string | undefined,
    };
    await execute({ kind: "image", options }, flags.stream ?? false);
  });

addCommonOptions(program.command("task [prompt]").description("run a Codex workspace task"))
  .option("--cwd <path>", "working directory", process.cwd())
  .addOption(
    new Option("--sandbox <mode>", "sandbox mode")
      .choices(["read-only", "workspace-write", "danger-full-access"])
      .default("danger-full-access"),
  )
  .option("--no-network", "disable network access")
  .option("--no-followup", "forbid needs_input; complete or fail in one caller turn")
  .action(async (prompt: string | undefined, flags: CommonFlags & Record<string, unknown>) => {
    const input = await resolveCliInput(prompt, flags);
    await execute(
      {
        kind: "task",
        options: {
          ...common(flags, "sdk"),
          backend: "sdk",
          prompt: input.text,
          imagePaths: input.imagePaths,
          workingDirectory: flags["cwd"] as string,
          sandboxMode: flags["sandbox"] as SandboxMode,
          networkAccess: (flags["network"] as boolean | undefined) ?? true,
          noFollowup: (flags["followup"] as boolean | undefined) === false,
        },
      },
      flags.stream ?? false,
    );
  });

addCommonOptions(program.command("resume <task-id> [answer]").description("resume a task awaiting input"))
  .option("--no-followup", "forbid another needs_input result")
  .action(async (taskId: string, answer: string | undefined, flags: CommonFlags & Record<string, unknown>) => {
    const input = await resolveCliInput(answer, flags);
    await execute(
      {
        kind: "resume",
        options: {
          ...common(flags, "sdk"),
          taskId,
          answer: input.text,
          imagePaths: input.imagePaths,
          noFollowup: (flags["followup"] as boolean | undefined) === false,
        },
      },
      flags.stream ?? false,
    );
  });

program.command("doctor").description("inspect local Direct and SDK readiness without sending a model request").action(() => {
  writeJson(runDoctor());
});

program.command("gc").description("remove expired CodexTask state and temporary artifacts").action(() => {
  writeJson(runGarbageCollection());
});

program
  .command("setup")
  .description("install and start the native user-level auto-start service")
  .option("--host <host>", "listener address", "0.0.0.0")
  .option("--port <port>", "listener port", "7777")
  .option("--max-concurrency <count>", "maximum simultaneously running jobs", "2")
  .option("--proxy <url>", "fixed HTTP/HTTPS/SOCKS proxy; defaults to automatic system detection")
  .option("--no-proxy", "always connect directly and ignore environment and system proxies")
  .action((flags: Record<string, unknown>) => {
    const port = integer(flags["port"] as string, "port");
    const maxConcurrency = integer(flags["maxConcurrency"] as string, "max-concurrency");
    if (!port || port > 65_535) throw usageError("port must be an integer from 1 to 65535");
    if (!maxConcurrency) throw usageError("max-concurrency must be a positive integer");
    runServiceSetup({
      host: flags["host"] as string,
      port,
      maxConcurrency,
      proxy: flags["proxy"] as string | boolean | undefined,
    });
  });

const tokenCommand = program.command("token").description("manage scoped Service Tokens");

tokenCommand
  .command("create")
  .description("create a Service Token for text and/or image requests")
  .requiredOption("--name <name>", "device or client name")
  .requiredOption("--allow <scopes>", "comma-separated scopes: text,image")
  .action(async (flags: Record<string, unknown>) => {
    writeJson(await createServiceToken(
      flags["name"] as string,
      parseServiceTokenScopes(flags["allow"] as string),
    ));
  });

tokenCommand
  .command("list")
  .description("list Service Token names and scopes without secrets")
  .action(() => writeJson({ tokens: listServiceTokens() }));

tokenCommand
  .command("revoke <name>")
  .description("revoke a Service Token by name")
  .action(async (name: string) => {
    await revokeServiceToken(name);
    writeJson({ status: "revoked", name });
  });

program
  .command("serve")
  .description("run the authenticated CodexTask HTTP service")
  .option("--host <host>", "listener address", "127.0.0.1")
  .option("--port <port>", "listener port", "7777")
  .option("--token-file <path>", "read the Bearer token from a protected file")
  .option("--max-concurrency <count>", "maximum simultaneously running jobs", "2")
  .action(async (flags: Record<string, unknown>) => {
    const port = integer(flags["port"] as string, "port");
    const maxConcurrency = integer(flags["maxConcurrency"] as string, "max-concurrency");
    if (!port || port > 65_535) throw usageError("port must be an integer from 1 to 65535");
    const token = serviceToken(flags["tokenFile"] as string | undefined);
    const server = await startCodexTaskServer({
      host: flags["host"] as string,
      port,
      token,
      tokenRegistryPath: serviceTokenRegistryPath(),
      maxConcurrency,
    });
    writeJson({
      status: "listening",
      url: server.url,
      host: server.host,
      port: server.port,
      authentication: token ? "bearer" : "none-loopback-only",
    });
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });

program
  .command("skill")
  .description("inspect the packaged companion skill")
  .command("path")
  .description("print the companion skill directory")
  .action(() => writeJson({ path: companionSkillPath() }));

program.parseAsync(process.argv).catch((error: unknown) => {
  const normalized = asCodexTaskError(error);
  writeJson({
    status: "failed",
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
  });
  process.exitCode = normalized.exitCode;
});
