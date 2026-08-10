import { existsSync, readFileSync } from "node:fs";
import type { ReasoningEffort } from "./types.js";
import { appPaths, defaultCodexHome, legacyAppPaths } from "./paths.js";
import { CodexRunError } from "./errors.js";

export interface UserConfig {
  codexHome?: string | undefined;
  directModel?: string | undefined;
  directReasoning?: ReasoningEffort | undefined;
  directTextTimeoutMs?: number | undefined;
  directImageTimeoutMs?: number | undefined;
  sdkTimeoutMs?: number | undefined;
  retries?: number | undefined;
  proxy?: string | undefined;
  tempTtlMs?: number | undefined;
  pendingTaskTtlMs?: number | undefined;
  tempMaxBytes?: number | undefined;
}

export interface ResolvedConfig {
  codexHome: string;
  directModel?: string | undefined;
  directReasoning: ReasoningEffort;
  directTextTimeoutMs: number;
  directImageTimeoutMs: number;
  sdkTimeoutMs: number;
  retries: number;
  proxy?: string | undefined;
  tempTtlMs: number;
  pendingTaskTtlMs: number;
  tempMaxBytes: number;
}

const DEFAULT_CONFIG: ResolvedConfig = {
  codexHome: defaultCodexHome(),
  directReasoning: "medium",
  directTextTimeoutMs: 10 * 60 * 1000,
  directImageTimeoutMs: 15 * 60 * 1000,
  sdkTimeoutMs: 30 * 60 * 1000,
  retries: 3,
  tempTtlMs: 24 * 60 * 60 * 1000,
  pendingTaskTtlMs: 7 * 24 * 60 * 60 * 1000,
  tempMaxBytes: 1024 * 1024 * 1024,
};

function readUserConfig(): UserConfig {
  const path = [appPaths().configPath, legacyAppPaths().configPath].find((candidate) => existsSync(candidate));
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UserConfig;
  } catch (error) {
    throw new CodexRunError("INVALID_CONFIG", `Could not parse ${path}`, {
      exitCode: 2,
      cause: error,
    });
  }
}

function envValue(name: string, legacyName: string): string | undefined {
  return process.env[name] ?? process.env[legacyName];
}

function envNumber(name: string, legacyName: string): number | undefined {
  const raw = envValue(name, legacyName);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CodexRunError("INVALID_CONFIG", `${name} must be a non-negative number`, {
      exitCode: 2,
    });
  }
  return value;
}

export function loadConfig(overrides: UserConfig = {}): ResolvedConfig {
  const user = readUserConfig();
  const env: UserConfig = {
    codexHome: envValue("CODEXRUN_CODEX_HOME", "CODEXERRAND_CODEX_HOME"),
    directModel: envValue("CODEXRUN_MODEL", "CODEXERRAND_MODEL"),
    directReasoning: envValue("CODEXRUN_REASONING", "CODEXERRAND_REASONING") as ReasoningEffort | undefined,
    directTextTimeoutMs: envNumber("CODEXRUN_TEXT_TIMEOUT_MS", "CODEXERRAND_TEXT_TIMEOUT_MS"),
    directImageTimeoutMs: envNumber("CODEXRUN_IMAGE_TIMEOUT_MS", "CODEXERRAND_IMAGE_TIMEOUT_MS"),
    sdkTimeoutMs: envNumber("CODEXRUN_SDK_TIMEOUT_MS", "CODEXERRAND_SDK_TIMEOUT_MS"),
    retries: envNumber("CODEXRUN_RETRIES", "CODEXERRAND_RETRIES"),
    proxy: envValue("CODEXRUN_PROXY", "CODEXERRAND_PROXY"),
    tempTtlMs: envNumber("CODEXRUN_TEMP_TTL_MS", "CODEXERRAND_TEMP_TTL_MS"),
    pendingTaskTtlMs: envNumber("CODEXRUN_PENDING_TTL_MS", "CODEXERRAND_PENDING_TTL_MS"),
    tempMaxBytes: envNumber("CODEXRUN_TEMP_MAX_BYTES", "CODEXERRAND_TEMP_MAX_BYTES"),
  };

  const merged: UserConfig = { ...DEFAULT_CONFIG, ...user, ...stripUndefined(env), ...stripUndefined(overrides) };
  return {
    codexHome: merged.codexHome ?? DEFAULT_CONFIG.codexHome,
    directModel: merged.directModel,
    directReasoning: merged.directReasoning ?? DEFAULT_CONFIG.directReasoning,
    directTextTimeoutMs: merged.directTextTimeoutMs ?? DEFAULT_CONFIG.directTextTimeoutMs,
    directImageTimeoutMs: merged.directImageTimeoutMs ?? DEFAULT_CONFIG.directImageTimeoutMs,
    sdkTimeoutMs: merged.sdkTimeoutMs ?? DEFAULT_CONFIG.sdkTimeoutMs,
    retries: merged.retries ?? DEFAULT_CONFIG.retries,
    proxy: merged.proxy,
    tempTtlMs: merged.tempTtlMs ?? DEFAULT_CONFIG.tempTtlMs,
    pendingTaskTtlMs: merged.pendingTaskTtlMs ?? DEFAULT_CONFIG.pendingTaskTtlMs,
    tempMaxBytes: merged.tempMaxBytes ?? DEFAULT_CONFIG.tempMaxBytes,
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
