export class CodexRunError extends Error {
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
    this.name = "CodexRunError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function usageError(message: string, details?: unknown): CodexRunError {
  return new CodexRunError("USAGE_ERROR", message, { exitCode: 2, details });
}

export function asCodexRunError(error: unknown): CodexRunError {
  if (error instanceof CodexRunError) return error;
  if (error instanceof Error) {
    return new CodexRunError("UNEXPECTED_ERROR", error.message, { cause: error });
  }
  return new CodexRunError("UNEXPECTED_ERROR", String(error));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof CodexRunError && (error.code === "CANCELLED" || error.code === "TIMEOUT"))
  );
}
