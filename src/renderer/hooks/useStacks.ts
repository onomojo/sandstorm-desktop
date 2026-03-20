import { useEffect } from 'react';
import { useAppStore } from '../store';

export function useStacks() {
  const { stacks, refreshStacks, loading, error } = useAppStore();

  useEffect(() => {
    refreshStacks();
  }, [refreshStacks]);

  return { stacks, refreshStacks, loading, error };
}
