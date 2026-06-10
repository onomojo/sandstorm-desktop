import React from 'react';
import { ConfigPane } from './types';

export const configPanes: ConfigPane[] = [
  {
    id: 'models',
    label: 'Models',
    icon: <span className="text-sm">⚙</span>,
    render: () => <div className="text-sandstorm-muted text-sm">Coming soon</div>,
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: <span className="text-sm">🔌</span>,
    render: () => <div className="text-sandstorm-muted text-sm">Coming soon</div>,
  },
  {
    id: 'automation',
    label: 'Automation',
    icon: <span className="text-sm">⚡</span>,
    render: () => <div className="text-sandstorm-muted text-sm">Coming soon</div>,
  },
  {
    id: 'ticketing',
    label: 'Ticketing',
    icon: <span className="text-sm">🎫</span>,
    render: () => <div className="text-sandstorm-muted text-sm">Coming soon</div>,
  },
];
