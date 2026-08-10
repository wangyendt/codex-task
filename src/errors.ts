export class CodexTaskError extends Error {
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
    this.name = "CodexTaskError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function usageError(message: string, details?: unknown): CodexTaskError {
  return new CodexTaskError("USAGE_ERROR", message, { exitCode: 2, details });
}

export function asCodexTaskError(error: unknown): CodexTaskError {
  if (error instanceof CodexTaskError) return error;
  if (error instanceof Error) {
    return new CodexTaskError("UNEXPECTED_ERROR", error.message, { cause: error });
  }
  return new CodexTaskError("UNEXPECTED_ERROR", String(error));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof CodexTaskError && (error.code === "CANCELLED" || error.code === "TIMEOUT"))
  );
}
