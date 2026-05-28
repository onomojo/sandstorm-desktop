import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { addLabel, removeLabel } from '../../../../src/main/control-plane/ticket-labels';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-labels-test-'));
  fs.mkdirSync(path.join(tmpDir, '.sandstorm', 'scripts'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installScript(name: string, body: string): void {
  fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'scripts', name), body, { mode: 0o755 });
}

describe('addLabel', () => {
  it('rejects when add-label.sh is missing', async () => {
    await expect(addLabel('42', tmpDir, 'spec-ready')).rejects.toThrow(/add-label\.sh is missing/);
  });

  it('rejects when ticketId is empty', async () => {
    installScript('add-label.sh', '#!/bin/bash\nexit 0\n');
    await expect(addLabel('  ', tmpDir, 'spec-ready')).rejects.toThrow(/Ticket ID is required/);
  });

  it('rejects when label is empty', async () => {
    installScript('add-label.sh', '#!/bin/bash\nexit 0\n');
    await expect(addLabel('42', tmpDir, '  ')).rejects.toThrow(/Label is required/);
  });

  it('passes ticket id and label as positional args', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installScript(
      'add-label.sh',
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\nexit 0\n`,
    );
    await addLabel('42', tmpDir, 'spec-ready');
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['42', 'spec-ready']);
  });

  it('rejects with script stderr on failure', async () => {
    installScript('add-label.sh', '#!/bin/bash\necho "label not found" >&2\nexit 1\n');
    await expect(addLabel('42', tmpDir, 'spec-ready')).rejects.toThrow(/label not found/);
  });

  it('resolves on success', async () => {
    installScript('add-label.sh', '#!/bin/bash\nexit 0\n');
    await expect(addLabel('42', tmpDir, 'spec-ready')).resolves.toBeUndefined();
  });
});

describe('removeLabel', () => {
  it('rejects when remove-label.sh is missing', async () => {
    await expect(removeLabel('42', tmpDir, 'needs-spec')).rejects.toThrow(/remove-label\.sh is missing/);
  });

  it('passes ticket id and label as positional args', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installScript(
      'remove-label.sh',
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\nexit 0\n`,
    );
    await removeLabel('42', tmpDir, 'needs-spec');
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['42', 'needs-spec']);
  });

  it('resolves on success', async () => {
    installScript('remove-label.sh', '#!/bin/bash\nexit 0\n');
    await expect(removeLabel('42', tmpDir, 'needs-spec')).resolves.toBeUndefined();
  });

  it('rejects with script stderr on failure', async () => {
    installScript('remove-label.sh', '#!/bin/bash\necho "permission denied" >&2\nexit 1\n');
    await expect(removeLabel('42', tmpDir, 'needs-spec')).rejects.toThrow(/permission denied/);
  });
});

describe('label swap order (Gap B)', () => {
  it('add-label resolves before remove-label is called', async () => {
    const calls: string[] = [];
    const sideChannel = path.join(tmpDir, 'calls');

    installScript('add-label.sh', `#!/bin/bash\necho "add $2" >> "${sideChannel}"\nexit 0\n`);
    installScript('remove-label.sh', `#!/bin/bash\necho "remove $2" >> "${sideChannel}"\nexit 0\n`);

    await addLabel('42', tmpDir, 'spec-ready');
    await removeLabel('42', tmpDir, 'needs-spec');

    const lines = fs.readFileSync(sideChannel, 'utf-8').trim().split('\n');
    expect(lines[0]).toBe('add spec-ready');
    expect(lines[1]).toBe('remove needs-spec');
    void calls;
  });
});
