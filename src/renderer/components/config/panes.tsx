import React from 'react';
import { ConfigPane, ConfigPaneContext } from './types';
import { buildModelsPane } from './ModelsPane';
import { buildProvidersPane } from './ProvidersPane';
import { buildAutomationPane } from './AutomationPane';
import { buildTicketingPane } from './TicketingPane';

export async function buildConfigPanes(ctx: ConfigPaneContext): Promise<ConfigPane[]> {
  return [
    await buildModelsPane(ctx),
    buildProvidersPane(ctx),
    buildAutomationPane(ctx),
    buildTicketingPane(ctx),
  ];
}
