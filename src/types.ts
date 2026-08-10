export type Backend = "direct" | "sdk";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type TaskStatus = "completed" | "needs_input" | "failed" | "cancelled";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface UsageSummary {
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface Artifact {
  path: string;
  kind: "image" | "file";
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  expiresAt?: string | undefined;
}

export interface CommandSummary {
  command: string;
  exitCode?: number | undefined;
  status?: string | undefined;
}

export interface ResultBase {
  status: TaskStatus;
  taskId: string;
  backend: Backend;
  threadId?: string | undefined;
  text?: string | undefined;
  effectiveModel?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  artifacts: Artifact[];
  changes?: string[] | undefined;
  commands?: CommandSummary[] | undefined;
  usage?: UsageSummary | undefined;
}

export interface CompletedResult extends ResultBase {
  status: "completed";
}

export interface NeedsInputResult extends ResultBase {
  status: "needs_input";
  questions: string[];
}

export interface FailedResult extends ResultBase {
  status: "failed";
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export interface CancelledResult extends ResultBase {
  status: "cancelled";
  error: {
    code: "CANCELLED" | "TIMEOUT";
    message: string;
    retryable: boolean;
  };
}

export type TaskResult = CompletedResult | NeedsInputResult | FailedResult | CancelledResult;

export type TaskEvent =
  | { type: "started"; taskId: string; backend: Backend; kind: TaskRequest["kind"] }
  | { type: "progress"; taskId: string; message: string; item?: unknown }
  | { type: "retrying"; taskId: string; attempt: number; delayMs: number; error: string }
  | { type: "artifact"; taskId: string; artifact: Artifact }
  | { type: "needs_input"; taskId: string; result: NeedsInputResult }
  | { type: "completed"; taskId: string; result: CompletedResult }
  | { type: "failed"; taskId: string; result: FailedResult | CancelledResult };

export interface CommonOptions {
  backend?: Backend | undefined;
  model?: string | undefined;
  reasoning?: ReasoningEffort | undefined;
  instructions?: string | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  codexHome?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: TaskEvent) => void) | undefined;
}

export interface TextOptions extends CommonOptions {
  prompt: string;
  backend?: Backend | undefined;
  workingDirectory?: string | undefined;
}

export interface ImageOptions extends CommonOptions {
  prompt: string;
  backend?: Backend | undefined;
  imagePaths?: string[] | undefined;
  output?: string | undefined;
  count?: number | undefined;
  concurrency?: number | undefined;
  size?: string | undefined;
  quality?: "auto" | "low" | "medium" | "high" | undefined;
  background?: "auto" | "opaque" | "transparent" | undefined;
  overwrite?: boolean | undefined;
  workingDirectory?: string | undefined;
}

export interface WorkspaceTaskOptions extends CommonOptions {
  prompt: string;
  backend: "sdk";
  workingDirectory?: string | undefined;
  sandboxMode?: SandboxMode | undefined;
  networkAccess?: boolean | undefined;
  noFollowup?: boolean | undefined;
}

export interface ResumeTaskOptions extends Omit<CommonOptions, "backend"> {
  taskId: string;
  answer: string;
  noFollowup?: boolean | undefined;
}

export type TaskRequest =
  | { kind: "text"; options: TextOptions }
  | { kind: "image"; options: ImageOptions }
  | { kind: "task"; options: WorkspaceTaskOptions }
  | { kind: "resume"; options: ResumeTaskOptions };

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  nodeVersion: string;
  checks: DoctorCheck[];
  paths: Record<string, string>;
}

export interface GcReport {
  removedPaths: number;
  reclaimedBytes: number;
  warnings: string[];
}
