import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listTickets, listTicketComments, postComment } from '../../../../src/main/control-plane/ticket-comments';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-comments-test-'));
  fs.mkdirSync(path.join(tmpDir, '.sandstorm', 'scripts'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installScript(name: string, body: string): void {
  fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'scripts', name), body, { mode: 0o755 });
}

describe('listTickets', () => {
  it('rejects when list-tickets.sh is missing', async () => {
    await expect(listTickets('needs-spec', tmpDir)).rejects.toThrow(/list-tickets\.sh is missing/);
  });

  it('returns empty array when script outputs nothing', async () => {
    installScript('list-tickets.sh', '#!/bin/bash\nexit 0\n');
    const result = await listTickets('needs-spec', tmpDir);
    expect(result).toEqual([]);
  });

  it('parses TSV output into TicketEntry array', async () => {
    const sideChannel = path.join(tmpDir, 'label');
    installScript(
      'list-tickets.sh',
      `#!/bin/bash\nprintf "%s\\n" "$1" > "${sideChannel}"\nprintf "42\\tFix the bug\\tmonkeyuser\\n123\\tAnother ticket\\tmonkeyuser\\n"\n`,
    );
    const result = await listTickets('needs-spec', tmpDir);
    expect(fs.readFileSync(sideChannel, 'utf-8').trim()).toBe('needs-spec');
    expect(result).toEqual([
      { id: '42', title: 'Fix the bug', author: 'monkeyuser' },
      { id: '123', title: 'Another ticket', author: 'monkeyuser' },
    ]);
  });

  it('filters out rows with empty id', async () => {
    installScript('list-tickets.sh', '#!/bin/bash\nprintf "\\t\\t\\n"\n');
    const result = await listTickets('needs-spec', tmpDir);
    expect(result).toEqual([]);
  });

  it('rejects when script exits non-zero', async () => {
    installScript('list-tickets.sh', '#!/bin/bash\necho "auth error" >&2\nexit 1\n');
    await expect(listTickets('needs-spec', tmpDir)).rejects.toThrow(/auth error/);
  });
});

describe('listTicketComments', () => {
  it('rejects when list-comments.sh is missing', async () => {
    await expect(listTicketComments('42', tmpDir)).rejects.toThrow(/list-comments\.sh is missing/);
  });

  it('returns empty array when script outputs empty array', async () => {
    installScript('list-comments.sh', '#!/bin/bash\necho "[]"\n');
    const result = await listTicketComments('42', tmpDir);
    expect(result).toEqual([]);
  });

  it('parses JSON array of comments', async () => {
    const comments = [
      { author: 'monkeyuser', body: 'This is my answer', createdAt: '2026-05-01T10:00:00Z' },
    ];
    installScript(
      'list-comments.sh',
      `#!/bin/bash\necho '${JSON.stringify(comments)}'\n`,
    );
    const result = await listTicketComments('42', tmpDir);
    expect(result).toEqual(comments);
  });

  it('returns empty array on invalid JSON', async () => {
    installScript('list-comments.sh', '#!/bin/bash\necho "not json"\n');
    const result = await listTicketComments('42', tmpDir);
    expect(result).toEqual([]);
  });

  it('passes ticket id to the script', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installScript(
      'list-comments.sh',
      `#!/bin/bash\necho "$1" > "${sideChannel}"\necho "[]"\n`,
    );
    await listTicketComments('PROJ-123', tmpDir);
    expect(fs.readFileSync(sideChannel, 'utf-8').trim()).toBe('PROJ-123');
  });
});

describe('postComment', () => {
  it('rejects when post-comment.sh is missing', async () => {
    await expect(postComment('42', tmpDir, 'hello')).rejects.toThrow(/post-comment\.sh is missing/);
  });

  it('rejects when ticketId is empty', async () => {
    installScript('post-comment.sh', '#!/bin/bash\nexit 0\n');
    await expect(postComment('  ', tmpDir, 'hello')).rejects.toThrow(/Ticket ID is required/);
  });

  it('rejects when body is empty', async () => {
    installScript('post-comment.sh', '#!/bin/bash\nexit 0\n');
    await expect(postComment('42', tmpDir, '  ')).rejects.toThrow(/body cannot be empty/);
  });

  it('passes ticket id and body as positional args', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installScript(
      'post-comment.sh',
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\nexit 0\n`,
    );
    await postComment('42', tmpDir, 'My comment body');
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['42', 'My comment body']);
  });

  it('rejects with script stderr on failure', async () => {
    installScript('post-comment.sh', '#!/bin/bash\necho "401 Unauthorized" >&2\nexit 1\n');
    await expect(postComment('42', tmpDir, 'body')).rejects.toThrow(/401 Unauthorized/);
  });

  it('resolves on success', async () => {
    installScript('post-comment.sh', '#!/bin/bash\nexit 0\n');
    await expect(postComment('42', tmpDir, 'body')).resolves.toBeUndefined();
  });
});
