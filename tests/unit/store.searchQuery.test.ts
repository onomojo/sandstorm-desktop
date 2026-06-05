/**
 * @vitest-environment jsdom
 *
 * Tests for the searchQuery store state (#541).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/renderer/store';

describe('searchQuery', () => {
  beforeEach(() => {
    useAppStore.setState({
      searchQuery: '',
      projects: [
        { id: 1, name: 'alpha', directory: '/alpha', added_at: '' },
        { id: 2, name: 'beta', directory: '/beta', added_at: '' },
      ],
      activeProjectId: 1,
    } as any);
  });

  it('starts with empty searchQuery', () => {
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('setSearchQuery updates searchQuery', () => {
    useAppStore.getState().setSearchQuery('fix bug');
    expect(useAppStore.getState().searchQuery).toBe('fix bug');
  });

  it('setSearchQuery can clear to empty string', () => {
    useAppStore.getState().setSearchQuery('something');
    useAppStore.getState().setSearchQuery('');
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('setActiveProjectId clears searchQuery', () => {
    useAppStore.getState().setSearchQuery('my query');
    expect(useAppStore.getState().searchQuery).toBe('my query');

    useAppStore.getState().setActiveProjectId(2);
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('setActiveProjectId to null clears searchQuery', () => {
    useAppStore.getState().setSearchQuery('test query');
    useAppStore.getState().setActiveProjectId(null);
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('setActiveProjectId updates activeProjectId correctly', () => {
    useAppStore.getState().setActiveProjectId(2);
    expect(useAppStore.getState().activeProjectId).toBe(2);
  });
});
