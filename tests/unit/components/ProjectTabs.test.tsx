/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectTabs } from '../../../src/renderer/components/ProjectTabs';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('ProjectTabs', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      showOpenProjectDialog: false,
    });
  });

  it('always shows the All tab', () => {
    render(<ProjectTabs />);
    expect(screen.getByText('All')).toBeDefined();
  });

  it('renders project tabs', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
    });

    render(<ProjectTabs />);
    expect(screen.getByText('project-a')).toBeDefined();
    expect(screen.getByText('project-b')).toBeDefined();
  });

  it('switches active project when tab is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByText('proj'));
    expect(useAppStore.getState().activeProjectId).toBe(1);
  });

  it('switches to All when All tab is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByText('All'));
    expect(useAppStore.getState().activeProjectId).toBeNull();
  });

  it('opens the add project dialog when + is clicked', () => {
    render(<ProjectTabs />);
    const addBtn = screen.getByTitle('Open project');
    fireEvent.click(addBtn);
    expect(useAppStore.getState().showOpenProjectDialog).toBe(true);
  });
});
