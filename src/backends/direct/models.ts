import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "../../errors.js";
import type { ReasoningEffort } from "../../types.js";

interface CachedReasoningLevel {
  effort: ReasoningEffort;
}

interface CachedModel {
  slug: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  use_responses_lite?: boolean;
  supported_reasoning_levels?: CachedReasoningLevel[];
}

interface ModelCache {
  models?: CachedModel[];
}

export interface ResolvedDirectModel {
  model: string;
  useResponsesLite: boolean;
  reasoning: ReasoningEffort;
  supportedReasoning: ReasoningEffort[];
  source: "explicit" | "codex-config" | "model-cache" | "fallback";
}

function readModelCache(codexHome: string): CachedModel[] {
  try {
    const path = join(codexHome, "models_cache.json");
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, "utf8")) as ModelCache).models ?? [];
  } catch {
    return [];
  }
}

function readConfiguredModel(codexHome: string): string | undefined {
  try {
    const path = join(codexHome, "config.toml");
    if (!existsSync(path)) return undefined;
    const match = readFileSync(path, "utf8").match(/^model\s*=\s*["']([^"']+)["']/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function modelInfo(model: string, models: CachedModel[]): CachedModel | undefined {
  return models.find((entry) => entry.slug === model);
}

function heuristicLite(model: string): boolean {
  return model === "gpt-5.6-sol";
}

export function resolveDirectModel(
  codexHome: string,
  explicitModel: string | undefined,
  requestedReasoning: ReasoningEffort = "medium",
): ResolvedDirectModel {
  const models = readModelCache(codexHome);
  const configured = readConfiguredModel(codexHome);
  const preferred = [...models]
    .filter((entry) => entry.visibility === "list" && entry.supported_in_api !== false)
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))[0];

  let model: string;
  let source: ResolvedDirectModel["source"];
  if (explicitModel) {
    model = explicitModel;
    source = "explicit";
  } else if (configured) {
    model = configured;
    source = "codex-config";
  } else if (preferred) {
    model = preferred.slug;
    source = "model-cache";
  } else {
    model = "gpt-5.6-sol";
    source = "fallback";
  }

  const info = modelInfo(model, models);
  const supportedReasoning = info?.supported_reasoning_levels?.map((entry) => entry.effort) ?? [
    "low",
    "medium",
    "high",
  ];
  if (!supportedReasoning.includes(requestedReasoning)) {
    throw usageError(
      `reasoning ${requestedReasoning} is not supported by ${model}; choose ${supportedReasoning.join(", ")}`,
    );
  }
  return {
    model,
    useResponsesLite: info?.use_responses_lite ?? heuristicLite(model),
    reasoning: requestedReasoning,
    supportedReasoning,
    source,
  };
}

export function resolveDirectImageModel(
  codexHome: string,
  explicitModel: string | undefined,
  requestedReasoning: ReasoningEffort = "medium",
): { model: ResolvedDirectModel; replacedLiteModel?: string | undefined } {
  const selected = resolveDirectModel(codexHome, explicitModel, requestedReasoning);
  if (!selected.useResponsesLite) return { model: selected };
  return {
    model: resolveDirectModel(codexHome, "gpt-5.5", requestedReasoning),
    replacedLiteModel: selected.model,
  };
}
