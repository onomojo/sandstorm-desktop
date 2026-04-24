import React from 'react';
import { ColumnDef } from '../hooks/useResizableColumns';

interface ResizableTableHeaderProps {
  columns: (ColumnDef & { label: string; align?: 'left' | 'right'; stickyRight?: boolean })[];
  columnWidths: Record<string, number>;
  onResizeStart: (columnKey: string, startX: number) => void;
}

export function ResizableTableHeader({ columns, columnWidths, onResizeStart }: ResizableTableHeaderProps) {
  return (
    <thead className="bg-sandstorm-bg">
      <tr className="border-b border-sandstorm-border text-sandstorm-muted">
        {columns.map((col, i) => {
          const isLast = i === columns.length - 1;
          const width = columnWidths[col.key] ?? col.defaultWidth;
          // Sticky-right keeps the actions header pinned to the viewport
          // edge during horizontal scroll so it stays aligned with its
          // sticky-right cells below (#316).
          const stickyClasses = col.stickyRight
            ? 'sticky right-0 z-[2] bg-sandstorm-bg border-l border-sandstorm-border'
            : '';
          return (
            <th
              key={col.key}
              className={`${col.align === 'right' ? 'text-right' : 'text-left'} font-medium px-3 py-2 relative select-none ${stickyClasses}`}
              style={{ width: `${width}px`, minWidth: `${col.minWidth}px` }}
              data-testid={`col-header-${col.key}`}
            >
              {col.label}
              {!isLast && (
                <div
                  className="absolute top-0 right-0 w-[5px] h-full cursor-col-resize hover:bg-sandstorm-accent/30 active:bg-sandstorm-accent/50 transition-colors z-10"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onResizeStart(col.key, e.clientX);
                  }}
                  data-testid={`col-resize-${col.key}`}
                />
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
