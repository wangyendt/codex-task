import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DirectIdentity } from "./identity.js";
import { buildUserAgent, platformSandboxTag } from "./identity.js";
import type { ResolvedDirectModel } from "./models.js";
import { imageMimeType, type ValidatedImageOptions } from "../../images.js";

export const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const TEXT_INSTRUCTIONS = `You are a focused single-turn task worker called by another AI agent.
Return the requested deliverable directly with minimal ceremony.
You do not have access to the caller's local shell, files, MCP servers, or skills.
Never claim that you executed local tools or changed local files.
If the request is underspecified, make a reasonable assumption and state it briefly.`;

const IMAGE_INSTRUCTIONS = `You are a focused image-generation worker called by another AI agent.
Use the provided image_generation tool to produce the requested image.
When reference images are present, preserve the user's requested identity, composition, and constraints.
Do not return a prose-only answer when image generation is requested.`;

interface TurnContext {
  turnId: string;
  sessionId: string;
  threadId: string;
  windowId: string;
  timestampMs: number;
}

export interface DirectRequestContext {
  accessToken: string;
  accountId: string;
  identity: DirectIdentity;
  sessionId: string;
  threadId: string;
}

export interface DirectRequestSpec {
  kind: "text" | "image";
  prompt: string;
  imagePaths?: string[] | undefined;
  instructions?: string | undefined;
  model: ResolvedDirectModel;
  outputSchema?: Record<string, unknown> | undefined;
  imageOptions?: ValidatedImageOptions | undefined;
}

function turnContext(context: DirectRequestContext): TurnContext {
  return {
    turnId: randomUUID(),
    sessionId: context.sessionId,
    threadId: context.threadId,
    windowId: `${context.threadId}:0`,
    timestampMs: Date.now(),
  };
}

function turnMetadata(turn: TurnContext): string {
  return JSON.stringify({
    turn_id: turn.turnId,
    turn_started_at_unix_ms: turn.timestampMs,
    session_id: turn.sessionId,
    thread_id: turn.threadId,
    sandbox: platformSandboxTag(),
    request_kind: "turn",
    window_id: turn.windowId,
    workspace_kind: "local",
    has_changes: false,
  });
}

function imageTool(options: ValidatedImageOptions): Record<string, unknown> {
  return {
    type: "image_generation",
    ...(options.size !== "auto" ? { size: options.size } : {}),
    ...(options.quality !== "auto" ? { quality: options.quality } : {}),
    ...(options.background !== "auto" ? { background: options.background } : {}),
  };
}

function userContent(spec: DirectRequestSpec): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: spec.prompt }];
  for (const path of spec.imagePaths ?? spec.imageOptions?.imagePaths ?? []) {
    const mimeType = imageMimeType(path);
    content.push({
      type: "input_image",
      image_url: `data:${mimeType};base64,${readFileSync(path).toString("base64")}`,
    });
  }
  return content;
}

function textConfig(spec: DirectRequestSpec): Record<string, unknown> {
  return {
    verbosity: "low",
    ...(spec.outputSchema
      ? {
          format: {
            type: "json_schema",
            name: "codex_task_result",
            strict: true,
            schema: spec.outputSchema,
          },
        }
      : {}),
  };
}

export function buildDirectRequest(
  context: DirectRequestContext,
  spec: DirectRequestSpec,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const turn = turnContext(context);
  const instructions = [spec.kind === "image" ? IMAGE_INSTRUCTIONS : TEXT_INSTRUCTIONS, spec.instructions]
    .filter(Boolean)
    .join("\n\n");
  const tools = spec.kind === "image" && spec.imageOptions ? [imageTool(spec.imageOptions)] : [];
  const userMessage = { type: "message", role: "user", content: userContent(spec) };
  const base = {
    model: spec.model.model,
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    store: false,
    reasoning: {
      effort: spec.model.reasoning,
      ...(spec.model.useResponsesLite ? { context: "all_turns" } : {}),
    },
    text: textConfig(spec),
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: context.threadId,
    client_metadata: { "x-codex-installation-id": context.identity.installationId },
  };
  const body = spec.model.useResponsesLite
    ? {
        ...base,
        instructions: "",
        input: [
          { type: "additional_tools", role: "developer", tools },
          { type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] },
          userMessage,
        ],
      }
    : {
        ...base,
        instructions,
        input: [userMessage],
        tools,
      };

  return {
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      ...(context.accountId ? { "ChatGPT-Account-Id": context.accountId } : {}),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "OpenAI-Beta": "responses_websockets=2026-02-06",
      originator: "codex_cli_rs",
      "User-Agent": buildUserAgent(context.identity),
      "OAI-Product-Sku": "codex",
      "x-codex-installation-id": context.identity.installationId,
      "x-codex-window-id": turn.windowId,
      "x-responses": "api-include-timing-metrics",
      "session-id": turn.sessionId,
      "thread-id": turn.threadId,
      "x-client-request-id": turn.turnId,
      "x-codex-turn-metadata": turnMetadata(turn),
      ...(spec.model.useResponsesLite ? { "x-openai-internal-codex-responses-lite": "true" } : {}),
    },
    body,
  };
}
