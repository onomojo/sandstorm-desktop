import { useState, useCallback, useEffect, useRef } from 'react';

export interface ColumnDef {
  key: string;
  minWidth: number;
  defaultWidth: number;
}

export interface UseResizableColumnsResult {
  columnWidths: Record<string, number>;
  startResize: (columnKey: string, startX: number) => void;
  resetWidths: () => void;
}

const STORAGE_PREFIX = 'sandstorm-col-widths-';

export function useResizableColumns(
  storageKey: string,
  columns: ColumnDef[]
): UseResizableColumnsResult {
  const fullKey = STORAGE_PREFIX + storageKey;

  const getDefaults = useCallback((): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const col of columns) {
      result[col.key] = col.defaultWidth;
    }
    return result;
  }, [columns]);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(fullKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults so new columns get defaults
        const defaults = {};
        for (const col of columns) {
          (defaults as Record<string, number>)[col.key] = col.defaultWidth;
        }
        return { ...defaults, ...parsed };
      }
    } catch {
      // ignore
    }
    const result: Record<string, number> = {};
    for (const col of columns) {
      result[col.key] = col.defaultWidth;
    }
    return result;
  });

  const draggingRef = useRef<{ columnKey: string; startX: number; startWidth: number } | null>(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const startResize = useCallback((columnKey: string, startX: number) => {
    draggingRef.current = {
      columnKey,
      startX,
      startWidth: columnWidths[columnKey] ?? 100,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [columnWidths]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const { columnKey, startX, startWidth } = draggingRef.current;
      const delta = e.clientX - startX;
      const col = columnsRef.current.find((c) => c.key === columnKey);
      const minW = col?.minWidth ?? 40;
      const newWidth = Math.max(minW, startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [columnKey]: newWidth }));
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Persist to localStorage whenever widths change
  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(columnWidths));
    } catch {
      // ignore
    }
  }, [fullKey, columnWidths]);

  const resetWidths = useCallback(() => {
    const defaults = getDefaults();
    setColumnWidths(defaults);
    try {
      localStorage.removeItem(fullKey);
    } catch {
      // ignore
    }
  }, [fullKey, getDefaults]);

  return { columnWidths, startResize, resetWidths };
}
