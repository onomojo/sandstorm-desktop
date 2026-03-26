/**
 * Standardized error codes and error class for consistent IPC error propagation.
 * All IPC handlers should throw or return SandstormError instances.
 */

export enum ErrorCode {
  STACK_NOT_FOUND = 'STACK_NOT_FOUND',
  CONTAINER_UNREACHABLE = 'CONTAINER_UNREACHABLE',
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  AUTH_FAILED = 'AUTH_FAILED',
  RUNTIME_UNAVAILABLE = 'RUNTIME_UNAVAILABLE',
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  PROJECT_NOT_INITIALIZED = 'PROJECT_NOT_INITIALIZED',
  INIT_FAILED = 'INIT_FAILED',
  TASK_DISPATCH_FAILED = 'TASK_DISPATCH_FAILED',
  COMPOSE_FAILED = 'COMPOSE_FAILED',
  INVALID_INPUT = 'INVALID_INPUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class SandstormError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SandstormError';
    this.code = code;
  }

  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}
