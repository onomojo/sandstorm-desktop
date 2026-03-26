import { describe, it, expect } from 'vitest';
import { SandstormError, ErrorCode } from '../../src/main/errors';

describe('SandstormError', () => {
  it('creates an error with code and message', () => {
    const err = new SandstormError(ErrorCode.STACK_NOT_FOUND, 'Stack "abc" not found');
    expect(err.code).toBe('STACK_NOT_FOUND');
    expect(err.message).toBe('Stack "abc" not found');
    expect(err.name).toBe('SandstormError');
    expect(err instanceof Error).toBe(true);
  });

  it('serializes to JSON with code and message', () => {
    const err = new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, 'Cannot reach container');
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'CONTAINER_UNREACHABLE',
      message: 'Cannot reach container',
    });
  });

  it('defines all expected error codes', () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toContain('STACK_NOT_FOUND');
    expect(codes).toContain('CONTAINER_UNREACHABLE');
    expect(codes).toContain('AUTH_EXPIRED');
    expect(codes).toContain('AUTH_FAILED');
    expect(codes).toContain('RUNTIME_UNAVAILABLE');
    expect(codes).toContain('PROJECT_NOT_FOUND');
    expect(codes).toContain('PROJECT_NOT_INITIALIZED');
    expect(codes).toContain('INIT_FAILED');
    expect(codes).toContain('TASK_DISPATCH_FAILED');
    expect(codes).toContain('COMPOSE_FAILED');
    expect(codes).toContain('INVALID_INPUT');
    expect(codes).toContain('INTERNAL_ERROR');
  });

  it('can be caught as a standard Error', () => {
    try {
      throw new SandstormError(ErrorCode.AUTH_EXPIRED, 'Token expired');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as SandstormError).code).toBe('AUTH_EXPIRED');
    }
  });
});
