import { useState, useEffect, useCallback } from 'react';

export function useTaskOutput(stackId: string) {
  const [output, setOutput] = useState('');

  useEffect(() => {
    const unsub = window.sandstorm.on(
      'task:output',
      (data: unknown) => {
        const payload = data as { stackId: string; data: string };
        if (payload.stackId === stackId) {
          setOutput((prev) => prev + payload.data);
        }
      }
    );
    return unsub;
  }, [stackId]);

  const clear = useCallback(() => setOutput(''), []);

  return { output, clear };
}
