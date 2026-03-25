/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { ResizableTableHeader } from '../../../src/renderer/components/ResizableTableHeader';
import { useResizableColumns, ColumnDef } from '../../../src/renderer/hooks/useResizableColumns';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const TEST_COLUMNS: (ColumnDef & { label: string; align?: 'left' | 'right' })[] = [
  { key: 'status', label: 'Status', minWidth: 60, defaultWidth: 90 },
  { key: 'name', label: 'Name', minWidth: 80, defaultWidth: 140 },
  { key: 'description', label: 'Description', minWidth: 80, defaultWidth: 200 },
  { key: 'actions', label: '', minWidth: 40, defaultWidth: 60, align: 'right' },
];

describe('useResizableColumns', () => {
  it('initializes with default widths', () => {
    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    expect(result.current.columnWidths).toEqual({
      status: 90,
      name: 140,
      description: 200,
      actions: 60,
    });
  });

  it('restores widths from localStorage', () => {
    const saved = { status: 120, name: 180, description: 250, actions: 60 };
    localStorage.setItem('sandstorm-col-widths-test', JSON.stringify(saved));

    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    expect(result.current.columnWidths.status).toBe(120);
    expect(result.current.columnWidths.name).toBe(180);
    expect(result.current.columnWidths.description).toBe(250);
  });

  it('persists widths to localStorage after resize', () => {
    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    act(() => {
      result.current.startResize('name', 100);
    });

    // Simulate mouse move to increase width by 50px
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }));
    });

    // Simulate mouse up
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(result.current.columnWidths.name).toBe(190); // 140 + 50

    const stored = JSON.parse(localStorage.getItem('sandstorm-col-widths-test')!);
    expect(stored.name).toBe(190);
  });

  it('enforces minimum column width', () => {
    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    act(() => {
      result.current.startResize('status', 200);
    });

    // Drag far left to try to go below minimum (60)
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    // Should clamp to minWidth of 60
    expect(result.current.columnWidths.status).toBe(60);
  });

  it('resetWidths restores defaults and clears localStorage', () => {
    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    // Change a width
    act(() => {
      result.current.startResize('name', 100);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(result.current.columnWidths.name).not.toBe(140);

    // Reset
    act(() => {
      result.current.resetWidths();
    });

    expect(result.current.columnWidths).toEqual({
      status: 90,
      name: 140,
      description: 200,
      actions: 60,
    });
    // After reset, the persistence effect re-saves defaults
    const stored = JSON.parse(localStorage.getItem('sandstorm-col-widths-test')!);
    expect(stored).toEqual({ status: 90, name: 140, description: 200, actions: 60 });
  });

  it('sets col-resize cursor during drag', () => {
    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    act(() => {
      result.current.startResize('name', 100);
    });

    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('sandstorm-col-widths-test', 'not-json');

    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    // Should fall back to defaults
    expect(result.current.columnWidths).toEqual({
      status: 90,
      name: 140,
      description: 200,
      actions: 60,
    });
  });

  it('merges saved widths with new column defaults', () => {
    // Saved data only has some columns (simulating a new column being added)
    localStorage.setItem('sandstorm-col-widths-test', JSON.stringify({ status: 120 }));

    const { result } = renderHook(() => useResizableColumns('test', TEST_COLUMNS));

    expect(result.current.columnWidths.status).toBe(120);
    expect(result.current.columnWidths.name).toBe(140); // default
  });
});

describe('ResizableTableHeader', () => {
  it('renders all column headers', () => {
    const widths = { status: 90, name: 140, description: 200, actions: 60 };
    render(
      <table>
        <ResizableTableHeader
          columns={TEST_COLUMNS}
          columnWidths={widths}
          onResizeStart={vi.fn()}
        />
      </table>
    );

    expect(screen.getByText('Status')).toBeDefined();
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Description')).toBeDefined();
  });

  it('renders resize handles on all columns except the last', () => {
    const widths = { status: 90, name: 140, description: 200, actions: 60 };
    render(
      <table>
        <ResizableTableHeader
          columns={TEST_COLUMNS}
          columnWidths={widths}
          onResizeStart={vi.fn()}
        />
      </table>
    );

    expect(screen.getByTestId('col-resize-status')).toBeDefined();
    expect(screen.getByTestId('col-resize-name')).toBeDefined();
    expect(screen.getByTestId('col-resize-description')).toBeDefined();
    // Last column (actions) should NOT have a resize handle
    expect(screen.queryByTestId('col-resize-actions')).toBeNull();
  });

  it('calls onResizeStart when mousedown on resize handle', () => {
    const onResizeStart = vi.fn();
    const widths = { status: 90, name: 140, description: 200, actions: 60 };
    render(
      <table>
        <ResizableTableHeader
          columns={TEST_COLUMNS}
          columnWidths={widths}
          onResizeStart={onResizeStart}
        />
      </table>
    );

    const handle = screen.getByTestId('col-resize-name');
    fireEvent.mouseDown(handle, { clientX: 250 });

    expect(onResizeStart).toHaveBeenCalledWith('name', 250);
  });

  it('applies column widths as inline styles', () => {
    const widths = { status: 110, name: 160, description: 220, actions: 70 };
    render(
      <table>
        <ResizableTableHeader
          columns={TEST_COLUMNS}
          columnWidths={widths}
          onResizeStart={vi.fn()}
        />
      </table>
    );

    const statusHeader = screen.getByTestId('col-header-status');
    expect(statusHeader.style.width).toBe('110px');

    const nameHeader = screen.getByTestId('col-header-name');
    expect(nameHeader.style.width).toBe('160px');
  });

  it('applies right alignment for columns with align="right"', () => {
    const widths = { status: 90, name: 140, description: 200, actions: 60 };
    render(
      <table>
        <ResizableTableHeader
          columns={TEST_COLUMNS}
          columnWidths={widths}
          onResizeStart={vi.fn()}
        />
      </table>
    );

    const actionsHeader = screen.getByTestId('col-header-actions');
    expect(actionsHeader.className).toContain('text-right');
  });
});
