import {
  Codex,
  type Input,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { resolve } from "node:path";
import { CodexRunError, usageError } from "../errors.js";
import type {
  Artifact,
  CommandSummary,
  ReasoningEffort,
  TaskEvent,
  UsageSummary,
  WorkspaceTaskOptions,
} from "../types.js";

interface StructuredWorkspaceResponse {
  status: "completed" | "needs_input" | "failed";
  text: string;
  questions: string[];
  artifacts: string[];
}

export interface SdkExecution {
  status: StructuredWorkspaceResponse["status"];
  text: string;
  questions: string[];
  threadId: string;
  changes: string[];
  commands: CommandSummary[];
  artifacts: Artifact[];
  reportedArtifacts: string[];
  usage?: UsageSummary | undefined;
}

interface ThreadLike {
  readonly id: string | null;
  runStreamed(
    input: Input,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}

export interface RunSdkTurnOptions {
  taskId: string;
  prompt: Input;
  workingDirectory: string;
  sandboxMode: WorkspaceTaskOptions["sandboxMode"];
  networkAccess: boolean;
  noFollowup: boolean;
  model?: string | undefined;
  reasoning?: ReasoningEffort | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: TaskEvent) => void) | undefined;
  threadId?: string | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  codex?: CodexLike | undefined;
  structuredResponse?: boolean | undefined;
}

const WORKSPACE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "needs_input", "failed"] },
    text: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: { type: "string" } },
  },
  required: ["status", "text", "questions", "artifacts"],
  additionalProperties: false,
};

function workspaceInstructions(noFollowup: boolean): string {
  const interaction = noFollowup
    ? "Do not ask follow-up questions. Make reasonable assumptions. Return failed only if the task is impossible."
    : "If a critical ambiguity prevents safe completion, stop and return needs_input with concise questions. Do not call request_user_input because exec mode cannot handle it.";
  return `You are a focused Codex worker executing a task delegated by another AI agent.
Use the available local tools and project instructions to complete the requested work.
${interaction}
At the end, return only the JSON object required by the output schema.
Use status=completed when the task is done, needs_input only when caller input is required, and failed when the task cannot be completed.
Put a concise handoff in text, keep questions empty unless status=needs_input, and list absolute paths for durable output files in artifacts.`;
}

function sdkReasoning(reasoning: ReasoningEffort | undefined): "low" | "medium" | "high" | "xhigh" | undefined {
  if (reasoning === undefined) return undefined;
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high" || reasoning === "xhigh") return reasoning;
  throw usageError(`SDK backend does not support reasoning=${reasoning}; use low, medium, high, or xhigh`);
}

function threadOptions(options: RunSdkTurnOptions): ThreadOptions {
  const reasoning = sdkReasoning(options.reasoning);
  return {
    workingDirectory: options.workingDirectory,
    sandboxMode: options.sandboxMode ?? "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: options.networkAccess,
    webSearchMode: options.networkAccess ? "live" : "disabled",
    skipGitRepoCheck: true,
    ...(options.model ? { model: options.model } : {}),
    ...(reasoning ? { modelReasoningEffort: reasoning } : {}),
  };
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Task timed out", "TimeoutError")), timeoutMs);
  const abort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function collectItem(
  item: ThreadItem,
  changes: Set<string>,
  commands: Map<string, CommandSummary>,
): string | undefined {
  if (item.type === "file_change" && item.status === "completed") {
    for (const change of item.changes) changes.add(change.path);
  }
  if (item.type === "command_execution") {
    commands.set(item.id, { command: item.command, exitCode: item.exit_code, status: item.status });
  }
  return item.type === "agent_message" ? item.text : undefined;
}

function parseStructuredResponse(text: string, noFollowup: boolean): StructuredWorkspaceResponse {
  let parsed: StructuredWorkspaceResponse;
  try {
    parsed = JSON.parse(text) as StructuredWorkspaceResponse;
  } catch (error) {
    throw new CodexRunError("SDK_INVALID_RESPONSE", "Codex SDK returned invalid structured output", {
      details: text.slice(0, 1000),
      cause: error,
    });
  }
  if (!parsed || !["completed", "needs_input", "failed"].includes(parsed.status)) {
    throw new CodexRunError("SDK_INVALID_RESPONSE", "Codex SDK returned an invalid task status");
  }
  if (noFollowup && parsed.status === "needs_input") {
    throw new CodexRunError("FOLLOWUP_FORBIDDEN", "Codex requested input while --no-followup was enabled");
  }
  return parsed;
}

export async function runSdkTurn(options: RunSdkTurnOptions): Promise<SdkExecution> {
  const codex = options.codex ?? new Codex();
  const thread = options.threadId
    ? codex.resumeThread(options.threadId, threadOptions(options))
    : codex.startThread(threadOptions(options));
  const controlled = timeoutSignal(options.timeoutMs, options.signal);
  const changes = new Set<string>();
  const commands = new Map<string, CommandSummary>();
  let finalResponse = "";
  let usage: UsageSummary | undefined;

  try {
    const streamed = await thread.runStreamed(options.prompt, {
      outputSchema: options.outputSchema ?? WORKSPACE_SCHEMA,
      signal: controlled.signal,
    });
    for await (const event of streamed.events) {
      handleSdkEvent(options, event);
      if (event.type === "item.completed") {
        const message = collectItem(event.item, changes, commands);
        if (message !== undefined) finalResponse = message;
      } else if (event.type === "turn.completed") {
        usage = {
          inputTokens: event.usage.input_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
          outputTokens: event.usage.output_tokens,
        };
      } else if (event.type === "turn.failed") {
        throw new CodexRunError("SDK_TURN_FAILED", event.error.message);
      } else if (event.type === "error") {
        throw new CodexRunError("SDK_EVENT_ERROR", event.message);
      }
    }
  } catch (error) {
    if (controlled.signal.aborted) {
      const timedOut = !options.signal?.aborted;
      throw new CodexRunError(timedOut ? "TIMEOUT" : "CANCELLED", timedOut ? "SDK task timed out" : "SDK task cancelled", {
        exitCode: 130,
        cause: error,
      });
    }
    throw error;
  } finally {
    controlled.dispose();
  }

  const threadId = thread.id;
  if (!threadId) throw new CodexRunError("SDK_THREAD_MISSING", "Codex SDK did not return a thread id");
  const structured =
    options.structuredResponse === false
      ? { status: "completed" as const, text: finalResponse, questions: [], artifacts: [] }
      : parseStructuredResponse(finalResponse, options.noFollowup);
  return {
    ...structured,
    threadId,
    changes: [...changes],
    commands: [...commands.values()],
    artifacts: [],
    reportedArtifacts: structured.artifacts,
    usage,
  };
}

function handleSdkEvent(options: RunSdkTurnOptions, event: ThreadEvent): void {
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    const item = event.item;
    if (item.type === "reasoning") return;
    options.onEvent?.({
      type: "progress",
      taskId: options.taskId,
      message: `${event.type}: ${item.type}`,
      item,
    });
  }
}

export function buildWorkspacePrompt(prompt: string, instructions: string | undefined, noFollowup: boolean): string {
  return [workspaceInstructions(noFollowup), instructions, "Delegated task:", prompt].filter(Boolean).join("\n\n");
}

export function resolveWorkingDirectory(path: string | undefined): string {
  return resolve(path ?? process.cwd());
}
