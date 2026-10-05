import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";

export interface CatalogModel {
  id: string;
  displayName: string;
  reasoningLevels: string[];
  defaultReasoning: string | null;
  inputModalities: string[];
}
export interface ModelCatalog {
  source: "codex-app-server" | "codex-model-cache";
  updatedAt: string | null;
  stale: boolean;
  models: CatalogModel[];
  warning?: string;
}
const known = new Map<string, CatalogModel[]>();
export function knownCatalogModel(home: string, id: string): CatalogModel | undefined {
  return known.get(resolve(home))?.find((model) => model.id === id);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && !!item))] : [];
}
export function normalizeModels(values: unknown, cached = false): CatalogModel[] {
  if (!Array.isArray(values)) return [];
  const models = new Map<string, CatalogModel>();
  for (const value of values) {
    const item = record(value);
    if (cached ? item["visibility"] !== "list" : item["hidden"] === true) continue;
    const id = cached ? item["slug"] : item["model"] ?? item["id"];
    if (typeof id !== "string" || !id) continue;
    const efforts = item[cached ? "supported_reasoning_levels" : "supportedReasoningEfforts"];
    const levels = strings(Array.isArray(efforts) ? efforts.map((e) => record(e)[cached ? "effort" : "reasoningEffort"]) : []);
    const defaultEffort = item[cached ? "default_reasoning_level" : "defaultReasoningEffort"];
    const name = item[cached ? "display_name" : "displayName"];
    models.set(id, {
      id, displayName: typeof name === "string" ? name : id,
      reasoningLevels: levels,
      defaultReasoning: typeof defaultEffort === "string" && levels.includes(defaultEffort) ? defaultEffort : levels[0] ?? null,
      inputModalities: strings(item[cached ? "input_modalities" : "inputModalities"]),
    });
  }
  return [...models.values()];
}

/** Read metadata only: no turn/thread creation and no model inference. */
export function queryCodexModels(home: string, binary = process.env["CODEX_TASK_CODEX_BIN"] ?? "codex", timeoutMs = 20_000): Promise<CatalogModel[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, ["app-server"], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let bytes = 0;
    let finished = false;
    let requestId = 2;
    const all: unknown[] = [];
    const cursors = new Set<string>();
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
      child.once("close", () => clearTimeout(killTimer));
      if (error) reject(error);
      else resolveResult(normalizeModels(all));
    };
    const timer = setTimeout(() => finish(new Error("Model catalog query timed out")), timeoutMs);
    const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.on("error", () => finish(new Error("Codex CLI is unavailable")));
    child.stdin.on("error", () => finish(new Error("Codex catalog connection closed")));
    child.on("exit", () => { if (!finished) finish(new Error("Codex catalog process exited")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { finish(new Error("Model catalog response too large")); return; }
      buffer += chunk;
      while (buffer.includes("\n") && !finished) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = record(JSON.parse(line));
          if (message["id"] !== 1 && message["id"] !== requestId) continue;
          if (message["error"]) { finish(new Error("Codex rejected model catalog query")); return; }
          if (message["id"] === 1) {
            send({ method: "initialized" });
            send({ id: requestId, method: "model/list", params: { limit: 100 } });
          } else {
            const result = record(message["result"]);
            if (!Array.isArray(result["data"])) { finish(new Error("Invalid Codex model catalog")); return; }
            all.push(...result["data"]);
            const cursor = result["nextCursor"];
            if (typeof cursor === "string" && cursor) {
              if (cursors.has(cursor) || cursors.size >= 20) { finish(new Error("Invalid catalog pagination")); return; }
              cursors.add(cursor); requestId += 1;
              send({ id: requestId, method: "model/list", params: { limit: 100, cursor } });
            } else finish();
          }
        } catch { finish(new Error("Invalid Codex catalog JSON")); }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex_task_catalog", version: "1.0.0" } } });
  });
}

export function createModelCatalogReader(
  home = loadConfig().codexHome,
  query: (home: string) => Promise<CatalogModel[]> = queryCodexModels,
  now = Date.now,
): (refresh?: boolean) => Promise<ModelCatalog> {
  let cached: ModelCatalog | undefined;
  let checkedAt = -Infinity;
  let pending: Promise<ModelCatalog> | undefined;
  return (refresh = false) => {
    if (pending) return pending;
    // Deduplicate clients and bound manual refreshes to one process per 15 seconds.
    if (cached && now() - checkedAt < (refresh ? 15_000 : 300_000)) return Promise.resolve(cached);
    pending = (async () => {
      try {
        const models = await query(home);
        if (!models.length) throw new Error("Empty model catalog");
        cached = { source: "codex-app-server", updatedAt: new Date(now()).toISOString(), stale: false, models };
      } catch {
        if (cached?.models.length) cached = { ...cached, stale: true, warning: "Catalog refresh failed; showing last known models." };
        else {
          let disk: Record<string, unknown> = {};
          try { disk = record(JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"))); } catch { /* No usable disk catalog. */ }
          cached = {
            source: "codex-model-cache", stale: true,
            updatedAt: typeof disk["fetched_at"] === "string" ? disk["fetched_at"] : null,
            models: normalizeModels(disk["models"], true),
            warning: "Codex CLI catalog unavailable; showing cached metadata. Check Codex CLI installation, login and network.",
          };
        }
      }
      checkedAt = now();
      known.set(resolve(home), cached.models);
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
