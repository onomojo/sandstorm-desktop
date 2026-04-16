/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ServiceList } from '../../../src/renderer/components/ServiceList';
import { useAppStore, ServiceInfo } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeService(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'app',
    status: 'running',
    containerId: 'container-1',
    ports: [],
    ...overrides,
  };
}

describe('ServiceList', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      stackMetrics: {},
    });
  });

  it('renders "No services found" when empty', () => {
    render(
      <ServiceList services={[]} runtime="docker" onViewLogs={() => {}} />
    );
    expect(screen.getByText('No services found')).toBeDefined();
  });

  it('renders service name and status', () => {
    render(
      <ServiceList
        services={[makeService({ name: 'web', status: 'running' })]}
        runtime="docker"
        onViewLogs={() => {}}
      />
    );
    expect(screen.getByText('web')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('shows Expose button for unexposed ports', () => {
    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          ports: [{ containerPort: 3000, exposed: false }],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );
    expect(screen.getByText('3000 Expose')).toBeDefined();
  });

  it('shows host port and Unexpose button for exposed ports', () => {
    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          ports: [{ containerPort: 3000, hostPort: 15000, exposed: true }],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );
    expect(screen.getByText(':15000')).toBeDefined();
    expect(screen.getByText('Unexpose')).toBeDefined();
  });

  it('calls expose IPC when Expose button is clicked', async () => {
    const refreshStacks = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshStacks });

    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          ports: [{ containerPort: 3000, exposed: false }],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );

    fireEvent.click(screen.getByText('3000 Expose'));

    await waitFor(() => {
      expect(api.ports.expose).toHaveBeenCalledWith('test-stack', 'app', 3000);
    });
  });

  it('calls unexpose IPC when Unexpose button is clicked', async () => {
    const refreshStacks = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshStacks });

    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          ports: [{ containerPort: 3000, hostPort: 15000, exposed: true }],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );

    fireEvent.click(screen.getByText('Unexpose'));

    await waitFor(() => {
      expect(api.ports.unexpose).toHaveBeenCalledWith('test-stack', 'app', 3000);
    });
  });

  it('renders multiple ports for the same service', () => {
    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          ports: [
            { containerPort: 3000, exposed: false },
            { containerPort: 8080, hostPort: 15001, exposed: true },
          ],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );
    expect(screen.getByText('3000 Expose')).toBeDefined();
    expect(screen.getByText(':15001')).toBeDefined();
    expect(screen.getByText('Unexpose')).toBeDefined();
  });

  it('shows legacy hostPort fallback when no ports array', () => {
    render(
      <ServiceList
        services={[makeService({
          name: 'app',
          hostPort: 12345,
          ports: [],
        })]}
        runtime="docker"
        onViewLogs={() => {}}
        stackId="test-stack"
      />
    );
    expect(screen.getByText(':12345')).toBeDefined();
  });

  it('calls onViewLogs when Logs button is clicked', () => {
    const onViewLogs = vi.fn();
    render(
      <ServiceList
        services={[makeService({ containerId: 'c-123' })]}
        runtime="docker"
        onViewLogs={onViewLogs}
      />
    );

    fireEvent.click(screen.getByText('Logs'));
    expect(onViewLogs).toHaveBeenCalledWith('c-123');
  });
});
