export type SideEffectStage =
  | "none"
  | "before_click"
  | "click_attempted"
  | "possible_side_effect"
  | "confirmed";

export type AppErrorOptions = {
  code: string;
  message: string;
  retryable?: boolean;
  sideEffectStage?: SideEffectStage;
  safeDetails?: Record<string, unknown>;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly sideEffectStage: SideEffectStage;
  readonly safeDetails: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = normalizeErrorCode(options.code);
    this.retryable = options.retryable ?? false;
    this.sideEffectStage = options.sideEffectStage ?? "none";
    this.safeDetails = { ...(options.safeDetails ?? {}) };
    this.cause = options.cause;
  }
}

export function normalizeErrorCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  return normalized || "TOOL_EXECUTION_FAILED";
}

export function appError(input: AppErrorOptions): AppError {
  return new AppError(input);
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/);
  return new AppError({
    code: codeMatch?.[1] ?? "TOOL_EXECUTION_FAILED",
    message,
    cause: error,
  });
}

export function errorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  sideEffectStage: SideEffectStage;
  safeDetails: Record<string, unknown>;
} {
  const resolved = asAppError(error);
  return {
    code: resolved.code,
    message: resolved.message,
    retryable: resolved.retryable,
    sideEffectStage: resolved.sideEffectStage,
    safeDetails: { ...resolved.safeDetails },
  };
}
