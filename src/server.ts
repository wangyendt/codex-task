import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { dispatch } from "./api.js";
import { asCodexTaskError } from "./errors.js";
import { ensureDir } from "./fs-utils.js";
import { appPaths } from "./paths.js";
import type { CommonOptions, ReasoningEffort, TaskRequest, TaskResult } from "./types.js";

export type RemoteTaskRunner = (request: TaskRequest) => Promise<TaskResult>;

export interface CodexTaskServerOptions {
  host?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
  maxConcurrency?: number | undefined;
  maxBodyBytes?: number | undefined;
  jobTtlMs?: number | undefined;
  run?: RemoteTaskRunner | undefined;
}

export interface RunningCodexTaskServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

type RemoteJobStatus = "queued" | "running" | TaskResult["status"];

interface RemoteJob {
  jobId: string;
  kind: TaskRequest["kind"];
  status: RemoteJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult | undefined;
  uploadDir?: string | undefined;
}

function backendForRequest(request: TaskRequest): "direct" | "sdk" {
  if (request.kind === "task" || request.kind === "resume") return "sdk";
  return request.options.backend ?? "direct";
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_JSON_BODY");
  return value as Record<string, unknown>;
}

function remotePrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body["prompt"] === "string" && body["prompt"].trim()) parts.push(body["prompt"].trim());
  const promptFiles = body["promptFiles"];
  if (promptFiles !== undefined) {
    if (!Array.isArray(promptFiles) || promptFiles.length > 20) throw new Error("INVALID_PROMPT_FILES");
    for (const item of promptFiles) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_PROMPT_FILES");
      const record = item as Record<string, unknown>;
      const name = typeof record["name"] === "string" ? basename(record["name"]).trim() : "";
      const content = typeof record["content"] === "string" ? record["content"].trim() : "";
      if (!name || !content || name.length > 200) throw new Error("INVALID_PROMPT_FILES");
      parts.push(`--- BEGIN PROMPT FILE: ${name} ---\n${content}\n--- END PROMPT FILE ---`);
    }
  }
  if (parts.length === 0) throw new Error("MISSING_PROMPT");
  return parts.join("\n\n");
}

const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);

function remoteCommonOptions(body: Record<string, unknown>): CommonOptions {
  const reasoning = typeof body["reasoning"] === "string" && REASONING_EFFORTS.has(body["reasoning"] as ReasoningEffort)
    ? body["reasoning"] as ReasoningEffort
    : undefined;
  const timeoutMs = typeof body["timeoutMs"] === "number" && Number.isFinite(body["timeoutMs"]) && body["timeoutMs"] > 0
    ? body["timeoutMs"]
    : undefined;
  const retries = typeof body["retries"] === "number" && Number.isInteger(body["retries"]) && body["retries"] >= 0 && body["retries"] <= 10
    ? body["retries"]
    : undefined;
  const schema = body["schema"];
  const outputSchema = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : undefined;
  return {
    ...(typeof body["model"] === "string" && body["model"].trim() ? { model: body["model"].trim() } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof body["instructions"] === "string" && body["instructions"].trim() ? { instructions: body["instructions"].trim() } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
  };
}

const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("INVALID_IMAGE_DATA");
  }
  return Buffer.from(compact, "base64");
}

function materializeImages(jobId: string, body: Record<string, unknown>): { paths: string[]; uploadDir?: string } {
  const images = body["images"];
  if (images === undefined) return { paths: [] };
  if (!Array.isArray(images) || images.length > 5) throw new Error("INVALID_IMAGES");
  const uploadDir = join(appPaths().tempDir, "server", jobId);
  const inputDir = join(uploadDir, "inputs");
  const decoded: Array<{ bytes: Buffer; extension: string }> = [];
  let totalBytes = 0;
  for (const item of images) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_IMAGES");
    const record = item as Record<string, unknown>;
    const mimeType = typeof record["mimeType"] === "string" ? record["mimeType"].toLowerCase() : "";
    const extension = IMAGE_EXTENSION[mimeType];
    if (!extension || typeof record["dataBase64"] !== "string") throw new Error("INVALID_IMAGES");
    const bytes = decodeBase64(record["dataBase64"]);
    if (bytes.length > 20 * 1024 * 1024) throw new Error("IMAGE_TOO_LARGE");
    totalBytes += bytes.length;
    decoded.push({ bytes, extension });
  }
  if (totalBytes > 50 * 1024 * 1024) throw new Error("IMAGES_TOO_LARGE");
  ensureDir(inputDir);
  const paths = decoded.map((image, index) => {
    const path = join(inputDir, `image-${index + 1}${image.extension}`);
    writeFileSync(path, image.bytes, { mode: 0o600 });
    return path;
  });
  return { paths, uploadDir };
}

function removeExpiredUploadDirectories(ttlMs: number): void {
  const root = join(appPaths().tempDir, "server");
  if (!existsSync(root)) return;
  const cutoff = Date.now() - ttlMs;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      if (lstatSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // A concurrent cleanup or permissions issue must not prevent service startup.
    }
  }
}

function publicResult(job: RemoteJob, result: TaskResult): Record<string, unknown> {
  return {
    ...result,
    artifacts: result.artifacts.map(({ path: _path, ...artifact }, index) => ({
      ...artifact,
      downloadUrl: `/v1/jobs/${job.jobId}/artifacts/${index}`,
    })),
  };
}

function jobSnapshot(job: RemoteJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.result ? { result: publicResult(job, job.result) } : {}),
  };
}

export async function startCodexTaskServer(
  options: CodexTaskServerOptions = {},
): Promise<RunningCodexTaskServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7777;
  if (!isLoopbackHost(host) && !options.token?.trim()) {
    throw new Error("A non-loopback listener requires a Service Token");
  }
  const run = options.run ?? dispatch;
  const maxBodyBytes = options.maxBodyBytes ?? 72 * 1024 * 1024;
  const jobTtlMs = options.jobTtlMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(jobTtlMs) || jobTtlMs < 1) throw new Error("jobTtlMs must be positive");
  removeExpiredUploadDirectories(jobTtlMs);
  const maxConcurrency = options.maxConcurrency ?? 2;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new Error("maxConcurrency must be an integer from 1 to 16");
  }
  const jobs = new Map<string, RemoteJob>();
  const pending: Array<{ job: RemoteJob; request: TaskRequest }> = [];
  let active = 0;

  const drain = (): void => {
    while (active < maxConcurrency && pending.length > 0) {
      const next = pending.shift();
      if (!next) return;
      const { job, request: taskRequest } = next;
      active += 1;
      job.status = "running";
      job.updatedAt = new Date().toISOString();
      void run(taskRequest)
        .then((result) => {
          job.status = result.status;
          job.result = result;
          job.updatedAt = new Date().toISOString();
        })
        .catch((error: unknown) => {
          const normalized = asCodexTaskError(error);
          job.status = "failed";
          job.result = {
            status: "failed",
            taskId: randomUUID(),
            backend: backendForRequest(taskRequest),
            artifacts: [],
            error: {
              code: normalized.code,
              message: normalized.message,
              retryable: normalized.retryable,
            },
          };
          job.updatedAt = new Date().toISOString();
        })
        .finally(() => {
          if (job.uploadDir) rmSync(job.uploadDir, { recursive: true, force: true });
          active -= 1;
          const expiry = setTimeout(() => jobs.delete(job.jobId), jobTtlMs);
          expiry.unref();
          drain();
        });
    }
  };

  const execute = (job: RemoteJob, taskRequest: TaskRequest): void => {
    pending.push({ job, request: taskRequest });
    queueMicrotask(drain);
  };

  const server = createServer((request, response) => {
    void (async () => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { ok: true, service: "codex-task" });
      return;
    }
    if (url.pathname.startsWith("/v1/") && !authorized(request, options.token)) {
      writeJson(response, 401, {
        error: { code: "UNAUTHORIZED", message: "A valid Bearer token is required" },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/text") {
      let body: Record<string, unknown>;
      let uploadDir: string | undefined;
      try {
        body = await readJson(request, maxBodyBytes);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "REQUEST_TOO_LARGE";
        writeJson(response, tooLarge ? 413 : 400, {
          error: {
            code: tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST",
            message: tooLarge ? "Request body exceeds the configured limit" : "Request body must be valid JSON",
          },
        });
        return;
      }
      try {
        const now = new Date().toISOString();
        const job: RemoteJob = {
          jobId: randomUUID(),
          kind: "text",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const uploaded = materializeImages(job.jobId, body);
        uploadDir = uploaded.uploadDir;
        job.uploadDir = uploadDir;
        const backend = body["backend"] === "sdk" ? "sdk" : "direct";
        const taskRequest: TaskRequest = {
          kind: "text",
          options: {
            ...remoteCommonOptions(body),
            prompt: remotePrompt(body),
            imagePaths: uploaded.paths,
            backend,
            ...(typeof body["workingDirectory"] === "string" ? { workingDirectory: body["workingDirectory"] } : {}),
          },
        };
        jobs.set(job.jobId, job);
        execute(job, taskRequest);
        writeJson(response, 202, {
          jobId: job.jobId,
          status: "queued",
          statusUrl: `/v1/jobs/${job.jobId}`,
        });
      } catch (error) {
        if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : "INVALID_REQUEST";
        writeJson(response, 400, {
          error: { code: message, message: "Text request is invalid" },
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/image") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(request, maxBodyBytes);
        const now = new Date().toISOString();
        const job: RemoteJob = {
          jobId: randomUUID(),
          kind: "image",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const uploaded = materializeImages(job.jobId, body);
        job.uploadDir = uploaded.uploadDir;
        const taskRequest: TaskRequest = {
          kind: "image",
          options: {
            ...remoteCommonOptions(body),
            prompt: remotePrompt(body),
            imagePaths: uploaded.paths,
            backend: body["backend"] === "sdk" ? "sdk" : "direct",
            temporary: true,
            ...(typeof body["workingDirectory"] === "string" ? { workingDirectory: body["workingDirectory"] } : {}),
            ...(typeof body["count"] === "number" ? { count: body["count"] } : {}),
            ...(typeof body["concurrency"] === "number" ? { concurrency: body["concurrency"] } : {}),
            ...(typeof body["size"] === "string" ? { size: body["size"] } : {}),
            ...(typeof body["quality"] === "string" ? { quality: body["quality"] as "auto" | "low" | "medium" | "high" } : {}),
            ...(typeof body["background"] === "string" ? { background: body["background"] as "auto" | "opaque" | "transparent" } : {}),
          },
        };
        jobs.set(job.jobId, job);
        execute(job, taskRequest);
        writeJson(response, 202, {
          jobId: job.jobId,
          status: "queued",
          statusUrl: `/v1/jobs/${job.jobId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "INVALID_REQUEST";
        writeJson(response, message === "REQUEST_TOO_LARGE" ? 413 : 400, {
          error: { code: message, message: "Image request is invalid" },
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/task") {
      try {
        const body = await readJson(request, maxBodyBytes);
        const now = new Date().toISOString();
        const job: RemoteJob = {
          jobId: randomUUID(),
          kind: "task",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const uploaded = materializeImages(job.jobId, body);
        job.uploadDir = uploaded.uploadDir;
        const sandbox = body["sandboxMode"];
        const sandboxMode = sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access"
          ? sandbox
          : undefined;
        const taskRequest: TaskRequest = {
          kind: "task",
          options: {
            ...remoteCommonOptions(body),
            prompt: remotePrompt(body),
            imagePaths: uploaded.paths,
            backend: "sdk",
            ...(typeof body["workingDirectory"] === "string" ? { workingDirectory: body["workingDirectory"] } : {}),
            ...(sandboxMode ? { sandboxMode } : {}),
            ...(typeof body["networkAccess"] === "boolean" ? { networkAccess: body["networkAccess"] } : {}),
            ...(typeof body["noFollowup"] === "boolean" ? { noFollowup: body["noFollowup"] } : {}),
          },
        };
        jobs.set(job.jobId, job);
        execute(job, taskRequest);
        writeJson(response, 202, {
          jobId: job.jobId,
          status: "queued",
          statusUrl: `/v1/jobs/${job.jobId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "INVALID_REQUEST";
        writeJson(response, message === "REQUEST_TOO_LARGE" ? 413 : 400, {
          error: { code: message, message: "Workspace task request is invalid" },
        });
      }
      return;
    }
    const resumeMatch = request.method === "POST"
      ? url.pathname.match(/^\/v1\/tasks\/([0-9a-f-]{36})\/resume$/i)
      : null;
    if (resumeMatch) {
      try {
        const body = await readJson(request, maxBodyBytes);
        const now = new Date().toISOString();
        const job: RemoteJob = {
          jobId: randomUUID(),
          kind: "resume",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const uploaded = materializeImages(job.jobId, body);
        job.uploadDir = uploaded.uploadDir;
        const taskRequest: TaskRequest = {
          kind: "resume",
          options: {
            ...remoteCommonOptions(body),
            taskId: resumeMatch[1] ?? "",
            answer: remotePrompt(body),
            imagePaths: uploaded.paths,
            ...(typeof body["noFollowup"] === "boolean" ? { noFollowup: body["noFollowup"] } : {}),
          },
        };
        jobs.set(job.jobId, job);
        execute(job, taskRequest);
        writeJson(response, 202, {
          jobId: job.jobId,
          status: "queued",
          statusUrl: `/v1/jobs/${job.jobId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "INVALID_REQUEST";
        writeJson(response, message === "REQUEST_TOO_LARGE" ? 413 : 400, {
          error: { code: message, message: "Resume request is invalid" },
        });
      }
      return;
    }
    const jobMatch = request.method === "GET" ? url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i) : null;
    if (jobMatch) {
      const job = jobs.get(jobMatch[1] ?? "");
      if (!job) {
        writeJson(response, 404, { error: { code: "JOB_NOT_FOUND", message: "Remote job not found" } });
        return;
      }
      writeJson(response, 200, jobSnapshot(job));
      return;
    }
    const artifactMatch = request.method === "GET"
      ? url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/artifacts\/(\d+)$/i)
      : null;
    if (artifactMatch) {
      const job = jobs.get(artifactMatch[1] ?? "");
      const index = Number(artifactMatch[2]);
      const artifact = job?.result?.artifacts[index];
      if (!artifact || !existsSync(artifact.path)) {
        writeJson(response, 404, { error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" } });
        return;
      }
      const stat = statSync(artifact.path);
      response.writeHead(200, {
        "content-type": artifact.mimeType ?? "application/octet-stream",
        "content-length": stat.size,
        "content-disposition": `attachment; filename="${basename(artifact.path).replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
        "cache-control": "private, no-store",
      });
      createReadStream(artifact.path).pipe(response);
      return;
    }
    writeJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    })().catch((error: unknown) => {
      const normalized = asCodexTaskError(error);
      writeJson(response, 500, { error: { code: normalized.code, message: normalized.message } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
