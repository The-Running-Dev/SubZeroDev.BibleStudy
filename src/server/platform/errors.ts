import type { ApiError, ErrorCode } from '../../shared/api.ts';

// A failure every module raises the same way; web turns it into an ApiError response.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toBody(): ApiError {
    const body: ApiError = { error: this.code, message: this.message, retryable: this.retryable };
    if (this.details) body.details = this.details;
    return body;
  }
}
