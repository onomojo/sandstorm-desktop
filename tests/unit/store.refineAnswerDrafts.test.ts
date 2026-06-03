/**
 * @vitest-environment jsdom
 *
 * Tests for the refineAnswerDrafts store feature (#459).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/renderer/store';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const ANSWERS_A = [
  { optionId: 'opt1', text: 'context for q1' },
  { optionId: null, text: 'free text only' },
];

const ANSWERS_B = [
  { optionId: 'opt2', text: '' },
];

describe('refineAnswerDrafts', () => {
  beforeEach(() => {
    useAppStore.setState({ refineAnswerDrafts: {} } as any);
  });

  it('setRefineAnswerDraft stores answers and can be read back', () => {
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, ANSWERS_A);
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toEqual(ANSWERS_A);
  });

  it('drafts for two distinct session ids are independent', () => {
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, ANSWERS_A);
    useAppStore.getState().setRefineAnswerDraft(SESSION_B, ANSWERS_B);
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toEqual(ANSWERS_A);
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_B]).toEqual(ANSWERS_B);
  });

  it('clearRefineAnswerDraft removes the entry for that session', () => {
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, ANSWERS_A);
    useAppStore.getState().setRefineAnswerDraft(SESSION_B, ANSWERS_B);
    useAppStore.getState().clearRefineAnswerDraft(SESSION_A);
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toBeUndefined();
    // Other session unaffected
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_B]).toEqual(ANSWERS_B);
  });

  it('clearRefineAnswerDraft on non-existent session is a no-op', () => {
    useAppStore.getState().setRefineAnswerDraft(SESSION_B, ANSWERS_B);
    useAppStore.getState().clearRefineAnswerDraft('does-not-exist');
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_B]).toEqual(ANSWERS_B);
  });

  it('removeRefinementSession clears that session draft and only that one', () => {
    useAppStore.setState({
      refineAnswerDrafts: {
        [SESSION_A]: ANSWERS_A,
        [SESSION_B]: ANSWERS_B,
      },
      refinementSessions: [
        { id: SESSION_A, ticketId: '1', projectDir: '/p', status: 'ready', phase: 'check', startedAt: 0 },
        { id: SESSION_B, ticketId: '2', projectDir: '/p', status: 'ready', phase: 'check', startedAt: 0 },
      ],
      currentRefinementSessionId: SESSION_A,
    } as any);

    useAppStore.getState().removeRefinementSession(SESSION_A);

    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toBeUndefined();
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_B]).toEqual(ANSWERS_B);
  });

  it('removeRefinementSession also clears currentRefinementSessionId if it matches', () => {
    useAppStore.setState({
      refineAnswerDrafts: { [SESSION_A]: ANSWERS_A },
      refinementSessions: [
        { id: SESSION_A, ticketId: '1', projectDir: '/p', status: 'ready', phase: 'check', startedAt: 0 },
      ],
      currentRefinementSessionId: SESSION_A,
    } as any);

    useAppStore.getState().removeRefinementSession(SESSION_A);

    expect(useAppStore.getState().currentRefinementSessionId).toBeNull();
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toBeUndefined();
  });

  it('draft is part of store state (not referenced by localStorage or persist)', () => {
    // Verify refineAnswerDrafts exists as a key on the store state
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, ANSWERS_A);
    const state = useAppStore.getState();
    expect(Object.prototype.hasOwnProperty.call(state, 'refineAnswerDrafts')).toBe(true);
    // Confirm nothing was written to localStorage
    expect(localStorage.getItem('refineAnswerDrafts')).toBeNull();
  });

  it('updating an existing draft overwrites the previous value', () => {
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, ANSWERS_A);
    const updated = [{ optionId: 'new-opt', text: 'updated text' }];
    useAppStore.getState().setRefineAnswerDraft(SESSION_A, updated);
    expect(useAppStore.getState().refineAnswerDrafts[SESSION_A]).toEqual(updated);
  });
});
