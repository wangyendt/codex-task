export class CodexErrandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; exitCode?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CodexErrandError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function usageError(message: string, details?: unknown): CodexErrandError {
  return new CodexErrandError("USAGE_ERROR", message, { exitCode: 2, details });
}

export function asCodexErrandError(error: unknown): CodexErrandError {
  if (error instanceof CodexErrandError) return error;
  if (error instanceof Error) {
    return new CodexErrandError("UNEXPECTED_ERROR", error.message, { cause: error });
  }
  return new CodexErrandError("UNEXPECTED_ERROR", String(error));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof CodexErrandError && (error.code === "CANCELLED" || error.code === "TIMEOUT"))
  );
}
