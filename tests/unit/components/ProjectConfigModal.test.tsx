/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);

import { ProjectConfigModal } from '../../../src/renderer/components/ProjectConfigModal';
import { buildConfigPanes } from '../../../src/renderer/components/config/panes';
import { ConfigPane, ConfigPaneContext } from '../../../src/renderer/components/config/types';

function makePane(id: string, label: string, disabled?: boolean): ConfigPane {
  return {
    id,
    label,
    icon: <span>{label[0]}</span>,
    disabled,
    render: () => <div data-testid={`pane-content-${id}`}>{label} content</div>,
  };
}

const defaultProps = {
  open: true,
  title: 'Settings',
  onClose: vi.fn(),
  onSave: vi.fn(),
};

describe('ProjectConfigModal', () => {
  it('renders rail items from panes array', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} />);
    expect(screen.getByTestId('config-rail-item-alpha')).toBeDefined();
    expect(screen.getByTestId('config-rail-item-beta')).toBeDefined();
  });

  it('renders first enabled pane content by default', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} />);
    expect(screen.getByTestId('pane-content-alpha')).toBeDefined();
  });

  it('clicking a rail item switches the active pane', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} />);
    fireEvent.click(screen.getByTestId('config-rail-item-beta'));
    expect(screen.getByTestId('pane-content-beta')).toBeDefined();
  });

  it('honors initialPaneId when it names an enabled pane', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} initialPaneId="beta" />);
    expect(screen.getByTestId('pane-content-beta')).toBeDefined();
  });

  it('falls back to first enabled pane when initialPaneId is not in panes', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} initialPaneId="nonexistent" />);
    expect(screen.getByTestId('pane-content-alpha')).toBeDefined();
  });

  it('falls back to first enabled pane when initialPaneId names a disabled pane', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta', true)];
    render(<ProjectConfigModal {...defaultProps} panes={panes} initialPaneId="beta" />);
    expect(screen.getByTestId('pane-content-alpha')).toBeDefined();
  });

  it('renders disabled rail item as aria-disabled and non-interactive', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta', true)];
    render(<ProjectConfigModal {...defaultProps} panes={panes} />);
    const betaItem = screen.getByTestId('config-rail-item-beta');
    expect(betaItem.getAttribute('aria-disabled')).toBe('true');
    expect((betaItem as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking a disabled rail item does not switch panes', () => {
    const panes = [makePane('alpha', 'Alpha'), makePane('beta', 'Beta', true)];
    render(<ProjectConfigModal {...defaultProps} panes={panes} />);
    fireEvent.click(screen.getByTestId('config-rail-item-beta'));
    expect(screen.getByTestId('pane-content-alpha')).toBeDefined();
  });

  it('renders without crashing when all panes are disabled', () => {
    const panes = [makePane('alpha', 'Alpha', true), makePane('beta', 'Beta', true)];
    expect(() =>
      render(<ProjectConfigModal {...defaultProps} panes={panes} />)
    ).not.toThrow();
    expect(screen.getByTestId('project-config-content')).toBeDefined();
  });

  it('renders without crashing with empty panes array', () => {
    expect(() =>
      render(<ProjectConfigModal {...defaultProps} panes={[]} />)
    ).not.toThrow();
    expect(screen.getByTestId('project-config-content')).toBeDefined();
  });

  it('Save button is disabled when dirty is false', () => {
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} dirty={false} />);
    const save = screen.getByTestId('project-config-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save button is enabled when dirty is true', () => {
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} dirty={true} />);
    const save = screen.getByTestId('project-config-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('calls onSave when Save is clicked and dirty', () => {
    const onSave = vi.fn();
    const panes = [makePane('alpha', 'Alpha')];
    render(
      <ProjectConfigModal {...defaultProps} panes={panes} dirty={true} onSave={onSave} />
    );
    fireEvent.click(screen.getByTestId('project-config-save'));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('shows spinner when saving', () => {
    const panes = [makePane('alpha', 'Alpha')];
    render(
      <ProjectConfigModal {...defaultProps} panes={panes} dirty={true} saving={true} />
    );
    expect(screen.getByTestId('project-config-save-spinner')).toBeDefined();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('project-config-cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when overlay backdrop is clicked', () => {
    const onClose = vi.fn();
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('project-config-modal-overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId('project-config-modal-overlay'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders nothing when open is false', () => {
    const panes = [makePane('alpha', 'Alpha')];
    render(<ProjectConfigModal {...defaultProps} panes={panes} open={false} />);
    expect(screen.queryByTestId('project-config-modal')).toBeNull();
  });
});

describe('buildConfigPanes registry', () => {
  function makeCtx(): ConfigPaneContext {
    return {
      projectDir: '/test/project',
      routing: {
        getEffective: vi.fn().mockResolvedValue({}),
        getProject: vi.fn().mockResolvedValue(null),
        setProject: vi.fn().mockResolvedValue(undefined),
        removeProject: vi.fn().mockResolvedValue(undefined),
        getGlobal: vi.fn().mockResolvedValue({ assignments: {}, preset: null }),
        setGlobal: vi.fn().mockResolvedValue(undefined),
        applyPreset: vi.fn().mockResolvedValue(undefined),
        getAvailableModels: vi.fn().mockResolvedValue([]),
      },
      onDirtyChange: vi.fn(),
      registerSave: vi.fn(),
    };
  }

  it('returns exactly four panes in order: models, providers, automation, ticketing', async () => {
    const ctx = makeCtx();
    const panes = await buildConfigPanes(ctx);
    expect(panes).toHaveLength(4);
    expect(panes.map((p) => p.id)).toEqual([
      'models',
      'providers',
      'automation',
      'ticketing',
    ]);
  });

  it('models pane renders the ModelsPane body component', async () => {
    const ctx = makeCtx();
    const panes = await buildConfigPanes(ctx);
    const modelsPane = panes.find((p) => p.id === 'models')!;
    expect(modelsPane).toBeDefined();
    render(<>{modelsPane.render()}</>);
    expect(screen.getByTestId('models-pane')).toBeDefined();
  });

  it('shell renders with buildConfigPanes registry without crashing', async () => {
    const ctx = makeCtx();
    const panes = await buildConfigPanes(ctx);
    expect(() =>
      render(
        <ProjectConfigModal
          open={true}
          title="Config"
          panes={panes}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      )
    ).not.toThrow();
    expect(screen.getByTestId('project-config-modal')).toBeDefined();
  });
});
