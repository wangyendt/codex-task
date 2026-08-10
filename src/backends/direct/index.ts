import { randomUUID } from "node:crypto";
import { ensureDirectAuth } from "./auth.js";
import { loadOrCreateIdentity } from "./identity.js";
import { resolveDirectImageModel, resolveDirectModel, type ResolvedDirectModel } from "./models.js";
import { buildDirectRequest, RESPONSES_URL, type DirectRequestSpec } from "./protocol.js";
import { ImpersonatedSession } from "./http.js";
import { parseDirectResponse, type ParsedDirectResponse } from "./sse.js";
import { loadConfig } from "../../config.js";
import { CodexRunError, isAbortError } from "../../errors.js";
import { validateImageOptions, writePngArtifact } from "../../images.js";
import type { Artifact, ImageOptions, TaskEvent, TextOptions, UsageSummary } from "../../types.js";

export interface DirectTextExecution {
  text: string;
  model: ResolvedDirectModel;
  usage?: UsageSummary | undefined;
}

export interface DirectImageExecution {
  artifacts: Artifact[];
  model: ResolvedDirectModel;
  usage?: UsageSummary | undefined;
}

function emit(callback: ((event: TaskEvent) => void) | undefined, event: TaskEvent): void {
  callback?.(event);
}

function mapHttpError(status: number, body: string): CodexRunError {
  const detail = body.slice(0, 500);
  if (status === 401 || status === 403) {
    return new CodexRunError("DIRECT_AUTH_FAILED", `Direct authentication failed with HTTP ${status}`, {
      details: detail,
    });
  }
  if (status === 429) {
    return new CodexRunError("DIRECT_RATE_LIMITED", "Direct backend is rate limited", {
      retryable: true,
      details: detail,
    });
  }
  if (status >= 500) {
    return new CodexRunError("DIRECT_SERVER_ERROR", `Direct backend returned HTTP ${status}`, {
      retryable: true,
      details: detail,
    });
  }
  if (status === 400) {
    return new CodexRunError("DIRECT_REQUEST_REJECTED", "Direct backend rejected the request", {
      details: detail,
    });
  }
  return new CodexRunError("DIRECT_HTTP_ERROR", `Direct backend returned HTTP ${status}`, {
    retryable: status === 0,
    details: detail,
  });
}

function normalizeDirectError(error: unknown): CodexRunError {
  if (error instanceof CodexRunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryable = /timeout|timed out|econnreset|socket|network|empty response/i.test(message);
  return new CodexRunError("DIRECT_TRANSPORT_ERROR", message, { retryable, cause: error });
}

async function sendOnce(
  context: Parameters<typeof buildDirectRequest>[0],
  spec: DirectRequestSpec,
  timeoutMs: number,
  proxy: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ParsedDirectResponse> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const session = new ImpersonatedSession(timeoutMs, proxy);
  const abort = (): void => session.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const request = buildDirectRequest(context, spec);
    const response = await session.post(RESPONSES_URL, request.headers, JSON.stringify(request.body));
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (response.status !== 200) throw mapHttpError(response.status, response.text);
    const parsed = parseDirectResponse(response.text);
    if (!parsed.text && !parsed.image) {
      throw new CodexRunError("DIRECT_EMPTY_RESPONSE", "Direct backend returned an empty response", {
        retryable: true,
      });
    }
    return parsed;
  } finally {
    signal?.removeEventListener("abort", abort);
    session.close();
  }
}

async function sendWithRetry(
  taskId: string,
  context: Parameters<typeof buildDirectRequest>[0],
  spec: DirectRequestSpec,
  timeoutMs: number,
  retries: number,
  proxy: string | undefined,
  signal: AbortSignal | undefined,
  onEvent: ((event: TaskEvent) => void) | undefined,
): Promise<ParsedDirectResponse> {
  const delays = [2_000, 6_000, 15_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sendOnce(context, spec, timeoutMs, proxy, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const normalized = normalizeDirectError(error);
      if (!normalized.retryable || attempt >= retries) throw normalized;
      const delayMs = delays[Math.min(attempt, delays.length - 1)] ?? 15_000;
      emit(onEvent, { type: "retrying", taskId, attempt: attempt + 1, delayMs, error: normalized.message });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function contextForRequest(
  codexHome: string,
  proxy: string | undefined,
): Promise<Parameters<typeof buildDirectRequest>[0]> {
  const auth = await ensureDirectAuth(codexHome, proxy);
  return {
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    identity: loadOrCreateIdentity(codexHome),
    sessionId: randomUUID(),
    threadId: randomUUID(),
  };
}

export async function executeDirectText(taskId: string, options: TextOptions): Promise<DirectTextExecution> {
  const config = loadConfig({
    codexHome: options.codexHome,
    directModel: options.model,
    directReasoning: options.reasoning,
    directTextTimeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  const model = resolveDirectModel(config.codexHome, config.directModel, config.directReasoning);
  const context = await contextForRequest(config.codexHome, config.proxy);
  const response = await sendWithRetry(
    taskId,
    context,
    {
      kind: "text",
      prompt: options.prompt,
      instructions: options.instructions,
      model,
      outputSchema: options.outputSchema,
    },
    config.directTextTimeoutMs,
    config.retries,
    config.proxy,
    options.signal,
    options.onEvent,
  );
  if (!response.text) {
    throw new CodexRunError("DIRECT_EMPTY_TEXT", "Direct backend returned no text", { retryable: true });
  }
  return { text: response.text, model, usage: response.usage };
}

export async function executeDirectImage(taskId: string, options: ImageOptions): Promise<DirectImageExecution> {
  const validated = validateImageOptions(options);
  const config = loadConfig({
    codexHome: options.codexHome,
    directModel: options.model,
    directReasoning: options.reasoning,
    directImageTimeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  const resolution = resolveDirectImageModel(config.codexHome, config.directModel, config.directReasoning);
  const model = resolution.model;
  if (resolution.replacedLiteModel) {
    emit(options.onEvent, {
      type: "progress",
      taskId,
      message: `${resolution.replacedLiteModel} uses Responses Lite, which cannot expose hosted image_generation; using ${model.model} before sending the request`,
    });
  }
  const context = await contextForRequest(config.codexHome, config.proxy);
  const artifacts: Artifact[] = [];
  const usage: UsageSummary = {};
  let nextIndex = 0;

  const worker = async (workerContext: typeof context): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= validated.count) return;
      try {
        emit(options.onEvent, {
          type: "progress",
          taskId,
          message: `Generating image ${index + 1}/${validated.count}`,
        });
        const response = await sendWithRetry(
          taskId,
          workerContext,
          {
            kind: "image",
            prompt: options.prompt,
            instructions: options.instructions,
            model,
            imageOptions: validated,
          },
          config.directImageTimeoutMs,
          config.retries,
          config.proxy,
          options.signal,
          options.onEvent,
        );
        if (!response.image) {
          throw new CodexRunError("DIRECT_EMPTY_IMAGE", "Direct backend returned no image", {
            retryable: !response.text,
            details: response.text ? { text: response.text } : undefined,
          });
        }
        const artifact = writePngArtifact(
          taskId,
          response.image,
          options.output,
          index,
          validated.count,
          validated.overwrite,
        );
        artifacts[index] = artifact;
        emit(options.onEvent, { type: "artifact", taskId, artifact });
        if (response.usage?.inputTokens) usage.inputTokens = (usage.inputTokens ?? 0) + response.usage.inputTokens;
        if (response.usage?.outputTokens) usage.outputTokens = (usage.outputTokens ?? 0) + response.usage.outputTokens;
      } catch (error) {
        const normalized = normalizeDirectError(error);
        throw new CodexRunError(normalized.code, normalized.message, {
          retryable: normalized.retryable,
          exitCode: normalized.exitCode,
          details: { upstream: normalized.details, artifacts: artifacts.filter(Boolean) },
          cause: normalized,
        });
      }
    }
  };

  const workerCount = Math.min(validated.concurrency, validated.count);
  const contexts = Array.from({ length: workerCount }, () => ({
    ...context,
    sessionId: randomUUID(),
    threadId: randomUUID(),
  }));
  await Promise.all(contexts.map((workerContext) => worker(workerContext)));
  return { artifacts: artifacts.filter(Boolean), model, usage };
}
