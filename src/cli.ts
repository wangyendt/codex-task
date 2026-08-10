#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { dispatch, streamTaskEvents } from "./api.js";
import { runDoctor } from "./doctor.js";
import { asCodexErrandError, usageError } from "./errors.js";
import { companionSkillPath } from "./skill.js";
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
  promptFile?: string;
}

interface CommonFlags extends PromptFlags {
  backend: Backend;
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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function resolvePrompt(positional: string | undefined, flags: PromptFlags): Promise<string> {
  const sources = Number(positional !== undefined) + Number(flags.promptFile !== undefined) + Number(!process.stdin.isTTY);
  if (sources === 0) throw usageError("provide a prompt argument, --prompt-file, or stdin");
  if (sources > 1) throw usageError("prompt argument, --prompt-file, and stdin are mutually exclusive");
  const prompt = positional ?? (flags.promptFile ? readFileSync(flags.promptFile, "utf8") : await readStdin());
  if (!prompt.trim()) throw usageError("prompt must not be empty");
  return prompt;
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

function instructions(flags: CommonFlags): string | undefined {
  if (flags.instructions && flags.instructionsFile) {
    throw usageError("--instructions and --instructions-file are mutually exclusive");
  }
  return flags.instructions ?? (flags.instructionsFile ? readFileSync(flags.instructionsFile, "utf8") : undefined);
}

function common(flags: CommonFlags): {
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
    backend: flags.backend,
    model: flags.model,
    reasoning: flags.reasoning,
    instructions: instructions(flags),
    outputSchema: jsonFile(flags.schema),
    timeoutMs: durationMs(flags.timeout),
    retries: integer(flags.retries, "retries"),
    codexHome: flags.codexHome,
  };
}

function addCommonOptions(command: Command, defaultBackend: Backend): Command {
  return command
    .addOption(new Option("--backend <backend>", "execution backend").choices(["direct", "sdk"]).default(defaultBackend))
    .option("--prompt-file <path>", "read prompt from a UTF-8 file")
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
    .option("--instructions-file <path>", "read additional instructions from a file")
    .option("--schema <path>", "JSON Schema for the final text response")
    .option("--timeout <duration>", "timeout, for example 30s, 10m, or 1h")
    .option("--retries <count>", "Direct transient retries")
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
  .name("codexerrand")
  .description("Unofficial agent-to-agent text, image, and workspace task runner for Codex")
  .version("0.1.0");

addCommonOptions(program.command("text [prompt]").description("generate a focused text result"), "direct").action(
  async (prompt: string | undefined, flags: CommonFlags) => {
    await execute(
      { kind: "text", options: { ...common(flags), prompt: await resolvePrompt(prompt, flags) } },
      flags.stream ?? false,
    );
  },
);

addCommonOptions(program.command("image [prompt]").description("generate or edit images"), "direct")
  .option("-i, --image <path>", "reference image; repeat up to five times", collect, [])
  .option("-o, --output <path>", "PNG file or output directory")
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
    const options: ImageOptions = {
      ...common(flags),
      prompt: await resolvePrompt(prompt, flags),
      imagePaths: flags["image"] as string[],
      output: flags["output"] as string | undefined,
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

addCommonOptions(program.command("task [prompt]").description("run a Codex workspace task"), "direct")
  .option("--cwd <path>", "working directory", process.cwd())
  .addOption(
    new Option("--sandbox <mode>", "sandbox mode")
      .choices(["read-only", "workspace-write", "danger-full-access"])
      .default("danger-full-access"),
  )
  .option("--no-network", "disable network access")
  .option("--no-followup", "forbid needs_input; complete or fail in one caller turn")
  .action(async (prompt: string | undefined, flags: CommonFlags & Record<string, unknown>) => {
    if (flags.backend !== "sdk") throw usageError("task requires explicit --backend sdk");
    await execute(
      {
        kind: "task",
        options: {
          ...common(flags),
          backend: "sdk",
          prompt: await resolvePrompt(prompt, flags),
          workingDirectory: flags["cwd"] as string,
          sandboxMode: flags["sandbox"] as SandboxMode,
          networkAccess: (flags["network"] as boolean | undefined) ?? true,
          noFollowup: (flags["followup"] as boolean | undefined) === false,
        },
      },
      flags.stream ?? false,
    );
  });

addCommonOptions(program.command("resume <task-id> [answer]").description("resume a task awaiting input"), "sdk")
  .option("--no-followup", "forbid another needs_input result")
  .action(async (taskId: string, answer: string | undefined, flags: CommonFlags & Record<string, unknown>) => {
    await execute(
      {
        kind: "resume",
        options: {
          ...common(flags),
          taskId,
          answer: await resolvePrompt(answer, flags),
          noFollowup: (flags["followup"] as boolean | undefined) === false,
        },
      },
      flags.stream ?? false,
    );
  });

program.command("doctor").description("inspect local Direct and SDK readiness without sending a model request").action(() => {
  writeJson(runDoctor());
});

program.command("gc").description("remove expired CodexErrand state and temporary artifacts").action(() => {
  writeJson(runGarbageCollection());
});

program
  .command("skill")
  .description("inspect the packaged companion skill")
  .command("path")
  .description("print the companion skill directory")
  .action(() => writeJson({ path: companionSkillPath() }));

program.parseAsync(process.argv).catch((error: unknown) => {
  const normalized = asCodexErrandError(error);
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
