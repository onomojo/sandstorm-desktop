import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTicket, updateTicketBody } from '../../src/main/control-plane/ticket-creator';

/**
 * createTicket spawns `gh` directly. We test it by stubbing `gh` via a temp
 * PATH dir that contains a fake binary echoing canned stdout. No vi.mock —
 * matches the no-electron-mocks rule + ipc-tickets style.
 */
describe('createTicket', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-create-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubGh(script: string): string {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const ghPath = path.join(binDir, 'gh');
    fs.writeFileSync(ghPath, script, { mode: 0o755 });
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    return ghPath;
  }

  it('rejects when the project directory does not exist', async () => {
    await expect(
      createTicket({ projectDir: '/nope-dir', title: 't', body: 'b' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects when title is empty', async () => {
    await expect(
      createTicket({ projectDir: tmpDir, title: '   ', body: 'b' }),
    ).rejects.toThrow(/title is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: '' }),
    ).rejects.toThrow(/body is required/);
  });

  it('parses the issue URL and number on success', async () => {
    stubGh('#!/usr/bin/env bash\necho "https://github.com/onomojo/sandstorm-desktop/issues/315"');
    const result = await createTicket({ projectDir: tmpDir, title: 'Title', body: 'Body' });
    expect(result.url).toBe('https://github.com/onomojo/sandstorm-desktop/issues/315');
    expect(result.number).toBe(315);
    expect(result.ticketId).toBe('315');
  });

  it('rejects when gh exits non-zero with stderr', async () => {
    stubGh('#!/usr/bin/env bash\necho "auth required" 1>&2\nexit 1');
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/auth required/);
  });

  it('rejects when gh stdout has no parseable URL', async () => {
    stubGh('#!/usr/bin/env bash\necho "draft only — not opened"');
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/parse issue URL/);
  });

  it('passes the title and body as gh CLI args (workspace = projectDir)', async () => {
    // Capture args by writing them to a side-channel file.
    const sideChannel = path.join(tmpDir, 'gh-args');
    stubGh(
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\n` +
      'echo "https://github.com/o/r/issues/9"\n',
    );
    await createTicket({ projectDir: tmpDir, title: 'My Title', body: 'My Body' });
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['issue', 'create', '--title', 'My Title', '--body', 'My Body']);
  });
});

describe('updateTicketBody (#318)', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-update-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubGh(script: string): string {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const ghPath = path.join(binDir, 'gh');
    fs.writeFileSync(ghPath, script, { mode: 0o755 });
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    return ghPath;
  }

  it('rejects when the project directory does not exist', async () => {
    await expect(
      updateTicketBody({ projectDir: '/nope-dir', ticketId: '42', body: 'b' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects when ticketId is empty', async () => {
    await expect(
      updateTicketBody({ projectDir: tmpDir, ticketId: '   ', body: 'b' }),
    ).rejects.toThrow(/Ticket ID is required/);
  });

  it('strips a leading # from the ticket id', async () => {
    const sideChannel = path.join(tmpDir, 'gh-args');
    stubGh(`#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\nexit 0\n`);
    await updateTicketBody({ projectDir: tmpDir, ticketId: '#310', body: 'updated' });
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['issue', 'edit', '310', '--body-file', '-']);
  });

  it('rejects when body is empty', async () => {
    await expect(
      updateTicketBody({ projectDir: tmpDir, ticketId: '1', body: '   ' }),
    ).rejects.toThrow(/body cannot be empty/);
  });

  it('pipes the body to gh on stdin (no arg-length limits for large tickets)', async () => {
    const sideChannel = path.join(tmpDir, 'gh-stdin');
    stubGh(`#!/usr/bin/env bash\ncat - > "${sideChannel}"\nexit 0\n`);
    const longBody = 'x'.repeat(200_000) + '\nmarker';
    await updateTicketBody({ projectDir: tmpDir, ticketId: '42', body: longBody });
    const piped = fs.readFileSync(sideChannel, 'utf-8');
    expect(piped.endsWith('marker')).toBe(true);
    expect(piped.length).toBe(longBody.length);
  });

  it('rejects when gh exits non-zero', async () => {
    stubGh('#!/usr/bin/env bash\necho "bad credentials" 1>&2\nexit 1');
    await expect(
      updateTicketBody({ projectDir: tmpDir, ticketId: '1', body: 'b' }),
    ).rejects.toThrow(/bad credentials/);
  });

  it('resolves on success without returning a value', async () => {
    stubGh('#!/usr/bin/env bash\nexit 0');
    await expect(
      updateTicketBody({ projectDir: tmpDir, ticketId: '1', body: 'b' }),
    ).resolves.toBeUndefined();
  });
});
