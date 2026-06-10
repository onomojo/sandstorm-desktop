import { ReactNode } from 'react';

export interface ConfigPane {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  disabled?: boolean;
  render: () => ReactNode;
}
