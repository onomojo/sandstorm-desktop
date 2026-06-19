import React from 'react';
import { ConfigPane, ConfigPaneContext } from './types';
import { buildModelsPane } from './ModelsPane';
import { buildAutomationPane } from './AutomationPane';
import { buildTicketingPane } from './TicketingPane';

export async function buildConfigPanes(ctx: ConfigPaneContext): Promise<ConfigPane[]> {
  return [
    await buildModelsPane(ctx),
    {
      id: 'providers',
      label: 'Providers',
      icon: <span className="text-sm">🔌</span>,
      render: () => <div className="text-sandstorm-muted text-sm">Coming soon</div>,
    },
    buildAutomationPane(ctx),
    buildTicketingPane(ctx),
  ];
}
