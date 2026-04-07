/**
 * Shared formatting utilities for the renderer.
 */

import type { Stack } from '../store';

export function formatTokenCount(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function buildTokenTooltip(stack: Stack): string {
  const hasPhaseBreakdown =
    stack.total_execution_input_tokens > 0 ||
    stack.total_execution_output_tokens > 0 ||
    stack.total_review_input_tokens > 0 ||
    stack.total_review_output_tokens > 0;

  if (hasPhaseBreakdown) {
    const execIn = formatTokenCount(stack.total_execution_input_tokens);
    const execOut = formatTokenCount(stack.total_execution_output_tokens);
    const revIn = formatTokenCount(stack.total_review_input_tokens);
    const revOut = formatTokenCount(stack.total_review_output_tokens);
    const totalIn = formatTokenCount(stack.total_input_tokens);
    const totalOut = formatTokenCount(stack.total_output_tokens);
    return `Execution: ${execIn} in / ${execOut} out\nReview: ${revIn} in / ${revOut} out\nTotal: ${totalIn} in / ${totalOut} out`;
  }

  return `Input: ${stack.total_input_tokens.toLocaleString()} / Output: ${stack.total_output_tokens.toLocaleString()}`;
}

