import { useMemo } from 'react';
import { ServiceInfo } from '../store';

export function useServiceHealth(services: ServiceInfo[]) {
  return useMemo(() => {
    const total = services.length;
    const running = services.filter((s) => s.status === 'running').length;
    const exited = services.filter((s) => s.status === 'exited');
    const healthy = running === total && total > 0;

    return {
      total,
      running,
      exited,
      healthy,
      summary:
        total === 0
          ? 'No services'
          : healthy
            ? `${running}/${total} up`
            : `${running}/${total} up${exited.length > 0 ? ` — ${exited.map((s) => s.name).join(', ')} exited` : ''}`,
    };
  }, [services]);
}
