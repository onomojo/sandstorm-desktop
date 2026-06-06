import { describe, it, expect } from 'vitest';
import { resolveEffectiveBackend } from '../../src/main/control-plane/backend-resolution';
import type { GlobalBackendInput, ProjectBackendInput } from '../../src/main/control-plane/backend-resolution';

const baseGlobal: GlobalBackendInput = {
  inner_backend: 'claude',
  outer_backend: 'claude',
  inner_provider: null,
  inner_model: null,
  outer_provider: null,
  outer_model: null,
};

describe('resolveEffectiveBackend', () => {
  describe('null project — falls back to global', () => {
    it('returns global inner backend when project is null', () => {
      const result = resolveEffectiveBackend(baseGlobal, null, 'inner');
      expect(result.backend).toBe('claude');
    });

    it('returns global outer backend when project is null', () => {
      const result = resolveEffectiveBackend(baseGlobal, null, 'outer');
      expect(result.backend).toBe('claude');
    });

    it('includes global provider and model when set', () => {
      const global: GlobalBackendInput = {
        ...baseGlobal,
        inner_backend: 'opencode',
        inner_provider: 'anthropic',
        inner_model: 'claude-3-5-sonnet',
      };
      const result = resolveEffectiveBackend(global, null, 'inner');
      expect(result.backend).toBe('opencode');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-3-5-sonnet');
    });

    it('omits provider/model from result when global has nulls', () => {
      const result = resolveEffectiveBackend(baseGlobal, null, 'inner');
      expect(result).not.toHaveProperty('provider');
      expect(result).not.toHaveProperty('model');
    });
  });

  describe('project override', () => {
    it('uses project backend when set to opencode', () => {
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'global',
        inner_provider: 'openai',
        inner_model: 'gpt-4o',
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(baseGlobal, project, 'inner');
      expect(result.backend).toBe('opencode');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
    });

    it('outer surface reads outer fields', () => {
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'claude',
        inner_provider: 'openai',
        inner_model: 'gpt-4o',
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(baseGlobal, project, 'outer');
      expect(result.backend).toBe('claude');
      expect(result).not.toHaveProperty('provider');
      expect(result).not.toHaveProperty('model');
    });
  });

  describe('"global" sentinel inheritance', () => {
    it('backend: project "global" inherits global backend', () => {
      const global: GlobalBackendInput = { ...baseGlobal, inner_backend: 'opencode' };
      const project: ProjectBackendInput = {
        inner_backend: 'global',
        outer_backend: 'global',
        inner_provider: null,
        inner_model: null,
        outer_provider: null,
        outer_model: null,
      };
      expect(resolveEffectiveBackend(global, project, 'inner').backend).toBe('opencode');
    });

    it('provider: project null inherits global provider', () => {
      const global: GlobalBackendInput = { ...baseGlobal, inner_provider: 'anthropic' };
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'global',
        inner_provider: null,
        inner_model: null,
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(global, project, 'inner');
      expect(result.provider).toBe('anthropic');
    });

    it('provider: project "global" sentinel inherits global provider', () => {
      const global: GlobalBackendInput = { ...baseGlobal, inner_provider: 'anthropic' };
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'global',
        inner_provider: 'global',
        inner_model: null,
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(global, project, 'inner');
      expect(result.provider).toBe('anthropic');
    });

    it('model: project null inherits global model', () => {
      const global: GlobalBackendInput = { ...baseGlobal, inner_model: 'claude-3-5-sonnet' };
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'global',
        inner_provider: null,
        inner_model: null,
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(global, project, 'inner');
      expect(result.model).toBe('claude-3-5-sonnet');
    });

    it('model: project "global" sentinel inherits global model', () => {
      const global: GlobalBackendInput = { ...baseGlobal, outer_model: 'opus' };
      const project: ProjectBackendInput = {
        inner_backend: 'global',
        outer_backend: 'global',
        inner_provider: null,
        inner_model: null,
        outer_provider: null,
        outer_model: 'global',
      };
      const result = resolveEffectiveBackend(global, project, 'outer');
      expect(result.model).toBe('opus');
    });

    it('project overrides global when all fields are concrete', () => {
      const global: GlobalBackendInput = {
        inner_backend: 'claude',
        outer_backend: 'claude',
        inner_provider: 'anthropic',
        inner_model: 'sonnet',
        outer_provider: 'anthropic',
        outer_model: 'opus',
      };
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'opencode',
        inner_provider: 'openai',
        inner_model: 'gpt-4o',
        outer_provider: 'openai',
        outer_model: 'gpt-4-turbo',
      };
      const inner = resolveEffectiveBackend(global, project, 'inner');
      expect(inner.backend).toBe('opencode');
      expect(inner.provider).toBe('openai');
      expect(inner.model).toBe('gpt-4o');

      const outer = resolveEffectiveBackend(global, project, 'outer');
      expect(outer.backend).toBe('opencode');
      expect(outer.provider).toBe('openai');
      expect(outer.model).toBe('gpt-4-turbo');
    });

    it('mixes project and global: one field overridden, other inherits', () => {
      const global: GlobalBackendInput = {
        inner_backend: 'claude',
        outer_backend: 'claude',
        inner_provider: 'anthropic',
        inner_model: 'opus',
        outer_provider: null,
        outer_model: null,
      };
      const project: ProjectBackendInput = {
        inner_backend: 'opencode',
        outer_backend: 'global',
        inner_provider: 'global',  // inherit global provider
        inner_model: 'gpt-4o',     // concrete override
        outer_provider: null,
        outer_model: null,
      };
      const result = resolveEffectiveBackend(global, project, 'inner');
      expect(result.backend).toBe('opencode');
      expect(result.provider).toBe('anthropic');  // inherited
      expect(result.model).toBe('gpt-4o');         // overridden
    });
  });
});
