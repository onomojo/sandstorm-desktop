/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketView } from '../../../src/renderer/components/TicketView';
import { useAppStore, Stack } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'test-stack',
    project: 'myproject',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'up',
    error: null,
    runtime: 'docker',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    services: [],
    ...overrides,
  };
}

describe('TicketView', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      selectedStackId: null,
      stackMetrics: {},
    });
  });

  // --- Grouping logic ---

  it('renders nothing when stacks is empty', () => {
    const { container } = render(<TicketView stacks={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('groups stacks by ticket ID', () => {
    const stacks = [
      makeStack({ id: 'stack-1', ticket: 'EXP-10' }),
      makeStack({ id: 'stack-2', ticket: 'EXP-10' }),
      makeStack({ id: 'stack-3', ticket: 'EXP-20' }),
    ];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('EXP-10')).toBeDefined();
    expect(screen.getByText('EXP-20')).toBeDefined();
  });

  it('shows ungrouped section for stacks without a ticket', () => {
    const stacks = [
      makeStack({ id: 'stack-1', ticket: null }),
      makeStack({ id: 'stack-2', ticket: null }),
    ];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('Ungrouped')).toBeDefined();
  });

  it('shows both ticketed and ungrouped sections', () => {
    const stacks = [
      makeStack({ id: 'stack-1', ticket: 'FEAT-5' }),
      makeStack({ id: 'stack-2', ticket: null }),
    ];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('FEAT-5')).toBeDefined();
    expect(screen.getByText('Ungrouped')).toBeDefined();
  });

  // --- Stack count display ---

  it('shows correct stack count per ticket (singular)', () => {
    const stacks = [makeStack({ id: 'stack-1', ticket: 'BUG-1' })];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('1 stack')).toBeDefined();
  });

  it('shows correct stack count per ticket (plural)', () => {
    const stacks = [
      makeStack({ id: 'stack-1', ticket: 'BUG-1' }),
      makeStack({ id: 'stack-2', ticket: 'BUG-1' }),
      makeStack({ id: 'stack-3', ticket: 'BUG-1' }),
    ];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('3 stacks')).toBeDefined();
  });

  // --- Status summary ---

  it('shows status summary for ticket group', () => {
    const stacks = [
      makeStack({ id: 'stack-1', ticket: 'T-1', status: 'running' }),
      makeStack({ id: 'stack-2', ticket: 'T-1', status: 'running' }),
      makeStack({ id: 'stack-3', ticket: 'T-1', status: 'completed' }),
    ];
    render(<TicketView stacks={stacks} />);
    expect(screen.getByText('2 running, 1 needs review')).toBeDefined();
  });

  // --- Accordion: Level 1 (Ticket expand/collapse) ---

  it('stacks are hidden by default (collapsed)', () => {
    const stacks = [makeStack({ id: 'my-hidden-stack', ticket: 'T-1' })];
    render(<TicketView stacks={stacks} />);
    // The stack name should be in the DOM (for animation) but inside a max-h-0 container
    const stackButton = screen.getByText('my-hidden-stack');
    const collapsibleContainer = stackButton.closest('.max-h-0, [class*="max-h-0"]');
    expect(collapsibleContainer).not.toBeNull();
  });

  it('expands ticket group when header is clicked', () => {
    const stacks = [makeStack({ id: 'expand-stack', ticket: 'T-1' })];
    render(<TicketView stacks={stacks} />);

    // Click the ticket header
    fireEvent.click(screen.getByText('T-1'));

    // After expanding, the stack name's container should have max-h-[5000px]
    const stackButton = screen.getByText('expand-stack');
    const container = stackButton.closest('[class*="max-h-"]');
    expect(container?.className).toContain('max-h-[5000px]');
  });

  it('collapses ticket group when header is clicked again', () => {
    const stacks = [makeStack({ id: 'collapse-stack', ticket: 'T-1' })];
    render(<TicketView stacks={stacks} />);

    // Expand
    fireEvent.click(screen.getByText('T-1'));
    // Collapse
    fireEvent.click(screen.getByText('T-1'));

    const stackButton = screen.getByText('collapse-stack');
    const container = stackButton.closest('[class*="max-h-"]');
    expect(container?.className).toContain('max-h-0');
  });

  it('multiple ticket groups can be expanded simultaneously', () => {
    const stacks = [
      makeStack({ id: 'stack-a', ticket: 'T-1' }),
      makeStack({ id: 'stack-b', ticket: 'T-2' }),
    ];
    render(<TicketView stacks={stacks} />);

    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('T-2'));

    const containerA = screen.getByText('stack-a').closest('[class*="max-h-"]');
    const containerB = screen.getByText('stack-b').closest('[class*="max-h-"]');
    expect(containerA?.className).toContain('max-h-[5000px]');
    expect(containerB?.className).toContain('max-h-[5000px]');
  });

  // --- Accordion: Level 2 (Stack → Services expand/collapse) ---

  it('shows service chevron only when stack has services', () => {
    const stacks = [
      makeStack({
        id: 'with-svc',
        ticket: 'T-1',
        services: [{ name: 'app', status: 'running', containerId: 'c1' }],
      }),
      makeStack({ id: 'no-svc', ticket: 'T-1', services: [] }),
    ];
    render(<TicketView stacks={stacks} />);

    // Expand the ticket group first
    fireEvent.click(screen.getByText('T-1'));

    // Stack with services should have a clickable chevron button
    // Stack without services should have a spacer span instead
    const stackRows = screen.getByText('with-svc').closest('.group');
    const chevronButtons = stackRows?.querySelectorAll('button svg');
    expect(chevronButtons?.length).toBeGreaterThan(0);
  });

  it('expands services when stack chevron is clicked', () => {
    const stacks = [
      makeStack({
        id: 'svc-stack',
        ticket: 'T-1',
        services: [
          { name: 'app', status: 'running', containerId: 'c1' },
          { name: 'db', status: 'running', containerId: 'c2' },
        ],
      }),
    ];
    render(<TicketView stacks={stacks} />);

    // Expand ticket
    fireEvent.click(screen.getByText('T-1'));

    // Find and click the service chevron (first button inside the stack row)
    const stackRow = screen.getByText('svc-stack').closest('.group');
    const chevronButton = stackRow?.querySelector('button');
    expect(chevronButton).not.toBeNull();
    fireEvent.click(chevronButton!);

    // Services should now be visible
    expect(screen.getByText('app')).toBeDefined();
    expect(screen.getByText('db')).toBeDefined();
  });

  // --- Stack row content ---

  it('displays stack name and status label', () => {
    const stacks = [makeStack({ id: 'named-stack', ticket: 'T-1', status: 'running' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('named-stack')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
  });

  it('displays description when present', () => {
    const stacks = [
      makeStack({ id: 's1', ticket: 'T-1', description: 'Fix auth flow' }),
    ];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('Fix auth flow')).toBeDefined();
  });

  it('shows project name when showProject is true', () => {
    const stacks = [makeStack({ id: 's1', ticket: 'T-1', project: 'cool-proj' })];
    render(<TicketView stacks={stacks} showProject />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText(/cool-proj/)).toBeDefined();
  });

  it('does not show project name when showProject is false', () => {
    const stacks = [makeStack({ id: 's1', ticket: 'T-1', project: 'hidden-proj' })];
    render(<TicketView stacks={stacks} showProject={false} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.queryByText(/hidden-proj/)).toBeNull();
  });

  // --- Stack selection ---

  it('selects stack when stack name is clicked', () => {
    const stacks = [makeStack({ id: 'select-me', ticket: 'T-1' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('select-me'));

    expect(useAppStore.getState().selectedStackId).toBe('select-me');
  });

  // --- Action buttons by status ---

  it('shows View Diff and Push for completed stacks', () => {
    const stacks = [makeStack({ id: 'done-stack', ticket: 'T-1', status: 'completed' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('View Diff')).toBeDefined();
    expect(screen.getByText('Push')).toBeDefined();
  });

  it('shows View Output for running stacks', () => {
    const stacks = [makeStack({ id: 'run-stack', ticket: 'T-1', status: 'running' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('View Output')).toBeDefined();
  });

  it('shows New Task for idle stacks', () => {
    const stacks = [makeStack({ id: 'idle-stack', ticket: 'T-1', status: 'idle' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('New Task')).toBeDefined();
  });

  it('shows Start for stopped stacks', () => {
    const stacks = [makeStack({ id: 'stop-stack', ticket: 'T-1', status: 'stopped' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('Start')).toBeDefined();
  });

  it('shows Tear Down for non-running, non-building stacks', () => {
    const stacks = [makeStack({ id: 'tear-stack', ticket: 'T-1', status: 'completed' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.getByText('Tear Down')).toBeDefined();
  });

  it('does not show Tear Down for building stacks', () => {
    const stacks = [makeStack({ id: 'build-stack', ticket: 'T-1', status: 'building' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));

    expect(screen.queryByText('Tear Down')).toBeNull();
  });

  // --- Action handlers ---

  it('calls teardown API when Tear Down is clicked and confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const stacks = [makeStack({ id: 'td-stack', ticket: 'T-1', status: 'completed' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('Tear Down'));

    expect(api.stacks.teardown).toHaveBeenCalledWith('td-stack');
    vi.restoreAllMocks();
  });

  it('does not call teardown when confirm is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const stacks = [makeStack({ id: 'no-td', ticket: 'T-1', status: 'completed' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('Tear Down'));

    expect(api.stacks.teardown).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('calls stop API when Stop is clicked', () => {
    const stacks = [makeStack({ id: 'stop-it', ticket: 'T-1', status: 'running' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('Stop'));

    expect(api.stacks.stop).toHaveBeenCalledWith('stop-it');
  });

  it('calls start API when Start is clicked', () => {
    const stacks = [makeStack({ id: 'start-it', ticket: 'T-1', status: 'stopped' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('Start'));

    expect(api.stacks.start).toHaveBeenCalledWith('start-it');
  });

  it('calls push API when Push is clicked', () => {
    const stacks = [makeStack({ id: 'push-it', ticket: 'T-1', status: 'completed' })];
    render(<TicketView stacks={stacks} />);
    fireEvent.click(screen.getByText('T-1'));
    fireEvent.click(screen.getByText('Push'));

    expect(api.push.execute).toHaveBeenCalledWith('push-it');
  });

  // --- Service display ---

  it('shows service status and name when expanded', () => {
    const stacks = [
      makeStack({
        id: 'svc-detail',
        ticket: 'T-1',
        services: [
          { name: 'web', status: 'running', containerId: 'c1' },
          { name: 'worker', status: 'exited', containerId: 'c2' },
        ],
      }),
    ];
    render(<TicketView stacks={stacks} />);

    // Expand ticket
    fireEvent.click(screen.getByText('T-1'));

    // Expand stack services
    const stackRow = screen.getByText('svc-detail').closest('.group');
    const chevronButton = stackRow?.querySelector('button');
    fireEvent.click(chevronButton!);

    expect(screen.getByText('web')).toBeDefined();
    expect(screen.getByText('worker')).toBeDefined();
  });

  it('shows container metrics when available', () => {
    useAppStore.setState({
      stackMetrics: {
        'metrics-stack': {
          stackId: 'metrics-stack',
          totalMemory: 104857600,
          containers: [
            { containerId: 'c1', name: 'app', memoryUsage: 52428800, cpuPercent: 12.5 },
          ],
        },
      },
    });

    const stacks = [
      makeStack({
        id: 'metrics-stack',
        ticket: 'T-1',
        services: [{ name: 'app', status: 'running', containerId: 'c1' }],
      }),
    ];
    render(<TicketView stacks={stacks} />);

    // Expand ticket
    fireEvent.click(screen.getByText('T-1'));

    // Expand stack services
    const stackRow = screen.getByText('metrics-stack').closest('.group');
    const chevronButton = stackRow?.querySelector('button');
    fireEvent.click(chevronButton!);

    expect(screen.getByText(/50 MB/)).toBeDefined();
    expect(screen.getByText(/12\.5% CPU/)).toBeDefined();
  });

  // --- Status labels ---

  it('renders correct status labels for all statuses', () => {
    const statuses: [string, string][] = [
      ['building', 'Building'],
      ['up', 'Up'],
      ['running', 'Running'],
      ['completed', 'Needs Review'],
      ['failed', 'Failed'],
      ['idle', 'Idle'],
      ['stopped', 'Stopped'],
    ];

    for (const [status, label] of statuses) {
      const { unmount } = render(
        <TicketView stacks={[makeStack({ id: `s-${status}`, ticket: 'T-1', status })]} />
      );
      // Expand to see the label
      fireEvent.click(screen.getByText('T-1'));
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });
});
