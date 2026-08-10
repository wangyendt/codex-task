import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute } from "node:path";
import type { Input } from "@openai/codex-sdk";
import { executeDirectImage, executeDirectText } from "./backends/direct/index.js";
import { buildWorkspacePrompt, resolveWorkingDirectory, runSdkTurn, type SdkExecution } from "./backends/sdk.js";
import { loadConfig } from "./config.js";
import { asCodexTaskError, CodexTaskError, isAbortError, usageError } from "./errors.js";
import { EventQueue } from "./events.js";
import { ensureDir } from "./fs-utils.js";
import { outputPathForImage, validateImageOptions } from "./images.js";
import { deletePendingTask, loadPendingTask, runGarbageCollection, savePendingTask } from "./state.js";
import type {
  Artifact,
  Backend,
  CancelledResult,
  CompletedResult,
  FailedResult,
  ImageOptions,
  NeedsInputResult,
  ResumeTaskOptions,
  TaskEvent,
  TaskRequest,
  TaskResult,
  TextOptions,
  WorkspaceTaskOptions,
} from "./types.js";

function emit(callback: ((event: TaskEvent) => void) | undefined, event: TaskEvent): void {
  callback?.(event);
}

function opportunisticGc(): void {
  try {
    runGarbageCollection();
  } catch {
    // Garbage collection must never block a task.
  }
}

function failedResult(taskId: string, backend: Backend, error: unknown, artifacts: Artifact[] = []): FailedResult | CancelledResult {
  const normalized = asCodexTaskError(error);
  if (isAbortError(error) || normalized.code === "CANCELLED" || normalized.code === "TIMEOUT") {
    return {
      status: "cancelled",
      taskId,
      backend,
      artifacts,
      error: {
        code: normalized.code === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
        message: normalized.message,
        retryable: normalized.retryable,
      },
    };
  }
  const detailArtifacts = (normalized.details as { artifacts?: Artifact[] } | undefined)?.artifacts;
  return {
    status: "failed",
    taskId,
    backend,
    artifacts: detailArtifacts ?? artifacts,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
  };
}

function reportedArtifacts(execution: SdkExecution): Artifact[] {
  if (execution.artifacts.length) return execution.artifacts;
  return execution.reportedArtifacts
    .filter((path) => isAbsolute(path) && existsSync(path))
    .map((path) => {
      const extension = extname(path).toLowerCase();
      const mimeType =
        extension === ".png"
          ? "image/png"
          : extension === ".jpg" || extension === ".jpeg"
            ? "image/jpeg"
            : extension === ".webp"
              ? "image/webp"
              : undefined;
      return {
        path,
        kind: mimeType ? ("image" as const) : ("file" as const),
        mimeType,
        sizeBytes: statSync(path).size,
      };
    });
}

function finalize(callback: ((event: TaskEvent) => void) | undefined, result: TaskResult): TaskResult {
  if (result.status === "completed") emit(callback, { type: "completed", taskId: result.taskId, result });
  else if (result.status === "needs_input") emit(callback, { type: "needs_input", taskId: result.taskId, result });
  else emit(callback, { type: "failed", taskId: result.taskId, result });
  return result;
}

export async function generateText(options: TextOptions): Promise<TaskResult> {
  opportunisticGc();
  const taskId = randomUUID();
  const backend = options.backend ?? "direct";
  emit(options.onEvent, { type: "started", taskId, backend, kind: "text" });
  try {
    if (backend === "direct") {
      const execution = await executeDirectText(taskId, options);
      return finalize(options.onEvent, {
        status: "completed",
        taskId,
        backend,
        text: execution.text,
        effectiveModel: execution.model.model,
        reasoningEffort: execution.model.reasoning,
        artifacts: [],
        usage: execution.usage,
      });
    }
    const config = loadConfig({ sdkTimeoutMs: options.timeoutMs, codexHome: options.codexHome });
    const structuredResponse = options.outputSchema === undefined;
    const execution = await runSdkTurn({
      taskId,
      prompt: structuredResponse
        ? buildWorkspacePrompt(options.prompt, options.instructions, true)
        : [options.instructions, options.prompt].filter(Boolean).join("\n\n"),
      workingDirectory: resolveWorkingDirectory(options.workingDirectory),
      sandboxMode: "danger-full-access",
      networkAccess: true,
      noFollowup: true,
      model: options.model,
      reasoning: options.reasoning,
      timeoutMs: config.sdkTimeoutMs,
      signal: options.signal,
      onEvent: options.onEvent,
      outputSchema: options.outputSchema,
      structuredResponse,
    });
    return finalize(options.onEvent, completedFromSdk(taskId, execution, options.model));
  } catch (error) {
    return finalize(options.onEvent, failedResult(taskId, backend, error));
  }
}

export async function generateImage(options: ImageOptions): Promise<TaskResult> {
  opportunisticGc();
  const taskId = randomUUID();
  const backend = options.backend ?? "direct";
  emit(options.onEvent, { type: "started", taskId, backend, kind: "image" });
  try {
    if (backend === "direct") {
      const execution = await executeDirectImage(taskId, options);
      return finalize(options.onEvent, {
        status: "completed",
        taskId,
        backend,
        text: `Generated ${execution.artifacts.length} image(s).`,
        effectiveModel: execution.model.model,
        reasoningEffort: execution.model.reasoning,
        artifacts: execution.artifacts,
        usage: execution.usage,
      });
    }
    const execution = await executeSdkImage(taskId, options);
    return finalize(options.onEvent, completedFromSdk(taskId, execution, options.model));
  } catch (error) {
    return finalize(options.onEvent, failedResult(taskId, backend, error));
  }
}

async function executeSdkImage(taskId: string, options: ImageOptions): Promise<SdkExecution> {
  const validated = validateImageOptions(options);
  const expected = Array.from({ length: validated.count }, (_, index) =>
    outputPathForImage(taskId, options.output, index, validated.count),
  );
  for (const target of expected) {
    if (existsSync(target.path) && !validated.overwrite) {
      throw usageError(`output already exists: ${target.path}; pass --overwrite to replace it`);
    }
    ensureDir(dirname(target.path));
  }
  const config = loadConfig({ sdkTimeoutMs: options.timeoutMs, codexHome: options.codexHome });
  const text = [
    "Use the $imagegen skill to generate or edit images for the request below.",
    `Generate exactly ${validated.count} image(s).`,
    `Requested size=${validated.size}, quality=${validated.quality}, background=${validated.background}.`,
    `Copy the final PNG files to these exact absolute paths:\n${expected.map((item) => `- ${item.path}`).join("\n")}`,
    "Only report those paths in artifacts after verifying the files exist.",
    "Image request:",
    options.prompt,
  ].join("\n\n");
  const input: Input = [
    { type: "text", text: buildWorkspacePrompt(text, options.instructions, true) },
    ...validated.imagePaths.map((path) => ({ type: "local_image" as const, path })),
  ];
  const execution = await runSdkTurn({
    taskId,
    prompt: input,
    workingDirectory: resolveWorkingDirectory(options.workingDirectory),
    sandboxMode: "danger-full-access",
    networkAccess: true,
    noFollowup: true,
    model: options.model,
    reasoning: options.reasoning,
    timeoutMs: config.sdkTimeoutMs,
    signal: options.signal,
    onEvent: options.onEvent,
  });
  const artifacts: Artifact[] = [];
  for (const target of expected) {
    if (!existsSync(target.path)) {
      throw new CodexTaskError("SDK_IMAGE_MISSING", `Codex SDK did not create ${target.path}`);
    }
    artifacts.push({
      path: target.path,
      kind: "image",
      mimeType: "image/png",
      sizeBytes: statSync(target.path).size,
      expiresAt: target.temporary ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined,
    });
  }
  return { ...execution, artifacts };
}

export async function runTask(options: WorkspaceTaskOptions): Promise<TaskResult> {
  opportunisticGc();
  const taskId = randomUUID();
  emit(options.onEvent, { type: "started", taskId, backend: "sdk", kind: "task" });
  try {
    if (options.backend !== "sdk") throw usageError("workspace task requires --backend sdk");
    const config = loadConfig({ sdkTimeoutMs: options.timeoutMs, codexHome: options.codexHome });
    const workingDirectory = resolveWorkingDirectory(options.workingDirectory);
    const execution = await runSdkTurn({
      taskId,
      prompt: buildWorkspacePrompt(options.prompt, options.instructions, options.noFollowup ?? false),
      workingDirectory,
      sandboxMode: options.sandboxMode ?? "danger-full-access",
      networkAccess: options.networkAccess ?? true,
      noFollowup: options.noFollowup ?? false,
      model: options.model,
      reasoning: options.reasoning,
      timeoutMs: config.sdkTimeoutMs,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    const result = await resultFromSdkTask(taskId, execution, options, workingDirectory);
    return finalize(options.onEvent, result);
  } catch (error) {
    return finalize(options.onEvent, failedResult(taskId, "sdk", error));
  }
}

async function resultFromSdkTask(
  taskId: string,
  execution: SdkExecution,
  options: WorkspaceTaskOptions,
  workingDirectory: string,
): Promise<TaskResult> {
  const base = {
    taskId,
    backend: "sdk" as const,
    threadId: execution.threadId,
    text: execution.text,
    effectiveModel: options.model,
    reasoningEffort: options.reasoning,
    artifacts: reportedArtifacts(execution),
    changes: execution.changes,
    commands: execution.commands,
    usage: execution.usage,
  };
  if (execution.status === "needs_input") {
    await savePendingTask({
      taskId,
      threadId: execution.threadId,
      workingDirectory,
      createdAt: new Date().toISOString(),
      sandboxMode: options.sandboxMode ?? "danger-full-access",
      networkAccess: options.networkAccess ?? true,
      model: options.model,
      reasoning: options.reasoning,
      noFollowup: options.noFollowup ?? false,
    });
    return { ...base, status: "needs_input", questions: execution.questions } as NeedsInputResult;
  }
  if (execution.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { code: "SDK_TASK_REPORTED_FAILURE", message: execution.text, retryable: false },
    } as FailedResult;
  }
  return { ...base, status: "completed" } as CompletedResult;
}

export async function resumeTask(options: ResumeTaskOptions): Promise<TaskResult> {
  opportunisticGc();
  const stored = loadPendingTask(options.taskId);
  emit(options.onEvent, { type: "started", taskId: stored.taskId, backend: "sdk", kind: "resume" });
  try {
    const config = loadConfig({ sdkTimeoutMs: options.timeoutMs, codexHome: options.codexHome });
    const noFollowup = options.noFollowup ?? stored.noFollowup;
    const execution = await runSdkTurn({
      taskId: stored.taskId,
      threadId: stored.threadId,
      prompt: buildWorkspacePrompt(`Caller answer:\n${options.answer}\n\nContinue the delegated task.`, options.instructions, noFollowup),
      workingDirectory: stored.workingDirectory,
      sandboxMode: stored.sandboxMode,
      networkAccess: stored.networkAccess,
      noFollowup,
      model: options.model ?? stored.model,
      reasoning: options.reasoning ?? stored.reasoning,
      timeoutMs: config.sdkTimeoutMs,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    const taskOptions: WorkspaceTaskOptions = {
      prompt: options.answer,
      backend: "sdk",
      workingDirectory: stored.workingDirectory,
      sandboxMode: stored.sandboxMode,
      networkAccess: stored.networkAccess,
      noFollowup,
      model: options.model ?? stored.model,
      reasoning: options.reasoning ?? stored.reasoning,
    };
    const result = await resultFromSdkTask(stored.taskId, execution, taskOptions, stored.workingDirectory);
    if (result.status !== "needs_input") deletePendingTask(stored.taskId);
    return finalize(options.onEvent, result);
  } catch (error) {
    return finalize(options.onEvent, failedResult(stored.taskId, "sdk", error));
  }
}

function completedFromSdk(taskId: string, execution: SdkExecution, effectiveModel?: string): CompletedResult {
  if (execution.status !== "completed") {
    throw new CodexTaskError("SDK_TASK_INCOMPLETE", execution.text || "SDK task did not complete", {
      details: execution.questions,
    });
  }
  return {
    status: "completed",
    taskId,
    backend: "sdk",
    threadId: execution.threadId,
    text: execution.text,
    effectiveModel,
    artifacts: reportedArtifacts(execution),
    changes: execution.changes,
    commands: execution.commands,
    usage: execution.usage,
  };
}

export async function* streamTaskEvents(request: TaskRequest): AsyncGenerator<TaskEvent> {
  const queue = new EventQueue();
  const original = request.options.onEvent;
  const onEvent = (event: TaskEvent): void => {
    original?.(event);
    queue.push(event);
  };
  const promise = dispatch({
    ...request,
    options: { ...request.options, onEvent },
  } as TaskRequest).finally(() => queue.close());
  for await (const event of queue) yield event;
  await promise;
}

export function dispatch(request: TaskRequest): Promise<TaskResult> {
  switch (request.kind) {
    case "text":
      return generateText(request.options);
    case "image":
      return generateImage(request.options);
    case "task":
      return runTask(request.options);
    case "resume":
      return resumeTask(request.options);
  }
}
