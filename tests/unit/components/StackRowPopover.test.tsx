/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { StackRowPopover } from '../../../src/renderer/components/StackRowPopover';
import { Stack, StackMetrics } from '../../../src/renderer/store';
// Imported for the afterEach(cleanup) side effect — without it, each render
// accumulates in the DOM and queryByText sees duplicates from prior tests.
import './setup';

const baseStack: Stack = {
  id: 'foo-stack',
  project: 'proj',
  project_dir: '/proj',
  ticket: '310',
  branch: 'feat/foo',
  description: 'Refine ticket UI',
  status: 'completed',
  error: null,
  pr_url: null,
  pr_number: null,
  runtime: 'docker',
  total_input_tokens: 320_000,
  total_output_tokens: 180_000,
  total_execution_input_tokens: 0,
  total_execution_output_tokens: 0,
  total_review_input_tokens: 0,
  total_review_output_tokens: 0,
  rate_limit_reset_at: null,
  created_at: '2026-04-23T10:00:00Z',
  updated_at: '2026-04-23T11:00:00Z',
  current_model: 'opus',
  services: [
    { name: 'claude', status: 'running', containerId: 'c1', ports: [] },
    { name: 'postgres', status: 'running', containerId: 'c2', ports: [] },
    { name: 'worker', status: 'exited', exitCode: 1, containerId: 'c3', ports: [] },
  ],
};

const metrics: StackMetrics = {
  totalMemory: 482 * 1024 * 1024,
  containers: [
    { name: 'claude', containerId: 'c1', memoryUsage: 0, memoryLimit: 0, cpuPercent: 12.4 },
  ],
  taskMetrics: { stackId: 'foo', totalTasks: 0, completedTasks: 0, failedTasks: 0, runningTasks: 0, avgTaskDurationMs: 0 },
};

const anchor = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 } as DOMRect;

describe('StackRowPopover', () => {
  it('renders the stack id, ticket, and branch', () => {
    render(<StackRowPopover stack={baseStack} metrics={metrics} anchorRect={anchor} />);
    expect(screen.getByText('foo-stack')).toBeDefined();
    expect(screen.getByText('310')).toBeDefined();
    expect(screen.getByText('feat/foo')).toBeDefined();
  });

  it('renders the description', () => {
    render(<StackRowPopover stack={baseStack} metrics={metrics} anchorRect={anchor} />);
    expect(screen.getByText('Refine ticket UI')).toBeDefined();
  });

  it('renders each service with status (and exit code for exited ones)', () => {
    render(<StackRowPopover stack={baseStack} metrics={metrics} anchorRect={anchor} />);
    expect(screen.getByText('claude')).toBeDefined();
    expect(screen.getByText('postgres')).toBeDefined();
    expect(screen.getByText('worker')).toBeDefined();
    expect(screen.getByText(/exited.*code 1/i)).toBeDefined();
  });

  it('renders memory + CPU + token totals when metrics are present', () => {
    render(<StackRowPopover stack={baseStack} metrics={metrics} anchorRect={anchor} />);
    expect(screen.getByText('Memory')).toBeDefined();
    expect(screen.getByText('CPU')).toBeDefined();
    expect(screen.getByText('Tokens')).toBeDefined();
    expect(screen.getByText(/12\.4%/)).toBeDefined();
  });

  it('omits the resources block when no metrics and no tokens', () => {
    const noTokens = { ...baseStack, total_input_tokens: 0, total_output_tokens: 0 };
    render(<StackRowPopover stack={noTokens} metrics={undefined} anchorRect={anchor} />);
    expect(screen.queryByText('Memory')).toBeNull();
    expect(screen.queryByText('CPU')).toBeNull();
    expect(screen.queryByText('Tokens')).toBeNull();
  });
});
