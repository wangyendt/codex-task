import { CodexRunError } from "../../errors.js";
import type { UsageSummary } from "../../types.js";

interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

export interface ParsedDirectResponse {
  text?: string | undefined;
  image?: Buffer | undefined;
  imageSize?: string | undefined;
  usage?: UsageSummary | undefined;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as SseEvent);
    } catch {
      // Ignore keepalive and malformed non-terminal lines.
    }
  }
  return events;
}

function failureMessage(events: SseEvent[]): string | undefined {
  const event = events.find((item) => item.type === "response.failed" || item.type === "error");
  if (!event) return undefined;
  const response = event["response"] as Record<string, unknown> | undefined;
  const error =
    (event["error"] as Record<string, unknown> | undefined) ??
    (response?.["error"] as Record<string, unknown> | undefined);
  return typeof error?.["message"] === "string" ? error["message"] : "Direct response failed";
}

function extractUsage(events: SseEvent[]): UsageSummary | undefined {
  const completed = [...events].reverse().find((event) => event.type === "response.completed");
  const response = completed?.["response"] as Record<string, unknown> | undefined;
  const usage = response?.["usage"] as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    inputTokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined,
    cachedInputTokens:
      typeof usage["input_tokens_details"] === "object" && usage["input_tokens_details"]
        ? ((usage["input_tokens_details"] as Record<string, unknown>)["cached_tokens"] as number | undefined)
        : undefined,
    outputTokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
  };
}

function extractText(events: SseEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === "response.output_text.done" && typeof event["text"] === "string") return event["text"];
    if (event.type === "response.output_item.done") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] !== "message" || !Array.isArray(item["content"])) continue;
      const texts = (item["content"] as Array<Record<string, unknown>>)
        .filter((content) => content["type"] === "output_text" && typeof content["text"] === "string")
        .map((content) => content["text"] as string);
      if (texts.length) return texts.join("");
    }
  }
  const deltas = events
    .filter((event) => event.type === "response.output_text.delta" && typeof event["delta"] === "string")
    .map((event) => event["delta"] as string);
  return deltas.length ? deltas.join("") : undefined;
}

function extractImage(events: SseEvent[]): { image?: Buffer | undefined; imageSize?: string | undefined } {
  let partial: string | undefined;
  for (const event of events) {
    if (event.type === "response.output_item.done") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "image_generation_call" && typeof item["result"] === "string") {
        return {
          image: Buffer.from(item["result"], "base64"),
          imageSize: typeof item["size"] === "string" ? item["size"] : undefined,
        };
      }
    }
    if (typeof event.type === "string" && event.type.includes("partial_image")) {
      const value = event["partial_image_b64"] ?? event["result"];
      if (typeof value === "string") partial = value;
    }
  }
  return partial ? { image: Buffer.from(partial, "base64") } : {};
}

export function parseDirectResponse(text: string): ParsedDirectResponse {
  const events = parseSse(text);
  const failure = failureMessage(events);
  if (failure) throw new CodexRunError("DIRECT_RESPONSE_FAILED", failure, { retryable: false });
  return {
    text: extractText(events),
    ...extractImage(events),
    usage: extractUsage(events),
  };
}
