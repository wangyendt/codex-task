import { CodexTaskError } from "../../errors.js";

export interface DirectSelection {
  model: string;
  reasoning: string;
  imageModel?: string | undefined;
}

interface UpstreamError {
  message: string;
  code?: string | undefined;
  param?: string | undefined;
}

/** Classify only explicit selection rejection; unrelated 400s are not model failures. */
export function selectionRejection(error: UpstreamError, selection?: DirectSelection): CodexTaskError | undefined {
  const { message } = error;
  const param = error.param?.toLowerCase() ?? "";
  if (/(?:^|[.\]])(?:size|quality|background|output_format|action|image_url|prompt)$/.test(param)) return undefined;
  if (!/unsupported|not supported|does not support|not available|does not exist|not found|invalid value|invalid model|not allowed/i.test(message)
      && error.code !== "model_not_found" && error.code !== "unsupported_model") return undefined;
  let code: string;
  if (param.includes("reasoning") || /(?:reasoning|effort).*(?:unsupported|not supported|invalid|not allowed)/i.test(message)) {
    code = "DIRECT_UNSUPPORTED_REASONING";
  } else if ((param.includes("tools") || param.includes("image")) && param.includes("model")) {
    code = "DIRECT_UNSUPPORTED_IMAGE_MODEL";
  } else if (/image_generation|image generation|hosted tool/i.test(message)) {
    code = "DIRECT_UNSUPPORTED_IMAGE_COMBINATION";
  } else if (param === "model" || error.code === "model_not_found" || error.code === "unsupported_model" || /(?:model).*(?:unsupported|not supported|not available|not found|does not exist)|unsupported.*model/i.test(message)) {
    code = "DIRECT_UNSUPPORTED_MODEL";
  } else return undefined;
  const supported = message.split(/supported values (?:are|include)\s*:?/i)[1];
  const supportedReasoning = code === "DIRECT_UNSUPPORTED_REASONING" && supported
    ? [...supported.matchAll(/['"]([a-z][a-z0-9_-]{0,31})['"]/g)].map(match => match[1])
    : undefined;
  const summary = code === "DIRECT_UNSUPPORTED_REASONING" ? "Upstream does not support the requested reasoning effort"
    : code === "DIRECT_UNSUPPORTED_MODEL" ? "Upstream does not support the requested main model"
    : code === "DIRECT_UNSUPPORTED_IMAGE_MODEL" ? "Upstream does not support the requested image tool model"
    : "Upstream does not support image generation with the requested combination";
  return new CodexTaskError(code, summary, {
    retryable: false,
    details: { ...selection, ...(error.code ? { upstreamCode: error.code } : {}), ...(error.param ? { upstreamParam: error.param } : {}), ...(supportedReasoning?.length ? { supportedReasoning } : {}) },
  });
}

export function upstreamError(body: string): UpstreamError | undefined {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; param?: unknown } };
    const error = value.error;
    if (typeof error?.message !== "string") return undefined;
    return { message: error.message, ...(typeof error.code === "string" ? { code: error.code } : {}), ...(typeof error.param === "string" ? { param: error.param } : {}) };
  } catch { return undefined; }
}
